/**
 * Backfill bản gốc PDF của nhà cung cấp cho hoá đơn đã có sẵn trong hệ thống.
 *
 * Detail worker chỉ lấy PDF nhà cung cấp cho hoá đơn MỚI đi qua hàng đợi. Script này
 * quét ngược các hoá đơn cũ đã có mã tra cứu và có plugin đang bật, rồi tải về.
 *
 * Chạy:  node dist/backfill-provider-pdf.js [số-hoá-đơn-tối-đa] [--company=<uuid>]
 *
 * An toàn: dùng chung runner với worker nên thừa hưởng đủ công tắc tổng, ngắt mạch,
 * giãn nhịp và timeout. Không sửa gì ngoài cột provider_pdf_* của chính hoá đơn đó.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';
import { pool } from './db';
import { cfg } from './config/ConfigStore';
import { logger } from './logger';
import { storageRoot } from './invoice-document.service';
import { fetchPdfFromPublicPortal } from './providers/lookup/runner';

interface Row {
  id: string; company_id: string;
  msttcgp: string | null; seller_tax_code: string | null;
  provider_lookup_code: string | null; provider_lookup_url: string | null;
  serial_number: string | null; invoice_number: string | null;
  nha_cc: string;
}

async function main(): Promise<void> {
  const limit     = Number(process.argv[2] ?? 50) || 50;
  const companyArg = process.argv.find(a => a.startsWith('--company='))?.split('=')[1] ?? null;

  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379');
  await cfg.init(redis, pool);

  if (!cfg.boolean('provider_lookup.enabled', true)) {
    console.log('Công tắc provider_lookup.enabled đang tắt — không chạy.');
    await redis.quit(); await pool.end();
    return;
  }

  // Chỉ lấy hoá đơn thuộc nhà cung cấp CÓ plugin đang bật, và chưa có file.
  const { rows } = await pool.query<Row>(
    `SELECT i.id, i.company_id, i.provider_solution_tax_code AS msttcgp,
            i.seller_tax_code, i.provider_lookup_code, i.provider_lookup_url,
            i.serial_number, i.invoice_number,
            COALESCE(p.short_name, p.name) AS nha_cc
       FROM invoices i
       JOIN einvoice_providers p ON p.tax_code = i.provider_solution_tax_code
      WHERE i.deleted_at IS NULL
        AND i.provider_pdf_path IS NULL
        AND i.provider_lookup_code IS NOT NULL
        AND p.lookup_adapter IS NOT NULL
        AND p.lookup_enabled = true
        ${companyArg ? 'AND i.company_id = $2' : ''}
      ORDER BY i.invoice_date DESC
      LIMIT $1`,
    companyArg ? [limit, companyArg] : [limit],
  );

  console.log(`Có ${rows.length} hoá đơn cần lấy bản gốc nhà cung cấp.`);
  let ok = 0, fail = 0;

  for (const r of rows) {
    const out = await fetchPdfFromPublicPortal({
      invoiceId:       r.id,
      companyId:       r.company_id,
      providerTaxCode: r.msttcgp,
      sellerTaxCode:   r.seller_tax_code,
      lookupCode:      r.provider_lookup_code,
      lookupUrl:       r.provider_lookup_url,
      serial:          r.serial_number   ?? '',
      invoiceNumber:   r.invoice_number  ?? '',
    });

    if (!out.pdf) {
      fail++;
      await pool.query(
        `UPDATE invoices SET provider_pdf_status = 'failed', provider_pdf_error = $2
          WHERE id = $1 AND provider_pdf_status <> 'available'`,
        [r.id, (out.error ?? '').slice(0, 300)],
      ).catch(() => undefined);
      console.log(`  ✗ ${r.serial_number}-${r.invoice_number} (${r.nha_cc}): ${out.error}`);
      continue;
    }

    const relDir = path.join(r.company_id, r.id);
    const absDir = path.join(storageRoot(), relDir);
    fs.mkdirSync(absDir, { recursive: true });
    const rel = path.join(relDir, 'provider.pdf');
    fs.writeFileSync(path.join(storageRoot(), rel), out.pdf);

    await pool.query(
      `UPDATE invoices
          SET provider_pdf_path   = $2,
              provider_pdf_size   = $3,
              provider_pdf_status = 'available',
              provider_pdf_source = $4,
              provider_pdf_at     = NOW(),
              provider_pdf_error  = NULL
        WHERE id = $1`,
      [r.id, rel.split(path.sep).join('/'), out.pdf.byteLength, out.source],
    );
    ok++;
    console.log(`  ✓ ${r.serial_number}-${r.invoice_number} (${r.nha_cc}): ${out.pdf.byteLength} byte`);
  }

  console.log(`\nXong: ${ok} thành công, ${fail} thất bại.`);
  logger.info('[BackfillProviderPdf] Hoàn tất', { ok, fail, limit });
  await redis.quit();
  await pool.end();
}

main().catch(err => {
  console.error('Lỗi:', err instanceof Error ? err.message : err);
  process.exit(1);
});
