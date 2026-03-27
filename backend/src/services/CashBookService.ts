/**
 * Group 38 — CASH-01: Cash Book Service
 * Manages cash book entries (receipts & payments).
 * Auto-populates from paid invoices; supports manual entries.
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export interface CashBookEntry {
  id: string;
  entry_type: 'receipt' | 'payment' | 'transfer' | 'opening';
  entry_date: string;
  amount: number;
  description: string | null;
  partner_name: string | null;
  partner_tax_code: string | null;
  invoice_id: string | null;
  reference_number: string | null;
  category: string | null;
  payment_method: string;
  bank_account: string | null;
  is_auto_generated: boolean;
  running_balance: number;
}

export class CashBookService {
  /** Auto-create or update cash entry when an invoice payment_date is set. */
  async syncFromInvoice(invoiceId: string): Promise<void> {
    const inv = await pool.query<{
      id: string; company_id: string; direction: string; payment_date: string | null;
      total_amount: string; seller_name: string; seller_tax_code: string;
      buyer_name: string; buyer_tax_code: string; invoice_number: string;
      payment_method: string | null;
    }>(
      `SELECT id, company_id, direction, payment_date, total_amount,
              seller_name, seller_tax_code, buyer_name, buyer_tax_code,
              invoice_number, payment_method
       FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    if (!inv.rows.length || !inv.rows[0]!.payment_date) return;

    const i = inv.rows[0]!;
    const entryType = i.direction === 'output' ? 'receipt' : 'payment';
    const partnerName = i.direction === 'output' ? i.buyer_name : i.seller_name;
    const partnerTax = i.direction === 'output' ? i.buyer_tax_code : i.seller_tax_code;
    const category = i.direction === 'output' ? 'bán hàng' : 'mua hàng';
    const desc = `${i.direction === 'output' ? 'Thu tiền HĐ' : 'Chi tiền HĐ'} ${i.invoice_number}`;
    const method = i.payment_method ?? 'bank_transfer';

    // Upsert — one entry per invoice
    await pool.query(
      `INSERT INTO cash_book_entries
         (id, company_id, entry_type, entry_date, amount, description, partner_name, partner_tax_code,
          invoice_id, category, payment_method, is_auto_generated)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,true)
       ON CONFLICT (invoice_id) DO UPDATE SET
         entry_date = EXCLUDED.entry_date,
         amount = EXCLUDED.amount,
         description = EXCLUDED.description,
         payment_method = EXCLUDED.payment_method,
         updated_at = NOW()
       WHERE cash_book_entries.is_auto_generated = true`,
      [uuidv4(), i.company_id, entryType, i.payment_date, Number(i.total_amount),
       desc, partnerName, partnerTax, invoiceId, category, method],
    );
    await this.recalcRunningBalance(i.company_id, i.payment_date!);
  }

  /** Get cash book entries for a period, optionally filtered by payment_method. */
  async getEntries(
    companyId: string,
    month: number,
    year: number,
    method?: string,
  ): Promise<{ entries: CashBookEntry[]; opening_balance: number; total_receipt: number; total_payment: number }> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    // Opening balance = running_balance of last entry before period
    const ob = await pool.query<{ running_balance: string }>(
      `SELECT running_balance FROM cash_book_entries
       WHERE company_id=$1 AND entry_date < $2 AND is_deleted=false
       ORDER BY entry_date DESC, id DESC LIMIT 1`,
      [companyId, startDate],
    );
    const openingBalance = Number(ob.rows[0]?.running_balance ?? 0);

    const methodClause = method && method !== 'all' ? `AND payment_method = '${method.replace(/'/g, "''")}'` : '';
    const { rows } = await pool.query<CashBookEntry>(
      `SELECT id, entry_type, entry_date::text, amount::float, description, partner_name, partner_tax_code,
              invoice_id, reference_number, category, payment_method, bank_account,
              is_auto_generated, running_balance::float
       FROM cash_book_entries
       WHERE company_id=$1 AND entry_date BETWEEN $2 AND $3 AND is_deleted=false
         ${methodClause}
       ORDER BY entry_date ASC, created_at ASC`,
      [companyId, startDate, endDate],
    );

    const totalReceipt = rows.filter((r) => r.entry_type === 'receipt').reduce((s, r) => s + r.amount, 0);
    const totalPayment = rows.filter((r) => r.entry_type === 'payment').reduce((s, r) => s + r.amount, 0);

    return { entries: rows, opening_balance: openingBalance, total_receipt: totalReceipt, total_payment: totalPayment };
  }

  /** Add a manual entry. */
  async addEntry(
    companyId: string,
    data: {
      entry_type: string; entry_date: string; amount: number; description?: string;
      partner_name?: string; partner_tax_code?: string; reference_number?: string;
      category?: string; payment_method?: string; bank_account?: string;
    },
    createdBy: string,
  ): Promise<string> {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO cash_book_entries
         (id, company_id, entry_type, entry_date, amount, description, partner_name, partner_tax_code,
          reference_number, category, payment_method, bank_account, is_auto_generated, created_by)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,false,$13)`,
      [id, companyId, data.entry_type, data.entry_date, data.amount, data.description ?? null,
       data.partner_name ?? null, data.partner_tax_code ?? null, data.reference_number ?? null,
       data.category ?? 'khác', data.payment_method ?? 'cash', data.bank_account ?? null, createdBy],
    );
    await this.recalcRunningBalance(companyId, data.entry_date);
    return id;
  }

  /** Update a manual entry. */
  async updateEntry(companyId: string, entryId: string, data: Partial<{
    entry_date: string; amount: number; description: string; category: string;
    payment_method: string; reference_number: string;
  }>): Promise<void> {
    const fields: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(data)) {
      fields.push(`${k} = $${idx++}`);
      vals.push(v);
    }
    fields.push(`updated_at = NOW()`);
    vals.push(entryId, companyId);
    await pool.query(
      `UPDATE cash_book_entries SET ${fields.join(', ')} WHERE id=$${idx} AND company_id=$${idx + 1} AND is_auto_generated=false`,
      vals,
    );
    if (data.entry_date) await this.recalcRunningBalance(companyId, data.entry_date);
  }

  /** Soft-delete a manual entry. */
  async deleteEntry(companyId: string, entryId: string): Promise<void> {
    const res = await pool.query<{ entry_date: string }>(
      `UPDATE cash_book_entries SET is_deleted=true, updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND is_auto_generated=false RETURNING entry_date::text`,
      [entryId, companyId],
    );
    if (res.rows[0]) await this.recalcRunningBalance(companyId, res.rows[0].entry_date);
  }

  /** Recalculate running_balance for all entries >= fromDate for a company. */
  async recalcRunningBalance(companyId: string, fromDate: string): Promise<void> {
    // Opening balance = sum before fromDate
    const ob = await pool.query<{ bal: string }>(
      `SELECT COALESCE(SUM(CASE WHEN entry_type IN ('receipt','opening','transfer') THEN amount ELSE -amount END),0) AS bal
       FROM cash_book_entries WHERE company_id=$1 AND entry_date < $2 AND is_deleted=false`,
      [companyId, fromDate],
    );
    const startBal = Number(ob.rows[0]?.bal ?? 0);

    // Update running_balance with window function from fromDate onward
    await pool.query(
      `UPDATE cash_book_entries AS target
       SET running_balance = sub.running_balance
       FROM (
         SELECT id,
           $2::numeric + SUM(
             CASE WHEN entry_type IN ('receipt','opening','transfer') THEN amount ELSE -amount END
           ) OVER (ORDER BY entry_date, created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           AS running_balance
         FROM cash_book_entries
         WHERE company_id = $1 AND entry_date >= $3 AND is_deleted = false
       ) sub
       WHERE target.id = sub.id`,
      [companyId, startBal, fromDate],
    );
  }
}

export const cashBookService = new CashBookService();
