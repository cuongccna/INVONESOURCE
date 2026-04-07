import { pool } from '../db/pool';
import { VatReconciliationService } from './VatReconciliationService';
import { v4 as uuidv4 } from 'uuid';
import { TaxDeclaration } from 'shared';
import { InvoiceValidationPipeline } from '../tax/validation/invoice-validation.pipeline';
import type { InvoiceRow, PipelineValidationOutput } from '../tax/validation/types';

export interface TaxDeclarationOptions {
  includeUncashPayments?: boolean;  // default false
}

export interface TaxDeclarationWithValidation extends TaxDeclaration {
  _validation?: PipelineValidationOutput;
}

/**
 * TaxDeclarationEngine — calculates all 01/GTGT form line items from invoice data.
 * Follows EXACTLY the formula in PRD.md Section 7 (TT80/2021).
 */
export class TaxDeclarationEngine {
  private vatService = new VatReconciliationService();
  private pipeline = new InvoiceValidationPipeline();

  /**
   * Fetch the raw invoices for a company+period needed by the validation pipeline.
   */
  private async fetchInvoicesForPeriod(
    companyId: string,
    startDate: Date,
    endDate: Date
  ): Promise<InvoiceRow[]> {
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT id, company_id, direction, status, invoice_number, serial_number,
              invoice_date, seller_tax_code, seller_name, buyer_tax_code, buyer_name,
              total_amount, vat_amount, payment_method, gdt_validated,
              invoice_group, serial_has_cqt, has_line_items,
              mccqt, tc_hdon, lhd_cl_quan, khhd_cl_quan, so_hd_cl_quan
       FROM invoices
       WHERE company_id = $1
         AND deleted_at IS NULL
         AND invoice_date >= $2
         AND invoice_date < $3`,
      [companyId, startDate, endDate]
    );
    return rows;
  }

  /** Lookup the tax_code (MST) for a companyId. */
  private async getCompanyMst(companyId: string): Promise<string> {
    const { rows } = await pool.query<{ tax_code: string }>(
      `SELECT tax_code FROM companies WHERE id = $1`,
      [companyId]
    );
    return rows[0]?.tax_code ?? '';
  }

  async calculateDeclaration(
    companyId: string,
    month: number,
    year: number,
    options: TaxDeclarationOptions = {}
  ): Promise<TaxDeclarationWithValidation> {
    // Step 0: Run invoice validation pipeline to pre-filter invoices.
    // Only valid invoices from the pipeline are included in tax calculations.
    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 1);

    const [invoices, mst] = await Promise.all([
      this.fetchInvoicesForPeriod(companyId, startDate, endDate),
      this.getCompanyMst(companyId),
    ]);

    const periodStr = `${year}-${String(month).padStart(2, '0')}`;
    const validationOutput = await this.pipeline.validate(invoices, {
      mst,
      declaration_period: periodStr,
      declaration_type: 'monthly',
      direction: 'both',
    });

    const validInvoiceIds = validationOutput.valid_invoices;

    // Split valid IDs by direction — critical to prevent input-only IDs from filtering
    // output queries (and zeroing out ct40a). Each direction is filtered independently.
    const validIdSet = new Set(validInvoiceIds);
    const validInputIds  = invoices.filter(inv => inv.direction === 'input'  && validIdSet.has(inv.id)).map(inv => inv.id);
    const validOutputIds = invoices.filter(inv => inv.direction === 'output' && validIdSet.has(inv.id)).map(inv => inv.id);

    // Step 1: Get VAT summary — restricted to validated invoice IDs by direction
    const vat = await this.vatService.calculatePeriod(companyId, month, year,
      validInvoiceIds.length > 0 ? { inputIds: validInputIds, outputIds: validOutputIds } : undefined
    );

    // Step 2: Get carry-forward from previous period [24]
    const ct24 = await this.getCarryForward(companyId, month, year);

    // [25] = [23] + [24]
    const ct25 = vat.ct23_deductible_input_vat + ct24;

    // NQ142/NQ204: giảm thuế = 2% × doanh thu đầu ra 8%
    const ct36_nq = Math.round(vat.ct34_revenue_8pct * 0.02);

    // [40a] sau NQ142 = tổng thuế đầu ra - giảm NQ
    const ct40a_adjusted = Math.round(vat.ct40a_total_output_vat) - ct36_nq;

    // [41] = MAX(0, [40a_adj] - [25]) → phải nộp
    const ct41 = Math.max(0, ct40a_adjusted - ct25);

    // [43] = MAX(0, [25] - [40a_adj]) → kết chuyển
    const ct43 = Math.max(0, ct25 - ct40a_adjusted);

    // Upsert tax_declarations
    const id = uuidv4();
    await pool.query(
      `INSERT INTO tax_declarations (
        id, company_id, period_month, period_year, form_type, period_type,
        ct22_total_input_vat, ct23_deductible_input_vat, ct23_input_subtotal,
        ct24_carried_over_vat, ct25_total_deductible,
        ct29_total_revenue, ct30_exempt_revenue,
        ct32_revenue_5pct, ct33_vat_5pct,
        ct34_revenue_8pct, ct35_vat_8pct,
        ct36_revenue_10pct, ct37_vat_10pct,
        ct36_nq_vat_reduction,
        ct40_total_output_revenue, ct40a_total_output_vat,
        ct41_payable_vat, ct43_carry_forward_vat,
        submission_status, updated_at
      ) VALUES (
        $1,$2,$3,$4,'01/GTGT','monthly',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()
      )
      ON CONFLICT (company_id, period_month, period_year, form_type, period_type)
      DO UPDATE SET
        ct22_total_input_vat = EXCLUDED.ct22_total_input_vat,
        ct23_deductible_input_vat = EXCLUDED.ct23_deductible_input_vat,
        ct23_input_subtotal = EXCLUDED.ct23_input_subtotal,
        ct24_carried_over_vat = EXCLUDED.ct24_carried_over_vat,
        ct25_total_deductible = EXCLUDED.ct25_total_deductible,
        ct29_total_revenue = EXCLUDED.ct29_total_revenue,
        ct30_exempt_revenue = EXCLUDED.ct30_exempt_revenue,
        ct32_revenue_5pct = EXCLUDED.ct32_revenue_5pct,
        ct33_vat_5pct = EXCLUDED.ct33_vat_5pct,
        ct34_revenue_8pct = EXCLUDED.ct34_revenue_8pct,
        ct35_vat_8pct = EXCLUDED.ct35_vat_8pct,
        ct36_revenue_10pct = EXCLUDED.ct36_revenue_10pct,
        ct37_vat_10pct = EXCLUDED.ct37_vat_10pct,
        ct36_nq_vat_reduction = EXCLUDED.ct36_nq_vat_reduction,
        ct40_total_output_revenue = EXCLUDED.ct40_total_output_revenue,
        ct40a_total_output_vat = EXCLUDED.ct40a_total_output_vat,
        ct41_payable_vat = EXCLUDED.ct41_payable_vat,
        ct43_carry_forward_vat = EXCLUDED.ct43_carry_forward_vat,
        submission_status = CASE WHEN tax_declarations.submission_status IN ('submitted','accepted')
                                 THEN tax_declarations.submission_status
                                 ELSE 'draft' END,
        updated_at = NOW()`,
      [
        id, companyId, month, year,
        Math.round(vat.ct22_total_input_vat),
        Math.round(vat.ct23_deductible_input_vat),
        Math.round(vat.ct23_input_subtotal),
        Math.round(ct24),
        Math.round(ct25),
        Math.round(vat.ct29_total_revenue),
        Math.round(vat.ct30_exempt_revenue),
        Math.round(vat.ct32_revenue_5pct),
        Math.round(vat.ct33_vat_5pct),
        Math.round(vat.ct34_revenue_8pct),
        Math.round(vat.ct35_vat_8pct),
        Math.round(vat.ct36_revenue_10pct),
        Math.round(vat.ct37_vat_10pct),
        ct36_nq,
        Math.round(vat.ct40_total_output_revenue),
        Math.round(vat.ct40a_total_output_vat),
        Math.round(ct41),
        Math.round(ct43),
        'draft',
      ]
    );

    // Fetch and return the upserted row, augmented with validation output
    const { rows } = await pool.query<TaxDeclaration>(
      `SELECT * FROM tax_declarations
       WHERE company_id = $1 AND period_month = $2 AND period_year = $3
         AND form_type = '01/GTGT' AND period_type = 'monthly'`,
      [companyId, month, year]
    );

    return { ...rows[0]!, _validation: validationOutput };
  }

  /**
   * Calculate quarterly declaration (q=1..4).
   * period_month stores the quarter number (1-4), period_type = 'quarterly'.
   */
  async calculateQuarterlyDeclaration(
    companyId: string,
    quarter: number,
    year: number,
  ): Promise<TaxDeclarationWithValidation> {
    // Step 0: Run validation pipeline for the full quarter date range
    const startMonth = (quarter - 1) * 3 + 1;
    const startDate  = new Date(year, startMonth - 1, 1);
    const endDate    = new Date(year, startMonth + 2, 1);

    const [invoices, mst] = await Promise.all([
      this.fetchInvoicesForPeriod(companyId, startDate, endDate),
      this.getCompanyMst(companyId),
    ]);

    const validationOutput = await this.pipeline.validate(invoices, {
      mst,
      declaration_period: `${year}-Q${quarter}`,
      declaration_type: 'quarterly',
      direction: 'both',
    });

    const validInvoiceIds = validationOutput.valid_invoices;

    // Split valid IDs by direction
    const validIdSet = new Set(validInvoiceIds);
    const validInputIds  = invoices.filter(inv => inv.direction === 'input'  && validIdSet.has(inv.id)).map(inv => inv.id);
    const validOutputIds = invoices.filter(inv => inv.direction === 'output' && validIdSet.has(inv.id)).map(inv => inv.id);

    const vat  = await this.vatService.calculateQuarter(companyId, quarter, year,
      validInvoiceIds.length > 0 ? { inputIds: validInputIds, outputIds: validOutputIds } : undefined
    );
    const ct24 = await this.getCarryForwardQuarterly(companyId, quarter, year);
    const ct25 = vat.ct23_deductible_input_vat + ct24;

    // NQ142/NQ204: giảm thuế = 2% × doanh thu đầu ra 8%
    const ct36_nq = Math.round(vat.ct34_revenue_8pct * 0.02);
    const ct40a_adjusted = Math.round(vat.ct40a_total_output_vat) - ct36_nq;

    const ct41 = Math.max(0, ct40a_adjusted - ct25);
    const ct43 = Math.max(0, ct25 - ct40a_adjusted);

    const id = uuidv4();
    await pool.query(
      `INSERT INTO tax_declarations (
        id, company_id, period_month, period_year, form_type, period_type,
        ct22_total_input_vat, ct23_deductible_input_vat, ct23_input_subtotal,
        ct24_carried_over_vat, ct25_total_deductible,
        ct29_total_revenue, ct30_exempt_revenue,
        ct32_revenue_5pct, ct33_vat_5pct,
        ct34_revenue_8pct, ct35_vat_8pct,
        ct36_revenue_10pct, ct37_vat_10pct,
        ct36_nq_vat_reduction,
        ct40_total_output_revenue, ct40a_total_output_vat,
        ct41_payable_vat, ct43_carry_forward_vat,
        submission_status, updated_at
      ) VALUES (
        $1,$2,$3,$4,'01/GTGT','quarterly',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW()
      )
      ON CONFLICT (company_id, period_month, period_year, form_type, period_type)
      DO UPDATE SET
        ct22_total_input_vat = EXCLUDED.ct22_total_input_vat,
        ct23_deductible_input_vat = EXCLUDED.ct23_deductible_input_vat,
        ct23_input_subtotal = EXCLUDED.ct23_input_subtotal,
        ct24_carried_over_vat = EXCLUDED.ct24_carried_over_vat,
        ct25_total_deductible = EXCLUDED.ct25_total_deductible,
        ct29_total_revenue = EXCLUDED.ct29_total_revenue,
        ct30_exempt_revenue = EXCLUDED.ct30_exempt_revenue,
        ct32_revenue_5pct = EXCLUDED.ct32_revenue_5pct,
        ct33_vat_5pct = EXCLUDED.ct33_vat_5pct,
        ct34_revenue_8pct = EXCLUDED.ct34_revenue_8pct,
        ct35_vat_8pct = EXCLUDED.ct35_vat_8pct,
        ct36_revenue_10pct = EXCLUDED.ct36_revenue_10pct,
        ct37_vat_10pct = EXCLUDED.ct37_vat_10pct,
        ct36_nq_vat_reduction = EXCLUDED.ct36_nq_vat_reduction,
        ct40_total_output_revenue = EXCLUDED.ct40_total_output_revenue,
        ct40a_total_output_vat = EXCLUDED.ct40a_total_output_vat,
        ct41_payable_vat = EXCLUDED.ct41_payable_vat,
        ct43_carry_forward_vat = EXCLUDED.ct43_carry_forward_vat,
        submission_status = CASE WHEN tax_declarations.submission_status IN ('submitted','accepted')
                                 THEN tax_declarations.submission_status
                                 ELSE 'draft' END,
        updated_at = NOW()`,
      [
        id, companyId, quarter, year,
        Math.round(vat.ct22_total_input_vat),
        Math.round(vat.ct23_deductible_input_vat),
        Math.round(vat.ct23_input_subtotal),
        Math.round(ct24), Math.round(ct25),
        Math.round(vat.ct29_total_revenue), Math.round(vat.ct30_exempt_revenue),
        Math.round(vat.ct32_revenue_5pct),  Math.round(vat.ct33_vat_5pct),
        Math.round(vat.ct34_revenue_8pct),  Math.round(vat.ct35_vat_8pct),
        Math.round(vat.ct36_revenue_10pct), Math.round(vat.ct37_vat_10pct),
        ct36_nq,
        Math.round(vat.ct40_total_output_revenue),
        Math.round(vat.ct40a_total_output_vat),
        Math.round(ct41), Math.round(ct43),
        'draft',
      ]
    );

    const { rows } = await pool.query<TaxDeclaration>(
      `SELECT * FROM tax_declarations
       WHERE company_id = $1 AND period_month = $2 AND period_year = $3
         AND form_type = '01/GTGT' AND period_type = 'quarterly'`,
      [companyId, quarter, year]
    );
    return { ...rows[0]!, _validation: validationOutput };
  }

  /**
   * Get carry-forward from previous period [24].
   * For monthly: previous month's ct43.
   * For quarterly: previous quarter's ct43 (or last monthly ct43 if Q1).
   */
  private async getCarryForward(
    companyId: string,
    month: number,
    year: number
  ): Promise<number> {
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth === 0) { prevMonth = 12; prevYear = year - 1; }

    const { rows } = await pool.query<{ ct43_carry_forward_vat: string }>(
      `SELECT ct43_carry_forward_vat FROM tax_declarations
       WHERE company_id = $1 AND period_month = $2 AND period_year = $3
         AND form_type = '01/GTGT' AND period_type = 'monthly'`,
      [companyId, prevMonth, prevYear]
    );
    if (!rows.length) return 0;
    return parseFloat(rows[0].ct43_carry_forward_vat) || 0;
  }

  private async getCarryForwardQuarterly(
    companyId: string,
    quarter: number,
    year: number,
  ): Promise<number> {
    let prevQ = quarter - 1;
    let prevY = year;
    if (prevQ === 0) { prevQ = 4; prevY = year - 1; }

    // Check if there's a quarterly declaration for prev quarter
    const { rows } = await pool.query<{ ct43_carry_forward_vat: string }>(
      `SELECT ct43_carry_forward_vat FROM tax_declarations
       WHERE company_id = $1 AND period_month = $2 AND period_year = $3
         AND form_type = '01/GTGT' AND period_type = 'quarterly'`,
      [companyId, prevQ, prevY]
    );
    if (rows.length) return parseFloat(rows[0].ct43_carry_forward_vat) || 0;

    // Fallback: last month of previous quarter
    const lastMonth = prevQ * 3;
    const { rows: monthly } = await pool.query<{ ct43_carry_forward_vat: string }>(
      `SELECT ct43_carry_forward_vat FROM tax_declarations
       WHERE company_id = $1 AND period_month = $2 AND period_year = $3
         AND form_type = '01/GTGT' AND period_type = 'monthly'`,
      [companyId, lastMonth, prevY]
    );
    if (!monthly.length) return 0;
    return parseFloat(monthly[0].ct43_carry_forward_vat) || 0;
  }

  /**
   * Returns audit gate warnings that should be shown to the user before finalising a declaration.
   *
   * Checks:
   *  1. Cash payment risk: input invoices ≥5M with unknown payment method
   *     → if flagged, CT23 may be overstated (Điều 26 NĐ181/2013)
   *  2. Ghost company risk: critical/high risk sellers with unacknowledged flags
   *     → input VAT from those sellers is at risk of being disallowed by GDT
   *  3. Amendment pending: amended/replacement invoices not yet routed cross-period
   *     → declaration may need a supplemental for prior period
   */
  async getCT23Warnings(
    companyId: string,
    month: number,
    year: number,
  ): Promise<{
    cashRiskCount:        number;
    cashRiskVat:          number;
    ghostRiskCount:       number;
    ghostRiskVat:         number;
    amendmentPending:     number;
    hasBlockingWarning:   boolean;
  }> {
    const [cashRes, ghostRes, amendRes] = await Promise.all([
      // Cash risk: input invoices flagged but not acknowledged in this period
      pool.query<{ cnt: string; vat_sum: string }>(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(vat_amount), 0) AS vat_sum
         FROM active_invoices
         WHERE company_id = $1
           AND direction = 'input'
           AND is_cash_payment_risk = true
           AND cash_risk_acknowledged = false
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR  FROM invoice_date) = $3`,
        [companyId, month, year],
      ),
      // Ghost risk: unacknowledged critical/high risk flags for this company's sellers
      pool.query<{ cnt: string; vat_sum: string }>(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_vat_at_risk), 0) AS vat_sum
         FROM company_risk_flags
         WHERE company_id = $1
           AND risk_level IN ('critical', 'high')
           AND acknowledged_at IS NULL`,
        [companyId],
      ),
      // Amendment pending: invoices from this period with unresolved cross-period routing
      pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt
         FROM active_invoices
         WHERE company_id = $1
           AND invoice_relation_type IN ('replacement', 'adjustment')
           AND cross_period_flag = true
           AND (routing_decision IS NULL OR routing_decision = 'pending')
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR  FROM invoice_date) = $3`,
        [companyId, month, year],
      ),
    ]);

    const cashRiskCount  = parseInt(cashRes.rows[0]!.cnt,  10);
    const cashRiskVat    = parseFloat(cashRes.rows[0]!.vat_sum);
    const ghostRiskCount = parseInt(ghostRes.rows[0]!.cnt, 10);
    const ghostRiskVat   = parseFloat(ghostRes.rows[0]!.vat_sum);
    const amendmentPending = parseInt(amendRes.rows[0]!.cnt, 10);

    return {
      cashRiskCount,
      cashRiskVat,
      ghostRiskCount,
      ghostRiskVat,
      amendmentPending,
      hasBlockingWarning: cashRiskCount > 0 || ghostRiskCount > 0,
    };
  }
}
