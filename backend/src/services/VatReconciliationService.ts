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
  ct29_total_revenue: number;
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
    year: number
  ): Promise<VatSummary> {
    // ============================================================
    // [22] Total input VAT — all non-cancelled input invoices
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
         AND status != 'cancelled'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       GROUP BY vat_rate`,
      [companyId, month, year]
    );

    const ct22 = inputAll.reduce((sum, row) => sum + parseFloat(row.vat_sum || '0'), 0);

    // ============================================================
    // [23] Deductible input VAT — valid + gdt_validated + payment criteria
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
         AND status = 'valid'
         AND gdt_validated = true
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
         AND (
           total_amount <= 20000000
           OR payment_method IS DISTINCT FROM 'cash'
         )
       GROUP BY vat_rate`,
      [companyId, month, year]
    );

    const ct23 = inputDeductible.reduce((sum, row) => sum + parseFloat(row.vat_sum || '0'), 0);

    // ============================================================
    // Output invoices — valid only
    // ============================================================
    const { rows: outputByRate } = await pool.query<{
      vat_rate: string;
      vat_sum: string;
      subtotal_sum: string;
    }>(
      `SELECT vat_rate, SUM(vat_amount) as vat_sum, SUM(subtotal) as subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       GROUP BY vat_rate`,
      [companyId, month, year]
    );

    // Build output breakdown by rate
    const outputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of outputByRate) {
      const rate = String(parseFloat(row.vat_rate));
      outputMap[rate] = {
        subtotal: parseFloat(row.subtotal_sum || '0'),
        vat: parseFloat(row.vat_sum || '0'),
      };
    }

    const ct29 = Object.values(outputMap).reduce((sum, v) => sum + v.subtotal, 0);
    const ct30 = outputMap['0']?.subtotal ?? 0;
    const ct32 = outputMap['5']?.subtotal ?? 0;
    const ct33 = outputMap['5']?.vat ?? 0;
    const ct34 = outputMap['8']?.subtotal ?? 0;
    const ct35 = outputMap['8']?.vat ?? 0;
    const ct36 = outputMap['10']?.subtotal ?? 0;
    const ct37 = outputMap['10']?.vat ?? 0;
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
          output_subtotal: outputMap['0']?.subtotal ?? 0,
          output_vat: outputMap['0']?.vat ?? 0,
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
      ct29_total_revenue: ct29,
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
  ): Promise<VatSummary> {
    const m1 = (quarter - 1) * 3 + 1;
    const m2 = m1 + 1;
    const m3 = m1 + 2;
    const months = [m1, m2, m3];

    const { rows: inputAll } = await pool.query<{ vat_rate: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status != 'cancelled'
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
       GROUP BY vat_rate`,
      [companyId, year, months],
    );

    const ct22 = inputAll.reduce((s, r) => s + parseFloat(r.vat_sum || '0'), 0);

    const { rows: inputDeductible } = await pool.query<{ vat_rate: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status = 'valid'
         AND gdt_validated = true
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
         AND (total_amount <= 20000000 OR payment_method IS DISTINCT FROM 'cash')
       GROUP BY vat_rate`,
      [companyId, year, months],
    );

    const ct23 = inputDeductible.reduce((s, r) => s + parseFloat(r.vat_sum || '0'), 0);

    const { rows: outputByRate } = await pool.query<{ vat_rate: string; vat_sum: string; subtotal_sum: string }>(
      `SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(subtotal) AS subtotal_sum
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(YEAR FROM invoice_date) = $2
         AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
       GROUP BY vat_rate`,
      [companyId, year, months],
    );

    const outputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of outputByRate) {
      const rate = String(parseFloat(row.vat_rate));
      outputMap[rate] = {
        subtotal: parseFloat(row.subtotal_sum || '0'),
        vat: parseFloat(row.vat_sum || '0'),
      };
    }

    const inputMap: Record<string, { subtotal: number; vat: number }> = {};
    for (const row of inputDeductible) {
      const rate = String(parseFloat(row.vat_rate));
      inputMap[rate] = { subtotal: parseFloat(row.subtotal_sum || '0'), vat: parseFloat(row.vat_sum || '0') };
    }

    const ct29 = Object.values(outputMap).reduce((s, v) => s + v.subtotal, 0);
    const ct30 = outputMap['0']?.subtotal ?? 0;
    const ct32 = outputMap['5']?.subtotal ?? 0;  const ct33 = outputMap['5']?.vat ?? 0;
    const ct34 = outputMap['8']?.subtotal ?? 0;  const ct35 = outputMap['8']?.vat ?? 0;
    const ct36 = outputMap['10']?.subtotal ?? 0; const ct37 = outputMap['10']?.vat ?? 0;
    const ct40 = ct29;
    const ct40a = ct33 + ct35 + ct37;

    const breakdown: VatBreakdown = {
      by_rate: {
        0:  { output_subtotal: ct30,  output_vat: outputMap['0']?.vat  ?? 0, input_subtotal: inputMap['0']?.subtotal  ?? 0, input_vat: inputMap['0']?.vat  ?? 0 },
        5:  { output_subtotal: ct32,  output_vat: ct33, input_subtotal: inputMap['5']?.subtotal  ?? 0, input_vat: inputMap['5']?.vat  ?? 0 },
        8:  { output_subtotal: ct34,  output_vat: ct35, input_subtotal: inputMap['8']?.subtotal  ?? 0, input_vat: inputMap['8']?.vat  ?? 0 },
        10: { output_subtotal: ct36,  output_vat: ct37, input_subtotal: inputMap['10']?.subtotal ?? 0, input_vat: inputMap['10']?.vat ?? 0 },
      },
    };

    return {
      companyId, periodMonth: quarter, periodYear: year,
      ct22_total_input_vat: ct22,
      ct23_deductible_input_vat: ct23,
      ct29_total_revenue: ct29, ct30_exempt_revenue: ct30,
      ct32_revenue_5pct: ct32,  ct33_vat_5pct: ct33,
      ct34_revenue_8pct: ct34,  ct35_vat_8pct: ct35,
      ct36_revenue_10pct: ct36, ct37_vat_10pct: ct37,
      ct40_total_output_revenue: ct40,
      ct40a_total_output_vat: ct40a,
      outputVat: ct40a, inputVat: ct23,
      payableVat: Math.max(0, ct40a - ct23),
      breakdown,
    };
  }
}
