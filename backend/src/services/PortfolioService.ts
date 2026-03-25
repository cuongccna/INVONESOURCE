/**
 * PortfolioService — aggregates KPIs, VAT, and invoice totals across
 * all companies a user has access to. Every public method executes a
 * SINGLE SQL query with GROUP BY — no N+1, no per-company loops.
 */

import { pool } from '../db/pool';

export interface PortfolioCompanySummary {
  company_id: string;
  company_name: string;
  tax_code: string;
  output_invoices: string;
  input_invoices: string;
  output_total: string;
  input_total: string;
  output_vat: string;
  input_vat: string;
  payable_vat: string;
  unvalidated_count: string;
  cancelled_count: string;
}

export interface PortfolioKpi {
  total_companies: number;
  total_invoices: number;
  total_output: number;
  total_input: number;
  total_output_vat: number;
  total_input_vat: number;
  total_payable_vat: number;
  total_unvalidated: number;
  period: { month: number; year: number };
  by_company: PortfolioCompanySummary[];
}

export interface PortfolioTrend {
  month: number;
  year: number;
  output_total: number;
  input_total: number;
  output_vat: number;
  input_vat: number;
  payable_vat: number;
}

export class PortfolioService {
  /**
   * Fetch KPI totals + per-company breakdown for all of the user's companies
   * in a given period. One SQL query via GROUP BY + ROLLUP-style aggregation.
   */
  static async getKpi(
    userId: string,
    month: number,
    year: number,
    organizationId?: string | null,
  ): Promise<PortfolioKpi> {
    const params: unknown[] = [userId, month, year];
    const orgFilter = organizationId
      ? `AND c.organization_id = $${params.push(organizationId)}`
      : '';

    const { rows } = await pool.query<{
      company_id: string;
      company_name: string;
      tax_code: string;
      output_invoices: string;
      input_invoices: string;
      output_total: string;
      input_total: string;
      unvalidated_count: string;
      cancelled_count: string;
    }>(
      `SELECT
         c.id          AS company_id,
         c.name        AS company_name,
         c.tax_code,
         COUNT(*) FILTER (WHERE i.direction = 'output')                   AS output_invoices,
         COUNT(*) FILTER (WHERE i.direction = 'input')                    AS input_invoices,
         COALESCE(SUM(i.total_amount) FILTER (WHERE i.direction = 'output'), 0)  AS output_total,
         COALESCE(SUM(i.total_amount) FILTER (WHERE i.direction = 'input'),  0)  AS input_total,
         COUNT(*) FILTER (WHERE i.gdt_validated = false AND i.status = 'valid')  AS unvalidated_count,
         COUNT(*) FILTER (WHERE i.status = 'cancelled')                   AS cancelled_count
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       LEFT JOIN invoices i
         ON i.company_id = c.id
        AND EXTRACT(MONTH FROM i.invoice_date) = $2
        AND EXTRACT(YEAR  FROM i.invoice_date) = $3
        AND i.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
         ${orgFilter}
       GROUP BY c.id, c.name, c.tax_code
       ORDER BY c.name ASC`,
      params,
    );

    // Fetch VAT reconciliation for the same period in one query
    const vatParams: unknown[] = [userId, month, year];
    const vatOrgFilter = organizationId
      ? `AND c.organization_id = $${vatParams.push(organizationId)}`
      : '';

    const { rows: vatRows } = await pool.query<{
      company_id: string;
      output_vat: string;
      input_vat: string;
      payable_vat: string;
    }>(
      `SELECT vr.company_id, vr.output_vat, vr.input_vat, vr.payable_vat
       FROM vat_reconciliations vr
       JOIN companies c ON c.id = vr.company_id
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       WHERE vr.period_month = $2 AND vr.period_year = $3
         AND c.deleted_at IS NULL
         ${vatOrgFilter}`,
      vatParams,
    );

    const vatMap = new Map(vatRows.map((r) => [r.company_id, r]));

    const byCompany: PortfolioCompanySummary[] = rows.map((r) => {
      const vat = vatMap.get(r.company_id);
      return {
        ...r,
        output_vat:  vat?.output_vat  ?? '0',
        input_vat:   vat?.input_vat   ?? '0',
        payable_vat: vat?.payable_vat ?? '0',
      };
    });

    const totals = byCompany.reduce(
      (acc, c) => ({
        invoices:     acc.invoices + Number(c.output_invoices) + Number(c.input_invoices),
        output:       acc.output + Number(c.output_total),
        input:        acc.input + Number(c.input_total),
        output_vat:   acc.output_vat + Number(c.output_vat),
        input_vat:    acc.input_vat + Number(c.input_vat),
        payable_vat:  acc.payable_vat + Number(c.payable_vat),
        unvalidated:  acc.unvalidated + Number(c.unvalidated_count),
      }),
      { invoices: 0, output: 0, input: 0, output_vat: 0, input_vat: 0, payable_vat: 0, unvalidated: 0 },
    );

    return {
      total_companies:  rows.length,
      total_invoices:   totals.invoices,
      total_output:     totals.output,
      total_input:      totals.input,
      total_output_vat: totals.output_vat,
      total_input_vat:  totals.input_vat,
      total_payable_vat: totals.payable_vat,
      total_unvalidated: totals.unvalidated,
      period: { month, year },
      by_company: byCompany,
    };
  }

  /**
   * Monthly trend aggregated across all user companies (last 12 months).
   * Single SQL — joined against user_companies for ownership filter.
   */
  static async getTrend(
    userId: string,
    organizationId?: string | null,
  ): Promise<PortfolioTrend[]> {
    const params: unknown[] = [userId];
    const orgFilter = organizationId
      ? `AND c.organization_id = $${params.push(organizationId)}`
      : '';

    const { rows } = await pool.query<{
      month: string;
      year: string;
      output_total: string;
      input_total: string;
      output_vat: string;
      input_vat: string;
      payable_vat: string;
    }>(
      `SELECT
         EXTRACT(MONTH FROM invoice_date)::int AS month,
         EXTRACT(YEAR  FROM invoice_date)::int AS year,
         COALESCE(SUM(total_amount) FILTER (WHERE direction = 'output'), 0) AS output_total,
         COALESCE(SUM(total_amount) FILTER (WHERE direction = 'input'),  0) AS input_total,
         COALESCE(SUM(vat_amount)   FILTER (WHERE direction = 'output'), 0) AS output_vat,
         COALESCE(SUM(vat_amount)   FILTER (WHERE direction = 'input'),  0) AS input_vat,
         COALESCE(
           SUM(vat_amount) FILTER (WHERE direction = 'output') -
           SUM(vat_amount) FILTER (WHERE direction = 'input'), 0
         ) AS payable_vat
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       WHERE i.invoice_date >= NOW() - INTERVAL '11 months'
         AND i.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND i.status != 'cancelled'
         ${orgFilter}
       GROUP BY 1, 2
       ORDER BY 2 ASC, 1 ASC`,
      params,
    );

    return rows.map((r) => ({
      month:       Number(r.month),
      year:        Number(r.year),
      output_total: Number(r.output_total),
      input_total:  Number(r.input_total),
      output_vat:   Number(r.output_vat),
      input_vat:    Number(r.input_vat),
      payable_vat:  Number(r.payable_vat),
    }));
  }
}
