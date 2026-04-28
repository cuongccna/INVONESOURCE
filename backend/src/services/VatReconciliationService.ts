import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';
import { VatReconciliation, VatBreakdown } from 'shared';

export interface VatRateGroup {
  outputSubtotal: number;
  outputVat: number;
  inputSubtotal: number;
  inputVat: number;
}

export interface VatSummary {
  companyId: string;
  periodMonth: number;
  periodYear: number;
  ct22_total_input_vat: number;
  ct23_deductible_input_vat: number;
  ct23_input_subtotal: number;
  /** Tổng doanh thu đầu ra tất cả loại */
  ct29_total_revenue: number;
  /** [26] Doanh thu không chịu thuế GTGT (tax_category=KCT) */
  ct26_kct_revenue: number;
  /** [29] Doanh thu thuế suất 0% / xuất khẩu (tax_category=0) */
  ct29_0pct_revenue: number;
  /** [32a] Doanh thu không phải kê khai, tính nộp thuế (tax_category=KKKNT) */
  ct32a_kkknt_revenue: number;
  /** Backward-compat alias of ct26_kct_revenue */
  ct30_exempt_revenue: number;
  ct32_revenue_5pct: number;
  ct33_vat_5pct: number;
  ct34_revenue_8pct: number;
  ct35_vat_8pct: number;
  ct36_revenue_10pct: number;
  ct37_vat_10pct: number;
  ct40_total_output_revenue: number;
  ct40a_total_output_vat: number;
  outputVat: number;
  inputVat: number;
  payableVat: number;
  breakdown: VatBreakdown;
  /** [37] Auto-computed: VAT giảm từ HĐ điều chỉnh cross-period (HĐ gốc ở kỳ trước) */
  ct37_cross_period_decrease?: number;
  /** [38] Auto-computed: VAT tăng từ HĐ điều chỉnh cross-period (HĐ gốc ở kỳ trước) */
  ct38_cross_period_increase?: number;
}

/**
 * Loại các hóa đơn bị thay thế bởi hóa đơn khác (tc_hdon=1) — khớp số hiệu + serial.
 * Dùng alias tên bảng đang query (vd: 'invoices').
 */
function _notReplacedClause(alias: string): string {
  return `AND NOT EXISTS (
       SELECT 1 FROM invoices _r
       WHERE _r.tc_hdon = 1
         AND _r.deleted_at IS NULL
         AND _r.company_id = ${alias}.company_id
         AND TRIM(COALESCE(_r.khhd_cl_quan,  '')) = TRIM(COALESCE(${alias}.serial_number,  ''))
         AND TRIM(COALESCE(_r.so_hd_cl_quan, '')) = TRIM(COALESCE(${alias}.invoice_number, ''))
         AND COALESCE(_r.seller_tax_code, '') = COALESCE(${alias}.seller_tax_code, '')
     )`;
}

/**
 * VatReconciliationService — calculates and persists VAT reconciliation data
 * for a company in a given period following Vietnam Tax Law.
 *
 * Only gdt_validated input invoices are eligible for VAT deduction (Vietnamese tax law).
 */
export class VatReconciliationService {
  async calculatePeriod(
    companyId: string,
    month: number,
    year: number,
    validIds?: { inputIds?: string[]; outputIds?: string[] }
  ): Promise<VatSummary> {
    // Apply direction-specific ID filters independently.
    // If validIds is provided (even with empty array), always apply the filter —
    // empty array = no valid invoices → result is 0, not "all invoices".
    const hasInputFilter  = validIds?.inputIds  !== undefined;
    const hasOutputFilter = validIds?.outputIds !== undefined;

    const inputIdFilter  = hasInputFilter  ? `AND id = ANY($4::uuid[])` : '';
    const outputIdFilter = hasOutputFilter ? `AND id = ANY($4::uuid[])` : '';

    const inputBaseParams  = () => hasInputFilter  ? [companyId, month, year, validIds!.inputIds]  : [companyId, month, year];
    const outputBaseParams = () => hasOutputFilter ? [companyId, month, year, validIds!.outputIds] : [companyId, month, year];
    // ============================================================
    // [22] Total input VAT — all received input invoices (excl. replaced_original)
    // ============================================================
    const { rows: inputAll } = await pool.query<{
      vat_rate: string;
      vat_sum: string;
      subtotal_sum: string;
    }>(
      `SELECT vat_rate, SUM(vat_amount) as vat_sum, SUM(subtotal) as subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status NOT IN ('cancelled', 'replaced_original')
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
         ${inputIdFilter}
       GROUP BY vat_rate`,
      inputBaseParams()
    );

    const ct22 = inputAll.reduce((sum, row) => sum + parseFloat(row.vat_sum || '0'), 0);

    // ============================================================
    // [23] Deductible input VAT — valid + payment criteria
    // GROUP 47: Group 5 requires gdt_validated=true; Group 6/8 do not require CQT code validation
    // but still must meet 20M threshold / non-cash payment rules
    // ============================================================
    const { rows: inputDeductible } = await pool.query<{
      vat_rate: string;
      vat_sum: string;
      subtotal_sum: string;
    }>(
      `SELECT vat_rate, SUM(vat_amount) as vat_sum, SUM(subtotal) as subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status IN ('valid', 'replaced', 'adjusted')
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
         AND (non_deductible = false OR non_deductible IS NULL)
         AND (
           -- Group 5: có mã CQT → phải gdt_validated; NULL group không tự động coi là group 5
           (invoice_group = 5 AND gdt_validated = true)
           OR
           -- Group 6 & 8: không có mã CQT, được khấu trừ không cần gdt_validated
           (invoice_group IN (6, 8))
           OR
           -- NULL group + gdt_validated: serial format không nhận dạng được nhưng GDT đã xác nhận
           (invoice_group IS NULL AND gdt_validated = true)
         )
         AND (
           total_amount <= 20000000
           OR payment_method IS NULL
           OR (payment_method IS NOT NULL AND LOWER(payment_method) <> 'cash')
         )
         ${_notReplacedClause('invoices')}
         ${inputIdFilter}
       GROUP BY vat_rate`,
      inputBaseParams()
    );

    const ct23 = inputDeductible.reduce((sum, row) => sum + parseFloat(row.vat_sum || '0'), 0);
    const ct23_input_subtotal = inputDeductible.reduce((sum, row) => sum + parseFloat(row.subtotal_sum || '0'), 0);

    // ============================================================
    // Output invoices — valid only, excluding logically-replaced invoices
    // GROUP BY tax_category for proper [26]/[29]/[32a]/[30]/[32]/[34] bucket routing
    // ============================================================
    const { rows: outputByRate } = await pool.query<{
      tax_cat: string;
      vat_sum: string;
      subtotal_sum: string;
    }>(
      `SELECT
         COALESCE(tax_category,
           CASE
             WHEN ROUND(vat_rate::numeric, 2) = 5.00  THEN '5'
             WHEN ROUND(vat_rate::numeric, 2) = 8.00  THEN '8'
             WHEN ROUND(vat_rate::numeric, 2) = 10.00 THEN '10'
             WHEN ROUND(vat_rate::numeric, 2) = 0.00  THEN 'KCT'
             ELSE NULL
           END
         ) AS tax_cat,
         SUM(vat_amount) as vat_sum,
         SUM(subtotal) as subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status IN ('valid', 'replaced', 'adjusted')
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
         AND (
           original_invoice_date IS NULL
           OR DATE_TRUNC('month', original_invoice_date) = DATE_TRUNC('month', invoice_date)
         )
         ${_notReplacedClause('invoices')}
         ${outputIdFilter}
       GROUP BY 1`,
      outputBaseParams()
    );

    // Build output breakdown by tax_category key.
    // NULL tax_cat → merge into 'KCT' (safest fallback for unknown 0-rate output).
    const outputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of outputByRate) {
      const key = row.tax_cat ?? 'KCT';
      const existing = outputMap[key] ?? { subtotal: 0, vat: 0 };
      outputMap[key] = {
        subtotal: existing.subtotal + parseFloat(row.subtotal_sum || '0'),
        vat:      existing.vat     + parseFloat(row.vat_sum     || '0'),
      };
    }

    // ============================================================
    // [37]/[38] Cross-period adjustment invoices (điều chỉnh liên kỳ)
    // Adjustment invoices issued this month for invoices from a PRIOR month are
    // reported separately in [37] (VAT decrease) and [38] (VAT increase).
    // They are EXCLUDED from normal output totals above (original_invoice_date filter).
    // ============================================================
    const { rows: crossPeriodRows } = await pool.query<{ ct37_auto: string; ct38_auto: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN vat_amount < 0 THEN ABS(vat_amount) ELSE 0 END), 0)::text AS ct37_auto,
         COALESCE(SUM(CASE WHEN vat_amount > 0 THEN vat_amount        ELSE 0 END), 0)::text AS ct38_auto
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status IN ('adjusted')
         AND invoice_relation_type = 'adjustment'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
         AND original_invoice_date IS NOT NULL
         AND DATE_TRUNC('month', original_invoice_date) < DATE_TRUNC('month', invoice_date)`,
      [companyId, month, year],
    );
    const ct37_cross_period_decrease = parseFloat(crossPeriodRows[0]?.ct37_auto ?? '0');
    const ct38_cross_period_increase = parseFloat(crossPeriodRows[0]?.ct38_auto ?? '0');

    const ct26_kct   = outputMap['KCT']?.subtotal   ?? 0;  // [26] không chịu thuế
    const ct29_0pct  = outputMap['0']?.subtotal     ?? 0;  // [29] thuế suất 0%
    const ct32a_kkknt = outputMap['KKKNT']?.subtotal ?? 0; // [32a] KKKNT
    const ct32 = outputMap['5']?.subtotal ?? 0;
    const ct33 = outputMap['5']?.vat ?? 0;
    const ct34 = outputMap['8']?.subtotal ?? 0;
    const ct35 = outputMap['8']?.vat ?? 0;
    const ct36 = outputMap['10']?.subtotal ?? 0;
    const ct37 = outputMap['10']?.vat ?? 0;
    // [27] tổng doanh thu chịu thuế = 0% + 5% + 8% + 10%
    const ct27_taxable = ct29_0pct + ct32 + ct34 + ct36;
    // [34] tổng doanh thu = [26] + [27] + [32a]
    const ct29 = ct26_kct + ct27_taxable + ct32a_kkknt;
    // Backward compat: ct30_exempt_revenue = ct26_kct
    const ct30 = ct26_kct;
    const ct40 = ct29;
    const ct40a = ct33 + ct35 + ct37;
    const outputVat = ct40a;

    // Input breakdown by rate
    const inputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of inputDeductible) {
      const rate = String(parseFloat(row.vat_rate));
      inputMap[rate] = {
        subtotal: parseFloat(row.subtotal_sum || '0'),
        vat: parseFloat(row.vat_sum || '0'),
      };
    }

    const inputVat = ct23;
    const payableVat = Math.max(0, outputVat - inputVat);

    // Build breakdown JSONB
    const breakdown: VatBreakdown = {
      by_rate: {
        0: {
          output_subtotal: ct26_kct + ct29_0pct,
          output_vat: (outputMap['KCT']?.vat ?? 0) + (outputMap['0']?.vat ?? 0),
          input_subtotal: inputMap['0']?.subtotal ?? 0,
          input_vat: inputMap['0']?.vat ?? 0,
        },
        5: {
          output_subtotal: ct32,
          output_vat: ct33,
          input_subtotal: inputMap['5']?.subtotal ?? 0,
          input_vat: inputMap['5']?.vat ?? 0,
        },
        8: {
          output_subtotal: ct34,
          output_vat: ct35,
          input_subtotal: inputMap['8']?.subtotal ?? 0,
          input_vat: inputMap['8']?.vat ?? 0,
        },
        10: {
          output_subtotal: ct36,
          output_vat: ct37,
          input_subtotal: inputMap['10']?.subtotal ?? 0,
          input_vat: inputMap['10']?.vat ?? 0,
        },
      },
    };

    // Upsert to vat_reconciliations
    await pool.query(
      `INSERT INTO vat_reconciliations (
        id, company_id, period_month, period_year,
        output_vat, input_vat, payable_vat, breakdown, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (company_id, period_month, period_year)
      DO UPDATE SET
        output_vat = EXCLUDED.output_vat,
        input_vat = EXCLUDED.input_vat,
        payable_vat = EXCLUDED.payable_vat,
        breakdown = EXCLUDED.breakdown,
        generated_at = NOW()`,
      [
        uuidv4(), companyId, month, year,
        outputVat, inputVat, payableVat,
        JSON.stringify(breakdown),
      ]
    );

    return {
      companyId, periodMonth: month, periodYear: year,
      ct22_total_input_vat: ct22,
      ct23_deductible_input_vat: ct23,
      ct23_input_subtotal,
      ct29_total_revenue: ct29,
      ct26_kct_revenue: ct26_kct,
      ct29_0pct_revenue: ct29_0pct,
      ct32a_kkknt_revenue: ct32a_kkknt,
      ct30_exempt_revenue: ct30,
      ct32_revenue_5pct: ct32,
      ct33_vat_5pct: ct33,
      ct34_revenue_8pct: ct34,
      ct35_vat_8pct: ct35,
      ct36_revenue_10pct: ct36,
      ct37_vat_10pct: ct37,
      ct40_total_output_revenue: ct40,
      ct40a_total_output_vat: ct40a,
      outputVat, inputVat, payableVat,
      breakdown,
      ct37_cross_period_decrease,
      ct38_cross_period_increase,
    };
  }

  /**
   * Calculate VAT summary for a full quarter (3 months).
   * quarter = 1..4
   */
  async calculateQuarter(
    companyId: string,
    quarter: number,
    year: number,
    validIds?: { inputIds?: string[]; outputIds?: string[] }
  ): Promise<VatSummary> {
    const m1 = (quarter - 1) * 3 + 1;
    const m2 = m1 + 1;
    const m3 = m1 + 2;
    const months = [m1, m2, m3];

    const hasInputFilter  = validIds?.inputIds  !== undefined;
    const hasOutputFilter = validIds?.outputIds !== undefined;

    const inputIdFilter  = hasInputFilter  ? `AND id = ANY($4::uuid[])` : '';
    const outputIdFilter = hasOutputFilter ? `AND id = ANY($4::uuid[])` : '';

    const inputBaseParams  = () => hasInputFilter  ? [companyId, year, months, validIds!.inputIds]  : [companyId, year, months];
    const outputBaseParams = () => hasOutputFilter ? [companyId, year, months, validIds!.outputIds] : [companyId, year, months];

    const { rows: inputAll } = await pool.query<{ vat_rate: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status NOT IN ('cancelled', 'replaced_original')
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
         ${inputIdFilter}
       GROUP BY vat_rate`,
      inputBaseParams(),
    );

    const ct22 = inputAll.reduce((s, r) => s + parseFloat(r.vat_sum || '0'), 0);

    const { rows: inputDeductible } = await pool.query<{ vat_rate: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status IN ('valid', 'replaced', 'adjusted')
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
         AND (non_deductible = false OR non_deductible IS NULL)
         AND (
           total_amount <= 20000000
           OR payment_method IS NULL
           OR (payment_method IS NOT NULL AND LOWER(payment_method) <> 'cash')
         )
         AND (
           -- Group 5: có mã CQT → phải gdt_validated; NULL group không tự động coi là group 5
           (invoice_group = 5 AND gdt_validated = true)
           OR (invoice_group IN (6, 8))
           OR
           -- NULL group + gdt_validated: serial format không nhận dạng được nhưng GDT đã xác nhận
           (invoice_group IS NULL AND gdt_validated = true)
         )
         ${_notReplacedClause('invoices')}
         ${inputIdFilter}
       GROUP BY vat_rate`,
      inputBaseParams(),
    );

    const ct23 = inputDeductible.reduce((s, r) => s + parseFloat(r.vat_sum || '0'), 0);
    const ct23_input_subtotal = inputDeductible.reduce((s, r) => s + parseFloat(r.subtotal_sum || '0'), 0);

    const { rows: outputByRate } = await pool.query<{ tax_cat: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT
         COALESCE(tax_category,
           CASE
             WHEN ROUND(vat_rate::numeric, 2) = 5.00  THEN '5'
             WHEN ROUND(vat_rate::numeric, 2) = 8.00  THEN '8'
             WHEN ROUND(vat_rate::numeric, 2) = 10.00 THEN '10'
             WHEN ROUND(vat_rate::numeric, 2) = 0.00  THEN 'KCT'
             ELSE NULL
           END
         ) AS tax_cat,
         SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status IN ('valid', 'replaced', 'adjusted')
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
         AND (
           original_invoice_date IS NULL
           OR DATE_TRUNC('quarter', original_invoice_date) = DATE_TRUNC('quarter', invoice_date)
         )
         ${_notReplacedClause('invoices')}
         ${outputIdFilter}
       GROUP BY 1`,
      outputBaseParams(),
    );

    // Build output breakdown by tax_category key.
    // NULL tax_cat → merge into 'KCT' (safest fallback for unknown 0-rate output).
    const outputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of outputByRate) {
      const key = row.tax_cat ?? 'KCT';
      const existing = outputMap[key] ?? { subtotal: 0, vat: 0 };
      outputMap[key] = {
        subtotal: existing.subtotal + parseFloat(row.subtotal_sum || '0'),
        vat:      existing.vat     + parseFloat(row.vat_sum     || '0'),
      };
    }

    const inputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of inputDeductible) {
      const rateParsed = parseFloat(row.vat_rate);
      const rate = isNaN(rateParsed) ? '0' : String(rateParsed);
      const existing = inputMap[rate] ?? { subtotal: 0, vat: 0 };
      inputMap[rate] = {
        subtotal: existing.subtotal + parseFloat(row.subtotal_sum || '0'),
        vat:      existing.vat     + parseFloat(row.vat_sum     || '0'),
      };
    }

    // [37]/[38] Cross-period adjustment invoices for the quarter
    const { rows: crossPeriodRowsQ } = await pool.query<{ ct37_auto: string; ct38_auto: string }>(
      `SELECT
         COALESCE(SUM(CASE WHEN vat_amount < 0 THEN ABS(vat_amount) ELSE 0 END), 0)::text AS ct37_auto,
         COALESCE(SUM(CASE WHEN vat_amount > 0 THEN vat_amount        ELSE 0 END), 0)::text AS ct38_auto
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status IN ('adjusted')
         AND invoice_relation_type = 'adjustment'
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
         AND original_invoice_date IS NOT NULL
         AND DATE_TRUNC('quarter', original_invoice_date) < DATE_TRUNC('quarter', invoice_date)`,
      [companyId, year, months],
    );
    const ct37_cross_period_decrease = parseFloat(crossPeriodRowsQ[0]?.ct37_auto ?? '0');
    const ct38_cross_period_increase = parseFloat(crossPeriodRowsQ[0]?.ct38_auto ?? '0');

    const ct26_kct    = outputMap['KCT']?.subtotal   ?? 0;
    const ct29_0pct   = outputMap['0']?.subtotal     ?? 0;
    const ct32a_kkknt = outputMap['KKKNT']?.subtotal ?? 0;
    const ct32 = outputMap['5']?.subtotal ?? 0;  const ct33 = outputMap['5']?.vat ?? 0;
    const ct34 = outputMap['8']?.subtotal ?? 0;  const ct35 = outputMap['8']?.vat ?? 0;
    const ct36 = outputMap['10']?.subtotal ?? 0; const ct37 = outputMap['10']?.vat ?? 0;
    const ct27_taxable = ct29_0pct + ct32 + ct34 + ct36;
    const ct29 = ct26_kct + ct27_taxable + ct32a_kkknt;
    const ct30 = ct26_kct;
    const ct40 = ct29;
    const ct40a = ct33 + ct35 + ct37;

    const breakdown: VatBreakdown = {
      by_rate: {
        0:  { output_subtotal: ct26_kct + ct29_0pct,  output_vat: (outputMap['KCT']?.vat ?? 0) + (outputMap['0']?.vat ?? 0), input_subtotal: inputMap['0']?.subtotal  ?? 0, input_vat: inputMap['0']?.vat  ?? 0 },
        5:  { output_subtotal: ct32,  output_vat: ct33, input_subtotal: inputMap['5']?.subtotal  ?? 0, input_vat: inputMap['5']?.vat  ?? 0 },
        8:  { output_subtotal: ct34,  output_vat: ct35, input_subtotal: inputMap['8']?.subtotal  ?? 0, input_vat: inputMap['8']?.vat  ?? 0 },
        10: { output_subtotal: ct36,  output_vat: ct37, input_subtotal: inputMap['10']?.subtotal ?? 0, input_vat: inputMap['10']?.vat ?? 0 },
      },
    };

    // Upsert to vat_reconciliations for the quarterly period (period_month stores quarter)
    await pool.query(
      `INSERT INTO vat_reconciliations (
        id, company_id, period_month, period_year,
        output_vat, input_vat, payable_vat, breakdown, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (company_id, period_month, period_year)
      DO UPDATE SET
        output_vat = EXCLUDED.output_vat,
        input_vat = EXCLUDED.input_vat,
        payable_vat = EXCLUDED.payable_vat,
        breakdown = EXCLUDED.breakdown,
        generated_at = NOW()`,
      [
        uuidv4(), companyId, quarter, year,
        ct40a, ct23, Math.max(0, ct40a - ct23),
        JSON.stringify(breakdown),
      ]
    );

    return {
      companyId, periodMonth: quarter, periodYear: year,
      ct22_total_input_vat: ct22,
      ct23_deductible_input_vat: ct23,
      ct23_input_subtotal,
      ct29_total_revenue: ct29, ct30_exempt_revenue: ct30,
      ct26_kct_revenue: ct26_kct,
      ct29_0pct_revenue: ct29_0pct,
      ct32a_kkknt_revenue: ct32a_kkknt,
      ct32_revenue_5pct: ct32,  ct33_vat_5pct: ct33,
      ct34_revenue_8pct: ct34,  ct35_vat_8pct: ct35,
      ct36_revenue_10pct: ct36, ct37_vat_10pct: ct37,
      ct40_total_output_revenue: ct40,
      ct40a_total_output_vat: ct40a,
      outputVat: ct40a, inputVat: ct23,
      payableVat: Math.max(0, ct40a - ct23),
      breakdown,
      ct37_cross_period_decrease,
      ct38_cross_period_increase,
    };
  }
}
