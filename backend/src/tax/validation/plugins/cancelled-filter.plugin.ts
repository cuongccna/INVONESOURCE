import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin, PluginConfig } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

/**
 * CancelledFilter — loại hóa đơn đã bị hủy trên GDT.
 * Priority 10 — chạy đầu tiên, áp dụng cho cả input & output.
 *
 * Mapping: spec field gdt_status='cancelled' → DB column status='cancelled'
 */
export class CancelledFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'cancelled_filter';
  readonly displayName = 'Lọc hóa đơn bị hủy';
  readonly priority = 10;
  readonly appliesTo = 'both' as const;
  readonly legalBasis = 'Đ.27 NĐ123/2020 — hóa đơn điện tử bị hủy không có hiệu lực pháp lý';
  readonly canDisable = false;

  async validateBatch(
    invoices: InvoiceRow[],
    _context: InvoiceValidationContext,
    _db: Pool,
    _pluginConfig?: import('../plugin.interface').PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>> {
    const results = new Map<string, InvoiceValidationResult>();
    const now = new Date();

    for (const inv of invoices) {
      if (inv.status === 'cancelled') {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.CANCELLED_BY_GDT],
          reason_detail: 'Hóa đơn đã bị hủy trên hệ thống GDT',
          plugin_name: this.name,
          validated_at: now,
        });
      }
    }

    return results;
  }
}
