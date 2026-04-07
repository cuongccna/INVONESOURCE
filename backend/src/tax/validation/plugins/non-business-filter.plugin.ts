import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin, PluginConfig } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

const DEFAULT_KEYWORDS = [
  'cá nhân', 'sinh hoạt', 'gia đình', 'giải trí', 'du lịch', 'điện thoại cá nhân',
];

/**
 * NonBusinessFilter — loại hóa đơn không phục vụ hoạt động SXKD.
 * Priority 220 — chỉ áp dụng với input. Phụ thuộc user_non_business_flags.
 *
 * - EXCLUDED: user đã xác nhận không phục vụ kinh doanh
 * - WARNING:  seller_name chứa từ khoá gợi ý sử dụng cá nhân (cấu hình từ DB)
 */
export class NonBusinessFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'non_business_filter';
  readonly displayName = 'Kiểm tra mục đích sử dụng kinh doanh';
  readonly priority = 220;
  readonly appliesTo = 'input' as const;
  readonly legalBasis = 'Đ.14 TT219/2013 — đầu vào phục vụ SXKD mới được khấu trừ';
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
    const keywords: string[] = Array.isArray(cfg['keywords'])
      ? (cfg['keywords'] as string[])
      : DEFAULT_KEYWORDS;

    const nonBusinessFlags = context.user_non_business_flags ?? {};

    for (const inv of invoices) {
      const flagValue = nonBusinessFlags[inv.id];

      if (flagValue === true) {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.NOT_FOR_TAXABLE_USE],
          reason_detail: 'Hóa đơn không phục vụ hoạt động sản xuất kinh doanh — không được khấu trừ',
          plugin_name: this.name,
          validated_at: now,
        });
        continue;
      }

      // Warning: seller_name contains suspicious personal-use keywords
      if (flagValue !== false) {
        const sellerNameLower = (inv.seller_name ?? '').toLowerCase();
        const matchedKeyword = keywords.find(kw => sellerNameLower.includes(kw.toLowerCase()));
        if (matchedKeyword) {
          results.set(inv.id, {
            invoice_id: inv.id,
            status: 'warning',
            reason_codes: [ExclusionReasonCode.NOT_FOR_TAXABLE_USE],
            reason_detail: `Hóa đơn có thể không phục vụ SXKD (phát hiện từ khóa: "${matchedKeyword}") — vui lòng xác nhận`,
            plugin_name: this.name,
            validated_at: now,
          });
        }
      }
    }

    return results;
  }
}
