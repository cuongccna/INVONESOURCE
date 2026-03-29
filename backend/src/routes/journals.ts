/**
 * Group 39 — JOURNAL routes
 * Sales Journal, Purchase Journal, Revenue-Expense report.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';
import { resolvePeriod } from '../utils/period';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/journals/sales?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/sales', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { start, end, month, year } = resolvePeriod(req.query);

  const { rows } = await pool.query(
    `SELECT
       i.id, i.invoice_date, i.invoice_number, i.serial_number AS serial,
       i.buyer_name, i.buyer_tax_code,
       i.subtotal, i.vat_amount, i.total_amount,
       i.vat_rate,
       CASE WHEN i.vat_rate=0   THEN i.subtotal ELSE 0 END AS dt_0pct,
       CASE WHEN i.vat_rate=5   THEN i.subtotal ELSE 0 END AS dt_5pct,
       CASE WHEN i.vat_rate=8   THEN i.subtotal ELSE 0 END AS dt_8pct,
       CASE WHEN i.vat_rate=10  THEN i.subtotal ELSE 0 END AS dt_10pct,
       CASE WHEN i.vat_rate=0   THEN i.vat_amount ELSE 0 END AS vat_0pct,
       CASE WHEN i.vat_rate=5   THEN i.vat_amount ELSE 0 END AS vat_5pct,
       CASE WHEN i.vat_rate=8   THEN i.vat_amount ELSE 0 END AS vat_8pct,
       CASE WHEN i.vat_rate=10  THEN i.vat_amount ELSE 0 END AS vat_10pct
     FROM invoices i
     WHERE i.company_id=$1 AND i.direction='output' AND i.status='valid'
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN $2 AND $3
     ORDER BY i.invoice_date, i.invoice_number`,
    [companyId, start, end],
  );

  const totals = rows.reduce(
    (acc, r) => ({
      subtotal: acc.subtotal + Number(r.subtotal),
      vat_amount: acc.vat_amount + Number(r.vat_amount),
      total_amount: acc.total_amount + Number(r.total_amount),
      dt_0pct: acc.dt_0pct + Number(r.dt_0pct),
      dt_5pct: acc.dt_5pct + Number(r.dt_5pct),
      dt_8pct: acc.dt_8pct + Number(r.dt_8pct),
      dt_10pct: acc.dt_10pct + Number(r.dt_10pct),
      vat_0pct: acc.vat_0pct + Number(r.vat_0pct),
      vat_5pct: acc.vat_5pct + Number(r.vat_5pct),
      vat_8pct: acc.vat_8pct + Number(r.vat_8pct),
      vat_10pct: acc.vat_10pct + Number(r.vat_10pct),
    }),
    { subtotal: 0, vat_amount: 0, total_amount: 0,
      dt_0pct: 0, dt_5pct: 0, dt_8pct: 0, dt_10pct: 0,
      vat_0pct: 0, vat_5pct: 0, vat_8pct: 0, vat_10pct: 0 },
  );

  sendSuccess(res, { invoices: rows, totals, period: { month, year } });
});

// GET /api/journals/purchase?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/purchase', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { start, end, month, year } = resolvePeriod(req.query);

  const { rows } = await pool.query(
    `SELECT
       i.id, i.invoice_date, i.invoice_number, i.serial_number AS serial,
       i.seller_name, i.seller_tax_code,
       i.subtotal, i.vat_amount, i.total_amount,
       i.vat_rate, i.gdt_validated,
       CASE WHEN i.vat_rate=0   THEN i.subtotal ELSE 0 END AS dt_0pct,
       CASE WHEN i.vat_rate=5   THEN i.subtotal ELSE 0 END AS dt_5pct,
       CASE WHEN i.vat_rate=8   THEN i.subtotal ELSE 0 END AS dt_8pct,
       CASE WHEN i.vat_rate=10  THEN i.subtotal ELSE 0 END AS dt_10pct,
       CASE WHEN i.vat_rate=0   THEN i.vat_amount ELSE 0 END AS vat_0pct,
       CASE WHEN i.vat_rate=5   THEN i.vat_amount ELSE 0 END AS vat_5pct,
       CASE WHEN i.vat_rate=8   THEN i.vat_amount ELSE 0 END AS vat_8pct,
       CASE WHEN i.vat_rate=10  THEN i.vat_amount ELSE 0 END AS vat_10pct
     FROM invoices i
     WHERE i.company_id=$1 AND i.direction='input' AND i.status='valid'
       AND i.deleted_at IS NULL
       AND i.invoice_date BETWEEN $2 AND $3
     ORDER BY i.invoice_date, i.invoice_number`,
    [companyId, start, end],
  );

  const totals = rows.reduce(
    (acc, r) => ({
      subtotal: acc.subtotal + Number(r.subtotal),
      vat_amount: acc.vat_amount + Number(r.vat_amount),
      total_amount: acc.total_amount + Number(r.total_amount),
      dt_0pct: acc.dt_0pct + Number(r.dt_0pct),
      dt_5pct: acc.dt_5pct + Number(r.dt_5pct),
      dt_8pct: acc.dt_8pct + Number(r.dt_8pct),
      dt_10pct: acc.dt_10pct + Number(r.dt_10pct),
      vat_0pct: acc.vat_0pct + Number(r.vat_0pct),
      vat_5pct: acc.vat_5pct + Number(r.vat_5pct),
      vat_8pct: acc.vat_8pct + Number(r.vat_8pct),
      vat_10pct: acc.vat_10pct + Number(r.vat_10pct),
    }),
    { subtotal: 0, vat_amount: 0, total_amount: 0,
      dt_0pct: 0, dt_5pct: 0, dt_8pct: 0, dt_10pct: 0,
      vat_0pct: 0, vat_5pct: 0, vat_8pct: 0, vat_10pct: 0 },
  );

  sendSuccess(res, { invoices: rows, totals, period: { month, year } });
});

// GET /api/journals/revenue-expense?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/revenue-expense', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { start, end, month, year } = resolvePeriod(req.query);

  // Revenue by VAT rate
  const revenueByRate = await pool.query(
    `SELECT vat_rate,
       SUM(subtotal) AS subtotal, SUM(vat_amount) AS vat_amount, SUM(total_amount) AS total_amount,
       COUNT(*) AS invoice_count
     FROM invoices WHERE company_id=$1 AND direction='output' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     GROUP BY vat_rate ORDER BY vat_rate`,
    [companyId, start, end],
  );

  // Expense by VAT rate
  const expenseByRate = await pool.query(
    `SELECT vat_rate,
       SUM(subtotal) AS subtotal, SUM(vat_amount) AS vat_amount, SUM(total_amount) AS total_amount,
       COUNT(*) AS invoice_count
     FROM invoices WHERE company_id=$1 AND direction='input' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     GROUP BY vat_rate ORDER BY vat_rate`,
    [companyId, start, end],
  );

  // Top customers
  const topCustomers = await pool.query(
    `SELECT buyer_name, buyer_tax_code,
       SUM(subtotal) AS total_revenue, COUNT(*) AS invoice_count
     FROM invoices WHERE company_id=$1 AND direction='output' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     GROUP BY buyer_name, buyer_tax_code ORDER BY total_revenue DESC LIMIT 10`,
    [companyId, start, end],
  );

  // Top suppliers
  const topSuppliers = await pool.query(
    `SELECT seller_name, seller_tax_code,
       SUM(subtotal) AS total_spend, COUNT(*) AS invoice_count
     FROM invoices WHERE company_id=$1 AND direction='input' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3
     GROUP BY seller_name, seller_tax_code ORDER BY total_spend DESC LIMIT 10`,
    [companyId, start, end],
  );

  sendSuccess(res, {
    period: { month, year },
    revenue_by_rate: revenueByRate.rows,
    expense_by_rate: expenseByRate.rows,
    top_customers: topCustomers.rows,
    top_suppliers: topSuppliers.rows,
  });
});

export default router;
