/**
 * CashPaymentDetector — P50.1
 *
 * Flags input invoices ≥ 5,000,000 VND with unknown or cash payment method,
 * as they are NOT deductible for VAT under Điều 26 NĐ181/2025/NĐ-CP.
 *
 * Invoices with is_cash_payment_risk=true are EXCLUDED from CT23 (deductible input VAT)
 * unless the user explicitly acknowledges via cash_risk_acknowledged=true.
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export const CASH_THRESHOLD_VND = 5_000_000; // Điều 26 NĐ181/2025

export interface CashScanResult {
  riskyCount:    number;
  totalVatAtRisk: number;
  breakdown: {
    cash:    number;  // payment_method='cash'
    unknown: number;  // payment_method IS NULL
  };
  invoices: Array<{
    id: string; invoice_number: string; seller_name: string; seller_tax_code: string;
    total_amount: string; vat_amount: string; invoice_date: Date; payment_method: string | null;
  }>;
}

export class CashPaymentDetector {

  /** Scan invoices for a given company/period and flag new risky ones. */
  async scanCompany(
    companyId: string,
    month?: number,
    year?: number,
  ): Promise<CashScanResult> {
    const whereParts = [
      `company_id = $1`,
      `direction = 'input'`,
      `status = 'valid'`,
      `deleted_at IS NULL`,
      `total_amount >= $2`,
      `(payment_method = 'cash' OR payment_method IS NULL)`,
    ];
    const params: unknown[] = [companyId, CASH_THRESHOLD_VND];

    if (month) { whereParts.push(`EXTRACT(MONTH FROM invoice_date) = $${params.length + 1}`); params.push(month); }
    if (year)  { whereParts.push(`EXTRACT(YEAR  FROM invoice_date) = $${params.length + 1}`); params.push(year); }

    const result = await pool.query(
      `SELECT id, invoice_number, seller_name, seller_tax_code,
              total_amount, vat_amount, invoice_date, payment_method
       FROM invoices
       WHERE ${whereParts.join(' AND ')}
       ORDER BY invoice_date DESC`,
      params,
    );

    const risky = result.rows;
    if (risky.length > 0) {
      await pool.query(
        `UPDATE invoices SET is_cash_payment_risk = true
         WHERE id = ANY($1::uuid[])`,
        [risky.map((i: { id: string }) => i.id)],
      );
    }

    const totalVatAtRisk = risky.reduce(
      (sum: number, i: { vat_amount: string }) => sum + parseFloat(i.vat_amount ?? '0'), 0
    );

    return {
      riskyCount:    risky.length,
      totalVatAtRisk,
      breakdown: {
        cash:    risky.filter((i: { payment_method: string | null }) => i.payment_method === 'cash').length,
        unknown: risky.filter((i: { payment_method: string | null }) => i.payment_method === null).length,
      },
      invoices: risky,
    };
  }

  /** User declares the payment method for a single invoice. */
  async setPaymentMethod(
    invoiceId: string,
    method: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'mixed',
    userId: string,
    companyId: string,
  ): Promise<void> {
    const isRisk = method === 'cash';
    await pool.query(
      `UPDATE invoices
       SET payment_method        = $1,
           payment_method_source = 'user_input',
           is_cash_payment_risk  = $2,
           updated_at            = NOW()
       WHERE id = $3 AND company_id = $4`,
      [method, isRisk, invoiceId, companyId],
    );
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, company_id, entity_type, entity_id, action, metadata, created_at)
       VALUES ($1,$2,$3,'invoice',$4,'SET_PAYMENT_METHOD',$5,NOW())`,
      [uuidv4(), userId, companyId, invoiceId,
       JSON.stringify({ payment_method: method, is_cash_payment_risk: isRisk })],
    );
  }

  /** Bulk-declare payment method for multiple invoices. */
  async bulkSetPaymentMethod(
    invoiceIds: string[],
    method: 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'mixed',
    userId: string,
    companyId: string,
  ): Promise<number> {
    if (invoiceIds.length === 0) return 0;
    if (invoiceIds.length > 500) throw new Error('Maximum 500 invoices per bulk operation');

    const isRisk = method === 'cash';
    const res = await pool.query(
      `UPDATE invoices
       SET payment_method        = $1,
           payment_method_source = 'user_input',
           is_cash_payment_risk  = $2,
           updated_at            = NOW()
       WHERE id = ANY($3::uuid[]) AND company_id = $4`,
      [method, isRisk, invoiceIds, companyId],
    );
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, company_id, entity_type, entity_id, action, metadata, created_at)
       SELECT gen_random_uuid(), $1, $2, 'invoice', unnest($3::uuid[]), 'SET_PAYMENT_METHOD_BULK', $4, NOW()`,
      [userId, companyId, invoiceIds,
       JSON.stringify({ payment_method: method, is_cash_payment_risk: isRisk, bulk: true })],
    );
    return res.rowCount ?? 0;
  }

  /** Acknowledge a cash-risk invoice (user accepts the risk). */
  async acknowledge(invoiceId: string, userId: string, companyId: string, note?: string): Promise<void> {
    await pool.query(
      `UPDATE invoices
       SET cash_risk_acknowledged = true,
           cash_risk_note         = $1,
           updated_at             = NOW()
       WHERE id = $2 AND company_id = $3`,
      [note ?? null, invoiceId, companyId],
    );
  }

  /** Summary for dashboard widget / declaration badge. */
  async getSummary(companyId: string, month?: number, year?: number): Promise<{
    riskyCount: number; totalVatAtRisk: number; unknownCount: number;
  }> {
    const whereParts = [
      `company_id = $1`,
      `direction = 'input'`,
      `is_cash_payment_risk = true`,
      `cash_risk_acknowledged = false`,
      `deleted_at IS NULL`,
    ];
    const params: unknown[] = [companyId];
    if (month) { whereParts.push(`EXTRACT(MONTH FROM invoice_date) = $${params.length + 1}`); params.push(month); }
    if (year)  { whereParts.push(`EXTRACT(YEAR  FROM invoice_date) = $${params.length + 1}`); params.push(year); }

    const res = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(vat_amount),0) AS total_vat,
              COUNT(*) FILTER (WHERE payment_method IS NULL)::int AS unknown_count
       FROM invoices WHERE ${whereParts.join(' AND ')}`,
      params,
    );
    const row = res.rows[0];
    return {
      riskyCount:    row?.count      ?? 0,
      totalVatAtRisk: parseFloat(row?.total_vat ?? '0'),
      unknownCount:  row?.unknown_count ?? 0,
    };
  }
}

export const cashPaymentDetector = new CashPaymentDetector();
