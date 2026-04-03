/**
 * MissingInvoiceFinder — P50.4
 *
 * Detects input invoices that should exist but are absent from the DB.
 *
 * Strategy A — Cross-company (both buyer and seller managed by same user):
 *   When DN A's output invoice lists DN B as buyer, check if DN B has a
 *   corresponding input invoice from DN A.
 *
 * Strategy B — GDT mismatch:
 *   Compare the DB count of input invoices vs the total count reported by the
 *   last GDT bot run (stored in gdt_bot_runs.input_count).
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export interface MismatchResult {
  dbCount:      number;
  gdtCount:     number;
  missingCount: number;
  hasMismatch:  boolean;
}

export class MissingInvoiceFinder {

  /**
   * Strategy A: scan output invoices of all companies owned by userId and check
   * whether recipient companies in the same user portfolio have the matching input.
   */
  async scanCrossCompany(userId: string, month: number, year: number): Promise<number> {
    const userCompanies = await pool.query<{ id: string; tax_code: string }>(
      `SELECT c.id, c.tax_code
       FROM companies c
       JOIN user_companies uc ON c.id = uc.company_id
       WHERE uc.user_id = $1`,
      [userId],
    );

    if (userCompanies.rows.length < 2) return 0;
    const taxCodes = userCompanies.rows.map(c => c.tax_code);
    let alertsCreated = 0;

    for (const company of userCompanies.rows) {
      const otherCodes = taxCodes.filter(tc => tc !== company.tax_code);

      const outInvs = await pool.query<{
        invoice_number: string; invoice_date: Date; buyer_tax_code: string;
        buyer_name: string; total_amount: string; vat_amount: string; seller_tax_code: string;
      }>(
        `SELECT invoice_number, invoice_date, buyer_tax_code, buyer_name,
                total_amount, vat_amount, seller_tax_code
         FROM active_invoices
         WHERE company_id = $1
           AND direction = 'output'
           AND status = 'valid'
           AND buyer_tax_code = ANY($2::text[])
           AND buyer_tax_code != seller_tax_code
           AND EXTRACT(MONTH FROM invoice_date) = $3
           AND EXTRACT(YEAR  FROM invoice_date) = $4`,
        [company.id, otherCodes, month, year],
      );

      for (const outInv of outInvs.rows) {
        const buyerCompany = userCompanies.rows.find(c => c.tax_code === outInv.buyer_tax_code);
        if (!buyerCompany) continue;

        const inputExists = await pool.query<{ id: string }>(
          `SELECT id FROM active_invoices
           WHERE company_id = $1
             AND direction = 'input'
             AND seller_tax_code = $2
             AND invoice_number = $3`,
          [buyerCompany.id, company.tax_code, outInv.invoice_number],
        );

        if ((inputExists.rowCount ?? 0) === 0) {
          await pool.query(
            `INSERT INTO missing_invoice_alerts
               (id, company_id, seller_tax_code, seller_name, expected_invoice_number,
                expected_invoice_date, expected_amount, expected_vat, detection_source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cross_company')
             ON CONFLICT (company_id, seller_tax_code, expected_invoice_number) DO NOTHING`,
            [
              uuidv4(), buyerCompany.id, company.tax_code, outInv.buyer_name,
              outInv.invoice_number, outInv.invoice_date,
              outInv.total_amount, outInv.vat_amount,
            ],
          );
          alertsCreated++;
        }
      }
    }

    return alertsCreated;
  }

  /**
   * Strategy B: compare DB invoice count with GDT bot's last reported total.
   */
  async scanGdtMismatch(companyId: string, month: number, year: number): Promise<MismatchResult> {
    const dbRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM active_invoices
       WHERE company_id=$1 AND direction='input'
         AND EXTRACT(MONTH FROM invoice_date)=$2
         AND EXTRACT(YEAR  FROM invoice_date)=$3`,
      [companyId, month, year],
    );

    const gdtRes = await pool.query<{ input_count: number | null }>(
      `SELECT input_count FROM gdt_bot_runs
       WHERE company_id=$1 AND status='success'
       ORDER BY finished_at DESC LIMIT 1`,
      [companyId],
    );

    const dbCount  = parseInt(dbRes.rows[0]?.count ?? '0', 10);
    const gdtCount = gdtRes.rows[0]?.input_count ?? 0;

    return {
      dbCount,
      gdtCount,
      missingCount: Math.max(0, gdtCount - dbCount),
      hasMismatch:  gdtCount > dbCount,
    };
  }

  /**
   * After a sync, try to auto-resolve open alerts by matching expected invoice numbers.
   * Returns the number of alerts resolved.
   */
  async matchFoundInvoices(companyId: string): Promise<number> {
    const alerts = await pool.query<{
      id: string; seller_tax_code: string; expected_invoice_number: string | null;
    }>(
      `SELECT id, seller_tax_code, expected_invoice_number
       FROM missing_invoice_alerts
       WHERE company_id=$1 AND status='open' AND expected_invoice_number IS NOT NULL`,
      [companyId],
    );

    let matched = 0;
    for (const alert of alerts.rows) {
      if (!alert.expected_invoice_number) continue;
      const found = await pool.query<{ id: string }>(
        `SELECT id FROM active_invoices
         WHERE company_id=$1 AND direction='input'
           AND seller_tax_code=$2 AND invoice_number=$3`,
        [companyId, alert.seller_tax_code, alert.expected_invoice_number],
      );
      if ((found.rowCount ?? 0) > 0) {
        await pool.query(
          `UPDATE missing_invoice_alerts
           SET status='found', found_invoice_id=$1, updated_at=NOW()
           WHERE id=$2`,
          [found.rows[0]!.id, alert.id],
        );
        matched++;
      }
    }
    return matched;
  }

  /** Get open alerts for a company. */
  async getAlerts(companyId: string, status = 'open', page = 1, pageSize = 50): Promise<{
    data: unknown[]; total: number;
  }> {
    const offset = (page - 1) * pageSize;
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM missing_invoice_alerts
         WHERE company_id=$1 AND status=$2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [companyId, status, pageSize, offset],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM missing_invoice_alerts WHERE company_id=$1 AND status=$2`,
        [companyId, status],
      ),
    ]);
    return { data: dataRes.rows, total: parseInt(countRes.rows[0]?.count ?? '0', 10) };
  }

  /** Summary totals for dashboard widget. */
  async getSummary(companyId: string): Promise<{
    openCount: number; totalVatMissing: number;
  }> {
    const res = await pool.query<{ count: string; total_vat: string }>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(SUM(expected_vat),0)::text AS total_vat
       FROM missing_invoice_alerts
       WHERE company_id=$1 AND status='open'`,
      [companyId],
    );
    return {
      openCount:       parseInt(res.rows[0]?.count ?? '0', 10),
      totalVatMissing: parseFloat(res.rows[0]?.total_vat ?? '0'),
    };
  }

  async updateStatus(
    alertId: string,
    companyId: string,
    status: 'found' | 'not_applicable' | 'acknowledged',
    note?: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE missing_invoice_alerts
       SET status=$1, acknowledged_note=$2, updated_at=NOW()
       WHERE id=$3 AND company_id=$4`,
      [status, note ?? null, alertId, companyId],
    );
  }
}

export const missingInvoiceFinder = new MissingInvoiceFinder();
