import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

/**
 * ReplacedFilter — loại hóa đơn gốc đã bị thay thế.
 * Priority 20 — áp dụng cho cả input & output.
 *
 * Logic: Nếu có hóa đơn KHÁC trong DB với:
 *   tc_hdon = 1 (là hóa đơn thay thế)
 *   AND khhd_cl_quan = invoice.serial_number (ký hiệu HĐ bị thay)
 *   AND so_hd_cl_quan = invoice.invoice_number (số HĐ bị thay)
 *   AND seller_tax_code = invoice.seller_tax_code (cùng MST NCC)
 * → Thì invoice hiện tại là bản GỐC đã bị thay → LOẠI.
 *
 * Hóa đơn thay thế (tc_hdon=1) là HỢP LỆ — chỉ loại bản gốc.
 *
 * Dùng batch query để tránh N+1.
 */
export class ReplacedFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'replaced_filter';
  readonly displayName = 'Lọc hóa đơn đã bị thay thế';
  readonly priority = 20;
  readonly appliesTo = 'both' as const;
  readonly legalBasis = 'Đ.19 NĐ123/2020 — hóa đơn điều chỉnh/thay thế';
  readonly canDisable = true;

  async validateBatch(
    invoices: InvoiceRow[],
    _context: InvoiceValidationContext,
    db: Pool,
    _pluginConfig?: import('../plugin.interface').PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>> {
    const results = new Map<string, InvoiceValidationResult>();

    if (invoices.length === 0) return results;

    // Build lookup keys for batch query:
    // For each candidate invoice, we need to find if a replacement invoice exists.
    // We query once with all (serial_number, invoice_number, seller_tax_code) combos.
    const candidates = invoices.map(inv => ({
      id: inv.id,
      khhd: inv.serial_number,
      so_hd: inv.invoice_number,
      mst_nban: inv.seller_tax_code,
    }));

    // Single batch query: find any invoice that is a replacement referencing our candidates.
    // Using unnest for efficient multi-value IN check.
    const { rows: replacements } = await db.query<{
      khhd_cl_quan: string;
      so_hd_cl_quan: string;
      seller_tax_code: string;
      invoice_number: string;
    }>(
      `SELECT DISTINCT khhd_cl_quan, so_hd_cl_quan, seller_tax_code, invoice_number
       FROM invoices
       WHERE tc_hdon = 1
         AND deleted_at IS NULL
         AND (khhd_cl_quan, so_hd_cl_quan, seller_tax_code) IN (
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         )`,
      [
        candidates.map(c => c.khhd),
        candidates.map(c => c.so_hd),
        candidates.map(c => c.mst_nban),
      ]
    );

    if (replacements.length === 0) return results;

    // Build a lookup set for O(1) checks
    type ReplacementKey = string;
    const replacedSet = new Set<ReplacementKey>();
    for (const r of replacements) {
      replacedSet.add(`${r.khhd_cl_quan}||${r.so_hd_cl_quan}||${r.seller_tax_code}`);
    }

    // Map invoice_number of replacement for better user messaging
    const replacementNumberMap = new Map<string, string>();
    for (const r of replacements) {
      const key = `${r.khhd_cl_quan}||${r.so_hd_cl_quan}||${r.seller_tax_code}`;
      replacementNumberMap.set(key, r.invoice_number);
    }

    const now = new Date();
    for (const inv of invoices) {
      // Fallback A: GDT already flagged this invoice as replaced/adjusted via status field
      if (inv.status === 'replaced' || inv.status === 'adjusted') {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.REPLACED_BY_NEWER],
          reason_detail: `Hóa đơn có trạng thái "${inv.status}" — đã bị thay thế hoặc điều chỉnh`,
          plugin_name: this.name,
          validated_at: now,
        });
        continue;
      }

      // Fallback B: another invoice in the batch references this one as the original
      const key = `${inv.serial_number}||${inv.invoice_number}||${inv.seller_tax_code}`;
      if (replacedSet.has(key)) {
        const replacingSoHd = replacementNumberMap.get(key) ?? '(không rõ)';
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.REPLACED_BY_NEWER],
          reason_detail: `Hóa đơn gốc đã bị thay thế bởi hóa đơn số ${replacingSoHd}`,
          plugin_name: this.name,
          validated_at: now,
        });
      }
    }

    return results;
  }
}
