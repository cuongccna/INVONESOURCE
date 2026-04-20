/**
 * Backfill XML line items for all invoices that are missing line items.
 *
 * PROXY REQUIREMENT:
 *   GDT will block/flag accounts accessed from the same datacenter IP repeatedly.
 *   Set BACKFILL_PROXY_URL (full URL, e.g. http://user:pass@host:port) in bot/.env
 *   to route traffic through a residential proxy.
 *   Fallback: PROXY_LIST (comma-separated) — first entry is used.
 *   Emergency: ALLOW_DIRECT_CONNECTION=true bypasses the guard (DEV ONLY).
 *
 * Prerequisites:
 *   1. Bot must have already synced invoices (populate the invoices table)
 *   2. Run from the bot/ directory: npx ts-node -r dotenv/config src/backfill-xml.ts
 *   3. GDT credentials must be correct in DB for the target company
 *
 * The script:
 *   - Queries all invoices missing line items for the company
 *   - Logs in to GDT once and fetches XML for each invoice (with delays)
 *   - Skips invoices where GDT returns 500 (ttxly==6/8 = no XML stored)
 *   - Inserts parsed line items into invoice_line_items table
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { GdtDirectApiService } from './gdt-direct-api.service';
import { GdtXmlParser } from './parsers/GdtXmlParser';
import { decryptCredentials } from './encryption.service';
import { logger } from './logger';

const pool = new Pool({
  connectionString: process.env['WORKER_DB_URL'] ?? process.env['DATABASE_URL'],
  max: 3,
});

const COMPANY_ID  = process.env['BACKFILL_COMPANY_ID'] ?? 'bbe1f5b0-f166-4a6c-acc1-110f578ec6b9';
const DELAY_MS    = 3_000; // 3s between XML fetches
const BATCH_LIMIT = 200;   // max invoices to process per run

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  logger.info('[Backfill] Starting XML backfill', { companyId: COMPANY_ID });

  // 1. Load credentials
  const cfgRes = await pool.query<{ encrypted_credentials: string; tax_code: string }>(
    `SELECT encrypted_credentials, tax_code FROM gdt_bot_configs WHERE company_id=$1 AND is_active=true`,
    [COMPANY_ID],
  );
  if (cfgRes.rows.length === 0) {
    logger.error('[Backfill] No active bot config found for company');
    process.exit(1);
  }
  const creds = decryptCredentials(cfgRes.rows[0]!.encrypted_credentials);
  logger.info('[Backfill] Credentials loaded', { taxCode: cfgRes.rows[0]!.tax_code });

  // 2. Find invoices missing line items
  // Only attempt OUTPUT invoices and INPUT invoices. In practice ttxly==5 inputs have XML.
  // We can't filter by ttxly (not stored in DB), so we try all and let export-xml return 500 for non-xml ones.
  const invoiceRes = await pool.query<{
    id: string;
    invoice_number: string;
    serial_number: string;
    seller_tax_code: string;
    direction: string;
  }>(
    `SELECT i.id, i.invoice_number, i.serial_number, i.seller_tax_code, i.direction
     FROM invoices i
     WHERE i.company_id = $1
       AND i.deleted_at IS NULL
       AND i.status != 'cancelled'
       AND i.invoice_number IS NOT NULL
       AND i.serial_number IS NOT NULL
       AND i.seller_tax_code IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM invoice_line_items ili WHERE ili.invoice_id = i.id
       )
     ORDER BY i.invoice_date DESC
     LIMIT $2`,
    [COMPANY_ID, BATCH_LIMIT],
  );
  logger.info(`[Backfill] Found ${invoiceRes.rows.length} invoices without line items`);

  if (invoiceRes.rows.length === 0) {
    logger.info('[Backfill] Nothing to do');
    pool.end();
    return;
  }

  // 3. Resolve proxy URL — NEVER run without a proxy in production.
  //    Priority: BACKFILL_PROXY_URL > first entry of PROXY_LIST > abort
  const backfillProxy  = process.env['BACKFILL_PROXY_URL']
    ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).find(Boolean)
    ?? null;
  const backfillSocks5 = process.env['BACKFILL_SOCKS5_URL'] ?? null;

  const allowDirect = process.env['ALLOW_DIRECT_CONNECTION'] === 'true';
  if (!backfillProxy) {
    if (!allowDirect) {
      logger.error(
        '[Backfill] ABORTED — no proxy configured.\n' +
        'Set BACKFILL_PROXY_URL=http://user:pass@host:port in bot/.env.\n' +
        'Running without proxy risks GDT blocking the account IP.\n' +
        'Set ALLOW_DIRECT_CONNECTION=true to bypass (DEV ONLY — NEVER in production).',
      );
      process.exit(1);
    }
    logger.warn('[Backfill] WARNING: running with DIRECT connection — no proxy set. DEV ONLY.');
  } else {
    logger.info('[Backfill] Using proxy', { proxy: backfillProxy.replace(/:([^@]+)@/, ':***@') });
  }

  // 4. Login to GDT via proxy
  const gdtApi = new GdtDirectApiService(backfillProxy, backfillSocks5);
  await gdtApi.login(creds.username, creds.password);
  logger.info('[Backfill] Logged in to GDT');

  const xmlParser = new GdtXmlParser();
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;

  // 5. Fetch XML for each invoice
  for (const inv of invoiceRes.rows) {
    await sleep(DELAY_MS);
    try {
      const xmlBuf = await gdtApi.exportInvoiceXml({
        nbmst:  inv.seller_tax_code,
        khhdon: inv.serial_number,
        shdon:  inv.invoice_number,
        khmshdon: 1,
      });
      fetched++;

      // Save raw XML to the invoices table so download-xml works for gdt_bot invoices
      const rawXmlStr = xmlBuf.toString('utf8');
      await pool.query(
        `UPDATE invoices SET raw_xml = $1, updated_at = NOW() WHERE id = $2`,
        [rawXmlStr, inv.id],
      );
      logger.info('[Backfill] raw_xml saved', { invoiceId: inv.id, bytes: xmlBuf.byteLength });

      const lineItems = xmlParser.parseLineItems(xmlBuf);
      if (lineItems.length === 0) {
        logger.warn('[Backfill] XML fetched but 0 line items parsed', { invoiceId: inv.id });
        skipped++;
        continue;
      }

      // Insert line items
      await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [inv.id]);
      for (const item of lineItems) {
        await pool.query(
          `INSERT INTO invoice_line_items
           (id, invoice_id, company_id, line_number, item_code, item_name,
            unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [uuidv4(), inv.id, COMPANY_ID,
           item.line_number, item.item_code, item.item_name,
           item.unit, item.quantity, item.unit_price,
           item.subtotal, item.vat_rate, item.vat_amount, item.total],
        );
      }
      inserted += lineItems.length;
      logger.info('[Backfill] Line items inserted', { invoiceId: inv.id, count: lineItems.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('500')) {
        // Expected for ttxly==6/8 invoices — they don't have XML on GDT
        logger.info('[Backfill] No XML (HTTP 500 — likely ttxly==6/8)', { invoiceId: inv.id });
      } else {
        logger.warn('[Backfill] XML fetch error', { invoiceId: inv.id, msg });
      }
      skipped++;
    }
  }

  logger.info('[Backfill] Done', { fetched, inserted, skipped });
  pool.end();
}

main().catch(err => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  logger.error('[Backfill] Fatal error', { msg });
  pool.end();
  process.exit(1);
});
