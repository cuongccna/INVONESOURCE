/**
 * BOT-DETAIL-04 — Backfill raw_detail for existing invoices
 *
 * Re-fetches GDT detail for invoices that have line items but no raw_detail stored.
 * Runs as a standalone PM2 script, NOT via BullMQ.
 *
 * Usage:
 *   node dist/jobs/backfill-raw-detail.js
 *
 * Required env vars: DATABASE_URL, REDIS_URL, TMPROXY_API_KEY
 *
 * Safety guarantees:
 *   - Only processes invoices WHERE raw_detail IS NULL AND has_line_items = true
 *   - Processes in batches of 20 with 8–15s random jitter between batches
 *   - Skips gracefully on GDT 4xx/5xx errors (logs warning, continues)
 *   - Idempotent: WHERE raw_detail IS NULL in final UPDATE prevents double-write
 *   - Hard cap: max 500 invoices per run to avoid long-running processes
 */
import { pool } from '../db';
import { GdtDirectApiService } from '../gdt-direct-api.service';
import { decryptCredentials } from '../encryption.service';
import { proxyManager } from '../proxy-manager';
import { logger } from '../logger';

const BATCH_SIZE    = 20;
const MAX_INVOICES  = 500;
const JITTER_MIN_MS = 8_000;
const JITTER_MAX_MS = 15_000;

function jitter(): Promise<void> {
  const ms = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  return new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<void> {
  logger.info('[Backfill] Starting raw_detail backfill');

  const { rows: invoices } = await pool.query<{
    id:              string;
    company_id:      string;
    invoice_number:  string;
    serial_number:   string;
    seller_tax_code: string;
    is_sco:          boolean;
  }>(
    `SELECT i.id, i.company_id, i.invoice_number, i.serial_number, i.seller_tax_code, i.is_sco
     FROM invoices i
     WHERE i.raw_detail IS NULL
       AND i.has_line_items = true
       AND i.status NOT IN ('cancelled')
     ORDER BY i.created_at DESC
     LIMIT $1`,
    [MAX_INVOICES],
  );

  logger.info('[Backfill] Invoices to process', { count: invoices.length });
  if (invoices.length === 0) {
    logger.info('[Backfill] Nothing to backfill — done');
    process.exit(0);
  }

  // Group by company_id to reuse GDT session per company
  const byCompany = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    if (!byCompany.has(inv.company_id)) byCompany.set(inv.company_id, []);
    byCompany.get(inv.company_id)!.push(inv);
  }

  for (const [companyId, companyInvoices] of byCompany) {
    // Load credentials
    const cfgRes = await pool.query<{ encrypted_credentials: string }>(
      `SELECT encrypted_credentials FROM gdt_bot_configs WHERE company_id = $1 AND is_active = true`,
      [companyId],
    );
    if (!cfgRes.rows.length) {
      logger.warn('[Backfill] No active GDT config, skipping company', { companyId });
      continue;
    }

    let creds: { username: string; password: string };
    try {
      creds = decryptCredentials(cfgRes.rows[0]!.encrypted_credentials);
    } catch (credErr) {
      logger.warn('[Backfill] Credential decrypt failed, skipping company', {
        companyId,
        err: credErr instanceof Error ? credErr.message : String(credErr),
      });
      continue;
    }

    const proxyUrl = await proxyManager.nextForAutoSync('backfill');
    const gdtApi   = new GdtDirectApiService(proxyUrl, null, undefined, companyId, null, null);

    try {
      await gdtApi.login(creds.username, creds.password, false);
    } catch (loginErr) {
      logger.warn('[Backfill] Login failed, skipping company', {
        companyId,
        err: loginErr instanceof Error ? loginErr.message : String(loginErr),
      });
      continue;
    }

    // Process in batches
    for (let i = 0; i < companyInvoices.length; i += BATCH_SIZE) {
      const batch = companyInvoices.slice(i, i + BATCH_SIZE);

      for (const inv of batch) {
        try {
          const detail = await gdtApi.fetchInvoiceDetail({
            nbmst:  inv.seller_tax_code,
            khhdon: inv.serial_number,
            shdon:  inv.invoice_number,
            isSco:  inv.is_sco,
          });
          const d = detail as Record<string, unknown>;

          // Only write raw_detail + header fields — do NOT touch line items
          // WHERE raw_detail IS NULL ensures idempotency on re-run
          await pool.query(
            `UPDATE invoices SET
               raw_detail          = $1::jsonb,
               raw_detail_at       = NOW(),
               gdt_invoice_id      = COALESCE(gdt_invoice_id,      $2),
               gdt_mhdon           = COALESCE(gdt_mhdon,           $3),
               gdt_mtdtchieu       = COALESCE(gdt_mtdtchieu,       $4),
               seller_address      = COALESCE(seller_address,       $5),
               seller_bank_account = COALESCE(seller_bank_account,  $6),
               seller_bank_name    = COALESCE(seller_bank_name,     $7),
               buyer_address       = COALESCE(buyer_address,        $8),
               gdt_qrcode          = COALESCE(gdt_qrcode,           $9),
               gdt_nbcks           = COALESCE(gdt_nbcks,            $10),
               gdt_cqtcks          = COALESCE(gdt_cqtcks,           $11)
             WHERE id = $12 AND raw_detail IS NULL`,
            [
              JSON.stringify(detail),
              d['id']        as string ?? null,
              d['mhdon']     as string ?? null,
              d['mtdtchieu'] as string ?? null,
              d['nbdchi']    as string ?? null,
              d['nbstkhoan'] as string ?? null,
              d['nbtnhang']  as string ?? null,
              d['nmdchi']    as string ?? null,
              d['qrcode']    as string ?? null,
              typeof d['nbcks']  === 'object' ? JSON.stringify(d['nbcks'])  : d['nbcks']  as string ?? null,
              typeof d['cqtcks'] === 'object' ? JSON.stringify(d['cqtcks']) : d['cqtcks'] as string ?? null,
              inv.id,
            ],
          );
          logger.info('[Backfill] Saved raw_detail', { invoiceId: inv.id });
        } catch (detailErr) {
          logger.warn('[Backfill] Detail fetch failed, skipping invoice', {
            invoiceId: inv.id,
            err: detailErr instanceof Error ? detailErr.message : String(detailErr),
          });
        }
      }

      // Jitter between batches (not after last batch)
      if (i + BATCH_SIZE < companyInvoices.length) await jitter();
    }
  }

  logger.info('[Backfill] raw_detail backfill complete');
  process.exit(0);
}

main().catch(err => {
  logger.error('[Backfill] Fatal error', { err });
  process.exit(1);
});
