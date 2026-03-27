import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { pool } from '../db/pool';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/cashflow/projection?days=90
router.get('/projection', async (req, res) => {
  const companyId = req.user!.companyId!;
  const days = Math.min(Number(req.query.days) || 90, 90);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + days);

  // AR: output invoices unpaid
  const arRes = await pool.query<{
    due_date: string;
    expected_in: string;
  }>(
    `SELECT
       COALESCE(payment_due_date, invoice_date + INTERVAL '30 days')::date AS due_date,
       SUM(total_amount) AS expected_in
     FROM invoices
     WHERE company_id = $1
       AND direction = 'output'
       AND status != 'cancelled'
       AND payment_date IS NULL
       AND COALESCE(payment_due_date, invoice_date + INTERVAL '30 days') BETWEEN $2 AND $3
     GROUP BY due_date
     ORDER BY due_date`,
    [companyId, today, horizon],
  );

  // AP: input invoices unpaid
  const apRes = await pool.query<{
    due_date: string;
    expected_out: string;
  }>(
    `SELECT
       COALESCE(payment_due_date, invoice_date + INTERVAL '30 days')::date AS due_date,
       SUM(total_amount) AS expected_out
     FROM invoices
     WHERE company_id = $1
       AND direction = 'input'
       AND status != 'cancelled'
       AND payment_date IS NULL
       AND COALESCE(payment_due_date, invoice_date + INTERVAL '30 days') BETWEEN $2 AND $3
     GROUP BY due_date
     ORDER BY due_date`,
    [companyId, today, horizon],
  );

  // Tax due: ct41 from latest reconciliation, payable on 20th of next month
  const taxRes = await pool.query<{ payable_vat: string; period_month: number; period_year: number }>(
    `SELECT COALESCE(payable_vat, 0)::numeric AS payable_vat, period_month, period_year
     FROM vat_reconciliations
     WHERE company_id = $1
     ORDER BY period_year DESC, period_month DESC
     LIMIT 1`,
    [companyId],
  );

  const arMap = new Map<string, number>();
  for (const r of arRes.rows) arMap.set(r.due_date.toString().slice(0, 10), Number(r.expected_in));

  const apMap = new Map<string, number>();
  for (const r of apRes.rows) apMap.set(r.due_date.toString().slice(0, 10), Number(r.expected_out));

  // Build tax due date
  let taxAmount = 0;
  let taxDueDate: string | null = null;
  if (taxRes.rows.length > 0 && Number(taxRes.rows[0].payable_vat) > 0) {
    taxAmount = Number(taxRes.rows[0].payable_vat);
    const { period_month, period_year } = taxRes.rows[0];
    const taxDate = new Date(period_year, period_month, 20); // 20th of following month
    taxDueDate = taxDate.toISOString().slice(0, 10);
    if (taxDate >= today && taxDate <= horizon) {
      apMap.set(taxDueDate, (apMap.get(taxDueDate) ?? 0) + taxAmount);
    }
  }

  // Aggregate into daily rows for next `days` days
  const daily: Array<{ date: string; expected_in: number; expected_out: number; net: number; cumulative: number }> = [];
  let cumulative = 0;
  for (let d = 0; d < days; d++) {
    const cur = new Date(today);
    cur.setDate(cur.getDate() + d);
    const key = cur.toISOString().slice(0, 10);
    const inflow = arMap.get(key) ?? 0;
    const outflow = apMap.get(key) ?? 0;
    const net = inflow - outflow;
    cumulative += net;
    if (inflow > 0 || outflow > 0) {
      daily.push({ date: key, expected_in: inflow, expected_out: outflow, net, cumulative });
    }
  }

  // Summary cards
  const ar30 = arRes.rows
    .filter((r) => {
      const d = new Date(r.due_date);
      const lim = new Date(today); lim.setDate(lim.getDate() + 30);
      return d <= lim;
    })
    .reduce((s, r) => s + Number(r.expected_in), 0);

  const ap30 = apRes.rows
    .filter((r) => {
      const d = new Date(r.due_date);
      const lim = new Date(today); lim.setDate(lim.getDate() + 30);
      return d <= lim;
    })
    .reduce((s, r) => s + Number(r.expected_out), 0);

  const net30 = ar30 - ap30 - (taxDueDate ? (new Date(taxDueDate) <= new Date(today.getTime() + 30 * 86_400_000) ? taxAmount : 0) : 0);

  // Overdue AR
  const overdueRes = await pool.query<{
    id: string;
    invoice_number: string;
    counterparty_name: string;
    counterparty_tax_code: string;
    total_amount: string;
    payment_due_date: string;
  }>(
    `SELECT id, invoice_number,
            buyer_name AS counterparty_name, buyer_tax_code AS counterparty_tax_code,
            total_amount,
            COALESCE(payment_due_date, invoice_date + INTERVAL '30 days')::date AS payment_due_date
     FROM invoices
     WHERE company_id = $1
       AND direction = 'output'
       AND status != 'cancelled'
       AND payment_date IS NULL
       AND COALESCE(payment_due_date, invoice_date + INTERVAL '30 days') < $2
     ORDER BY payment_due_date ASC
     LIMIT 20`,
    [companyId, today],
  );

  sendSuccess(res, {
    daily,
    summary: { ar_30: ar30, ap_30: ap30, tax_due: taxAmount, net_30: net30 },
    overdue_ar: overdueRes.rows,
    tax_due_date: taxDueDate,
  });
});

export default router;
