/**
 * Standalone test runner for GdtDirectApiService.
 * Runs completely outside BullMQ/DB — useful for smoke-testing credentials and proxy.
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/test-direct-api.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { GdtDirectApiService } from './gdt-direct-api.service';
import { logger } from './logger';

// ── Config (from ENVIRONMENT or hard-coded for this test run) ─────────────────
const USERNAME  = process.env['TEST_GDT_USER'] ?? '0319303270';
const PASSWORD  = process.env['TEST_GDT_PASS'] ?? '@nSt@r1988';
// Pick first proxy from PROXY_LIST
const PROXY_URL = (process.env['PROXY_LIST'] ?? '').split(',')[0]?.trim() || null;
// Last 30 days
const TO_DATE   = new Date();
const FROM_DATE = new Date(TO_DATE.getTime() - 30 * 24 * 60 * 60 * 1000);

const OUT_DIR = path.resolve(__dirname, '..', 'test-output');

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  logger.info('=== GDT Direct API Test Run ===');
  logger.info(`User:  ${USERNAME}`);
  logger.info(`Proxy: ${PROXY_URL ?? '(none)'}`);
  logger.info(`Range: ${FROM_DATE.toISOString().slice(0, 10)} → ${TO_DATE.toISOString().slice(0, 10)}`);

  const svc = new GdtDirectApiService(PROXY_URL);

  // ── 1. Login ───────────────────────────────────────────────────────────────
  logger.info('[Test] Step 1: Login...');
  await svc.login(USERNAME, PASSWORD);
  logger.info('[Test] ✓ Login OK');

  // ── 2. Fetch output invoice list (JSON) ────────────────────────────────────
  logger.info('[Test] Step 2: Fetch output invoices (JSON list)...');
  const outputInvoices = await svc.fetchOutputInvoices(FROM_DATE, TO_DATE);
  logger.info(`[Test] ✓ Output invoices: ${outputInvoices.length} records`);
  const outJsonPath = path.join(OUT_DIR, 'output-invoices.json');
  fs.writeFileSync(outJsonPath, JSON.stringify(outputInvoices, null, 2), 'utf8');
  logger.info(`[Test] Saved → ${outJsonPath}`);

  // ── 3. Fetch input invoice list (JSON) ─────────────────────────────────────
  logger.info('[Test] Step 3: Fetch input invoices (JSON list)...');
  const inputInvoices = await svc.fetchInputInvoices(FROM_DATE, TO_DATE);
  logger.info(`[Test] ✓ Input invoices: ${inputInvoices.length} records`);
  const inJsonPath = path.join(OUT_DIR, 'input-invoices.json');
  fs.writeFileSync(inJsonPath, JSON.stringify(inputInvoices, null, 2), 'utf8');
  logger.info(`[Test] Saved → ${inJsonPath}`);

  // ── 4. Export output XLSX ──────────────────────────────────────────────────
  logger.info('[Test] Step 4: Export output Excel (XLSX)...');
  try {
    const outXlsx = await svc.exportOutputExcel(FROM_DATE, TO_DATE);
    const outXlsxPath = path.join(OUT_DIR, 'output-invoices.xlsx');
    fs.writeFileSync(outXlsxPath, outXlsx);
    logger.info(`[Test] ✓ Output XLSX saved → ${outXlsxPath}  (${outXlsx.length} bytes)`);
  } catch (err) {
    logger.warn('[Test] Output XLSX export failed (non-fatal)', { err: (err as Error).message });
  }

  // ── 5. Export input XLSX ───────────────────────────────────────────────────
  logger.info('[Test] Step 5: Export input Excel (XLSX)...');
  try {
    const inXlsx = await svc.exportInputExcel(FROM_DATE, TO_DATE);
    const inXlsxPath = path.join(OUT_DIR, 'input-invoices.xlsx');
    fs.writeFileSync(inXlsxPath, inXlsx);
    logger.info(`[Test] ✓ Input XLSX saved → ${inXlsxPath}  (${inXlsx.length} bytes)`);
  } catch (err) {
    logger.warn('[Test] Input XLSX export failed (non-fatal)', { err: (err as Error).message });
  }

  // ── 6. Export one XML sample (if any output invoices found) ───────────────
  if (outputInvoices.length > 0) {
    const sample = outputInvoices[0]!;
    if (sample.seller_tax_code && sample.serial_number && sample.invoice_number) {
      logger.info('[Test] Step 6: Export XML for first output invoice...', {
        nbmst:  sample.seller_tax_code,
        khhdon: sample.serial_number,
        shdon:  sample.invoice_number,
      });
      try {
        const xml = await svc.exportInvoiceXml({
          nbmst:  sample.seller_tax_code,
          khhdon: sample.serial_number,
          shdon:  sample.invoice_number,
        });
        const xmlPath = path.join(OUT_DIR, `invoice-${sample.invoice_number}.xml`);
        fs.writeFileSync(xmlPath, xml);
        logger.info(`[Test] ✓ XML saved → ${xmlPath}  (${xml.length} bytes)`);
      } catch (err) {
        logger.warn('[Test] XML export failed (non-fatal)', { err: (err as Error).message });
      }
    }
  }

  logger.info('=== Test Run Complete ===');
  logger.info(`All files saved to: ${OUT_DIR}`);
}

main().catch(err => {
  logger.error('[Test] FATAL', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
