/**
 * ConsolidatedGroupService — aggregates KPIs across all entities
 * belonging to a single organization_id, with inter-company invoice
 * EXCLUSION as required by Vietnamese accounting standards.
 *
 * Inter-company rule (copilot-instructions.md):
 *   Exclude invoices where BOTH seller_tax_code AND buyer_tax_code
 *   belong to companies within the same organization_id.
 *
 * All aggregations run in a SINGLE SQL query — no N+1 loops.
 */

import { pool } from '../db/pool';

export interface GroupKpi {
  organization_id: string;
  total_entities: number;
  total_invoices: number;
  total_output: number;
  total_input: number;
  total_output_vat: number;
  total_input_vat: number;
  total_payable_vat: number;
  total_unvalidated: number;
  inter_company_excluded: number;
  period: { month: number; year: number };
  by_entity: GroupEntitySummary[];
}

export interface GroupEntitySummary {
  company_id: string;
  company_name: string;
  tax_code: string;
  level: number;
  entity_type: string;
  output_invoices: number;
  input_invoices: number;
  output_total: number;
  input_total: number;
  output_vat: number;
  input_vat: number;
  payable_vat: number;
}

export interface GroupTrend {
  month: number;
  year: number;
  output_total: number;
  input_total: number;
  output_vat: number;
  input_vat: number;
  payable_vat: number;
  excluded_inter_company: number;
}

export class ConsolidatedGroupService {
  /**
   * Verify the requesting user has access to at least one company in the org.
   */
  private static async assertUserAccessToOrg(userId: string, organizationId: string): Promise<string[]> {
    const { rows } = await pool.query<{ tax_code: string }>(
      `SELECT c.tax_code
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $1
       WHERE c.organization_id = $2 AND c.deleted_at IS NULL`,
      [userId, organizationId],
    );
    return rows.map((r) => r.tax_code);
  }

  /**
   * KPI summary for a given organization and period.
   * Excludes invoices where both parties are within the same org.
   */
  static async getKpi(
    userId: string,
    organizationId: string,
    month: number,
    year: number,
  ): Promise<GroupKpi> {
    // Ensure user belongs to this org
    const orgTaxCodes = await this.assertUserAccessToOrg(userId, organizationId);
    if (orgTaxCodes.length === 0) {
      return {
        organization_id: organizationId,
        total_entities: 0,
        total_invoices: 0,
        total_output: 0,
        total_input: 0,
        total_output_vat: 0,
        total_input_vat: 0,
        total_payable_vat: 0,
        total_unvalidated: 0,
        inter_company_excluded: 0,
        period: { month, year },
        by_entity: [],
      };
    }

    // Get all entity invoice data (excluding inter-company) in one query
    const { rows } = await pool.query<{
      company_id: string;
      company_name: string;
      tax_code: string;
      level: string;
      entity_type: string;
      output_invoices: string;
      input_invoices: string;
      output_total: string;
      input_total: string;
      unvalidated_count: string;
    }>(
      `WITH org_tax_codes AS (
         SELECT c.tax_code
         FROM companies c
         WHERE c.organization_id = $1 AND c.deleted_at IS NULL
       )
       SELECT
         c.id          AS company_id,
         c.name        AS company_name,
         c.tax_code,
         COALESCE(c.level, 1)::text          AS level,
         COALESCE(c.entity_type, 'company')  AS entity_type,
         COUNT(*) FILTER (
           WHERE i.direction = 'output'
             AND i.buyer_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         )  AS output_invoices,
         COUNT(*) FILTER (
           WHERE i.direction = 'input'
             AND i.seller_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         )  AS input_invoices,
         COALESCE(SUM(i.total_amount) FILTER (
           WHERE i.direction = 'output'
             AND i.buyer_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0)  AS output_total,
         COALESCE(SUM(i.total_amount) FILTER (
           WHERE i.direction = 'input'
             AND i.seller_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0)  AS input_total,
         COUNT(*) FILTER (
           WHERE i.gdt_validated = false AND i.status = 'valid'
         )  AS unvalidated_count
       FROM companies c
       JOIN user_companies uc ON uc.company_id = c.id AND uc.user_id = $2
       LEFT JOIN invoices i
         ON i.company_id = c.id
        AND EXTRACT(MONTH FROM i.invoice_date) = $3
        AND EXTRACT(YEAR  FROM i.invoice_date) = $4
        AND i.deleted_at IS NULL
       WHERE c.organization_id = $1 AND c.deleted_at IS NULL
       GROUP BY c.id, c.name, c.tax_code, c.level, c.entity_type
       ORDER BY c.level ASC, c.name ASC`,
      [organizationId, userId, month, year],
    );

    // Count excluded inter-company invoices (for transparency)
    const { rows: excludedRows } = await pool.query<{ cnt: string }>(
      `WITH org_tax_codes AS (
         SELECT c.tax_code FROM companies c
         WHERE c.organization_id = $1 AND c.deleted_at IS NULL
       )
       SELECT COUNT(*)::text AS cnt
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       WHERE c.organization_id = $1
         AND EXTRACT(MONTH FROM i.invoice_date) = $2
         AND EXTRACT(YEAR  FROM i.invoice_date) = $3
         AND i.direction = 'output'
         AND i.buyer_tax_code IN (SELECT tax_code FROM org_tax_codes)
         AND i.deleted_at IS NULL`,
      [organizationId, month, year],
    );

    // VAT per entity
    const { rows: vatRows } = await pool.query<{
      company_id: string;
      output_vat: string;
      input_vat: string;
      payable_vat: string;
    }>(
      `SELECT vr.company_id, vr.output_vat, vr.input_vat, vr.payable_vat
       FROM vat_reconciliations vr
       JOIN companies c ON c.id = vr.company_id
       WHERE c.organization_id = $1
         AND vr.period_month = $2 AND vr.period_year = $3
         AND c.deleted_at IS NULL`,
      [organizationId, month, year],
    );

    const vatMap = new Map(vatRows.map((r) => [r.company_id, r]));

    const byEntity: GroupEntitySummary[] = rows.map((r) => {
      const vat = vatMap.get(r.company_id);
      return {
        company_id:     r.company_id,
        company_name:   r.company_name,
        tax_code:       r.tax_code,
        level:          Number(r.level),
        entity_type:    r.entity_type,
        output_invoices: Number(r.output_invoices),
        input_invoices:  Number(r.input_invoices),
        output_total:    Number(r.output_total),
        input_total:     Number(r.input_total),
        output_vat:      vat ? Number(vat.output_vat) : 0,
        input_vat:       vat ? Number(vat.input_vat) : 0,
        payable_vat:     vat ? Number(vat.payable_vat) : 0,
      };
    });

    const totals = byEntity.reduce(
      (acc, e) => ({
        invoices:     acc.invoices + e.output_invoices + e.input_invoices,
        output:       acc.output + e.output_total,
        input:        acc.input + e.input_total,
        output_vat:   acc.output_vat + e.output_vat,
        input_vat:    acc.input_vat + e.input_vat,
        payable_vat:  acc.payable_vat + e.payable_vat,
        unvalidated:  acc.unvalidated + Number((rows.find((r) => r.company_id === e.company_id)?.unvalidated_count) ?? 0),
      }),
      { invoices: 0, output: 0, input: 0, output_vat: 0, input_vat: 0, payable_vat: 0, unvalidated: 0 },
    );

    return {
      organization_id:       organizationId,
      total_entities:        rows.length,
      total_invoices:        totals.invoices,
      total_output:          totals.output,
      total_input:           totals.input,
      total_output_vat:      totals.output_vat,
      total_input_vat:       totals.input_vat,
      total_payable_vat:     totals.payable_vat,
      total_unvalidated:     totals.unvalidated,
      inter_company_excluded: Number(excludedRows[0]?.cnt ?? 0),
      period: { month, year },
      by_entity: byEntity,
    };
  }

  /**
   * 12-month revenue/VAT trend for the group, inter-company excluded.
   */
  static async getTrend(
    userId: string,
    organizationId: string,
  ): Promise<GroupTrend[]> {
    const accessTaxCodes = await this.assertUserAccessToOrg(userId, organizationId);
    if (accessTaxCodes.length === 0) return [];

    const { rows } = await pool.query<{
      month: string;
      year: string;
      output_total: string;
      input_total: string;
      output_vat: string;
      input_vat: string;
      payable_vat: string;
      excluded_inter_company: string;
    }>(
      `WITH org_tax_codes AS (
         SELECT c.tax_code FROM companies c
         WHERE c.organization_id = $1 AND c.deleted_at IS NULL
       )
       SELECT
         EXTRACT(MONTH FROM i.invoice_date)::int AS month,
         EXTRACT(YEAR  FROM i.invoice_date)::int AS year,
         COALESCE(SUM(i.total_amount) FILTER (
           WHERE i.direction = 'output'
             AND i.buyer_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0) AS output_total,
         COALESCE(SUM(i.total_amount) FILTER (
           WHERE i.direction = 'input'
             AND i.seller_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0) AS input_total,
         COALESCE(SUM(i.vat_amount) FILTER (
           WHERE i.direction = 'output'
             AND i.buyer_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0) AS output_vat,
         COALESCE(SUM(i.vat_amount) FILTER (
           WHERE i.direction = 'input'
             AND i.seller_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
         ), 0) AS input_vat,
         COALESCE(
           SUM(i.vat_amount) FILTER (
             WHERE i.direction = 'output'
               AND i.buyer_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
           ) -
           SUM(i.vat_amount) FILTER (
             WHERE i.direction = 'input'
               AND i.seller_tax_code NOT IN (SELECT tax_code FROM org_tax_codes)
           ), 0
         ) AS payable_vat,
         COUNT(*) FILTER (
           WHERE i.direction = 'output'
             AND i.buyer_tax_code IN (SELECT tax_code FROM org_tax_codes)
         ) AS excluded_inter_company
       FROM invoices i
       JOIN companies c ON c.id = i.company_id
       WHERE c.organization_id = $1
         AND i.invoice_date >= NOW() - INTERVAL '11 months'
         AND i.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND i.status != 'cancelled'
       GROUP BY 1, 2
       ORDER BY 2 ASC, 1 ASC`,
      [organizationId],
    );

    return rows.map((r) => ({
      month:                  Number(r.month),
      year:                   Number(r.year),
      output_total:           Number(r.output_total),
      input_total:            Number(r.input_total),
      output_vat:             Number(r.output_vat),
      input_vat:              Number(r.input_vat),
      payable_vat:            Number(r.payable_vat),
      excluded_inter_company: Number(r.excluded_inter_company),
    }));
  }
}
