import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

/**
 * CqtSignatureFilter — kiểm tra mã xác thực CQT (MCCQT).
 * Priority 30 — áp dụng cho cả input & output.
 *
 * Chỉ áp dụng với hóa đơn CÓ MÃ (serial_has_cqt = true).
 * Hóa đơn không có mã CQT (khong_ma) được bỏ qua.
 */
export class CqtSignatureFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'cqt_signature_filter';
  readonly displayName = 'Kiểm tra mã xác thực CQT';
  readonly priority = 30;
  readonly appliesTo = 'both' as const;
  readonly legalBasis = 'Đ.17 NĐ123/2020 — hóa đơn điện tử có mã bắt buộc có MCCQT';
  readonly canDisable = true;

  async validateBatch(
    invoices: InvoiceRow[],
    _context: InvoiceValidationContext,
    _db: Pool,
    _pluginConfig?: import('../plugin.interface').PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>> {
    const results = new Map<string, InvoiceValidationResult>();
    const now = new Date();

    for (const inv of invoices) {
      // Only validate invoices that require CQT code (serial_has_cqt = true).
      // If serial_has_cqt is null or false, this is a "khong_ma" invoice — skip.
      if (inv.serial_has_cqt !== true) continue;

      // If GDT has already validated this invoice (gdt_validated=true), the CQT code
      // was verified by GDT even if we haven't parsed mccqt into the DB yet.
      // This handles all existing data before the mccqt column was populated.
      if (inv.gdt_validated === true) continue;

      const mccqtMissing = inv.mccqt === null || inv.mccqt.trim() === '';
      if (mccqtMissing) {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.INVALID_CQT_SIGNATURE],
          reason_detail: 'Hóa đơn thiếu mã xác thực của Cơ quan Thuế (MCCQT)',
          plugin_name: this.name,
          validated_at: now,
        });
      }
    }

    return results;
  }
}
