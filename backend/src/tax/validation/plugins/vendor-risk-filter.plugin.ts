import type { Pool } from 'pg';
import type { IInvoiceValidationPlugin, PluginConfig } from '../plugin.interface';
import type { InvoiceRow, InvoiceValidationContext, InvoiceValidationResult } from '../types';
import { ExclusionReasonCode } from '../types';

const DEFAULT_WARN_THRESHOLD = 70;

interface VendorRiskRow {
  seller_tax_code: string;
  enforcement_status: string;
  risk_score: number;
}

/**
 * VendorRiskFilter — kiểm tra NCC rủi ro / cưỡng chế hóa đơn.
 * Priority 230 — chỉ áp dụng với input.
 *
 * - EXCLUDED: enforcement_status = 'active' → VENDOR_ENFORCEMENT
 * - WARNING:  risk_score >= warn_threshold (default 70) → VENDOR_RISK_FLAGGED
 *
 * Dùng 1 batch query cho tất cả seller_tax_codes trong lần chạy.
 */
export class VendorRiskFilterPlugin implements IInvoiceValidationPlugin {
  readonly name = 'vendor_risk_filter';
  readonly displayName = 'Kiểm tra NCC rủi ro / cưỡng chế';
  readonly priority = 230;
  readonly appliesTo = 'input' as const;
  readonly legalBasis = 'CV 2326/TCT-DNL — NCC bị cưỡng chế hóa đơn không được khấu trừ';
  readonly canDisable = true;

  async validateBatch(
    invoices: InvoiceRow[],
    _context: InvoiceValidationContext,
    db: Pool,
    pluginConfig?: PluginConfig
  ): Promise<Map<string, InvoiceValidationResult>> {
    const results = new Map<string, InvoiceValidationResult>();

    if (invoices.length === 0) return results;

    const cfg = pluginConfig?.config ?? {};
    const warnThreshold = typeof cfg['warn_threshold'] === 'number'
      ? cfg['warn_threshold']
      : DEFAULT_WARN_THRESHOLD;

    // Collect unique seller tax codes for batch query
    const sellerTaxCodes = [...new Set(invoices.map(inv => inv.seller_tax_code).filter(Boolean))];

    if (sellerTaxCodes.length === 0) return results;

    const { rows: riskRows } = await db.query<VendorRiskRow>(
      `SELECT seller_tax_code, enforcement_status, risk_score
       FROM vendor_risk_scores
       WHERE seller_tax_code = ANY($1::text[])`,
      [sellerTaxCodes]
    );

    if (riskRows.length === 0) return results;

    // Build lookup map by seller_tax_code
    const riskMap = new Map<string, VendorRiskRow>();
    for (const row of riskRows) {
      riskMap.set(row.seller_tax_code, row);
    }

    const now = new Date();

    for (const inv of invoices) {
      const risk = riskMap.get(inv.seller_tax_code);
      if (!risk) continue;

      if (risk.enforcement_status === 'active') {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'excluded',
          reason_codes: [ExclusionReasonCode.VENDOR_ENFORCEMENT],
          reason_detail: `NCC MST ${inv.seller_tax_code} đang bị cưỡng chế hóa đơn — không được khấu trừ`,
          plugin_name: this.name,
          validated_at: now,
        });
      } else if (risk.risk_score >= warnThreshold) {
        results.set(inv.id, {
          invoice_id: inv.id,
          status: 'warning',
          reason_codes: [ExclusionReasonCode.VENDOR_RISK_FLAGGED],
          reason_detail: `NCC MST ${inv.seller_tax_code} có điểm rủi ro cao (${risk.risk_score}/100) — cần kiểm tra thêm`,
          plugin_name: this.name,
          validated_at: now,
        });
      }
    }

    return results;
  }
}
