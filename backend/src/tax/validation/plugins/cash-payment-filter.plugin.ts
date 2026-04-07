import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin, PluginConfig } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

const EFFECTIVE_DATE_DEFAULT = new Date('2025-07-01T00:00:00.000Z');
const THRESHOLD_DEFAULT = 5_000_000;

/**
 * CashPaymentFilter — loại hóa đơn đầu vào thanh toán tiền mặt >= 5 triệu.
 * Priority 210 — chỉ áp dụng với input. Phụ thuộc vào user_payment_flags.
 *
 * Hiệu lực từ 01/07/2025 (NĐ181/2025, Đ.26).
 *
 * - EXCLUDED: user đã xác nhận là tiền mặt VÀ tổng tiền >= threshold
 * - WARNING:  user CHƯA xác nhận phương thức thanh toán
 */
export class CashPaymentFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'cash_payment_filter';
  readonly displayName = 'Kiểm tra thanh toán tiền mặt ≥5 triệu';
  readonly priority = 210;
  readonly appliesTo = 'input' as const;
  readonly legalBasis = 'Đ.26 NĐ181/2025 — hiệu lực 01/07/2025';
  readonly canDisable = true;

  async validateBatch(
    invoices: InvoiceRow[],
    context: InvoiceValidationContext,
    _db: Pool,
    pluginConfig?: PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>> {
    const results = new Map<string, InvoiceValidationResult>();
    const now = new Date();

    const cfg = pluginConfig?.config ?? {};
    const effectiveDate = cfg['effective_date']
      ? new Date(cfg['effective_date'] as string)
      : EFFECTIVE_DATE_DEFAULT;
    const threshold = typeof cfg['threshold'] === 'number'
      ? cfg['threshold']
      : THRESHOLD_DEFAULT;

    const paymentFlags = context.user_payment_flags ?? {};

    for (const inv of invoices) {
      // Only applies to invoices dated on/after the effective date
      const invDate = inv.invoice_date instanceof Date
        ? inv.invoice_date
        : new Date(inv.invoice_date);
      if (invDate < effectiveDate) continue;

      const totalAmount = Number(inv.total_amount);
      if (totalAmount < threshold) continue;

      const flagValue = paymentFlags[inv.id];

      if (flagValue === true) {
        // User confirmed: cash payment over threshold → hard exclude
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.CASH_PAYMENT_OVER_5M],
          reason_detail:
            `Thanh toán tiền mặt từ 5 triệu trở lên — không được khấu trừ theo Đ.26 NĐ181/2025 (hiệu lực 01/07/2025)`,
          plugin_name: this.name,
          validated_at: now,
        });
      } else if (flagValue === undefined) {
        // User has not confirmed — issue a warning
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'warning',
          reason_codes: [ExclusionReasonCode.CASH_PAYMENT_OVER_5M],
          reason_detail:
            `Hóa đơn có giá trị ≥5 triệu — vui lòng xác nhận phương thức thanh toán (tiền mặt sẽ không được khấu trừ theo Đ.26 NĐ181/2025)`,
          plugin_name: this.name,
          validated_at: now,
        });
      }
      // flagValue === false → user confirmed non-cash → pass, no entry in results
    }

    return results;
  }
}
