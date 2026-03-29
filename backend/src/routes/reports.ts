import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { VatDeclarationGenerator } from '../reports/VatDeclarationGenerator';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';
import { resolvePeriod } from '../utils/period';
import { z } from 'zod';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const monthPeriodSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

// GET /api/reports/pl011?month=&year= — Bảng kê bán ra (output invoices)
router.get('/pl011', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = monthPeriodSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');

    const { month, year } = parsed.data;
    const generator = new VatDeclarationGenerator();
    const buffer = await generator.generatePL011(req.user!.companyId!, month, year);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PL01-1_${year}_${String(month).padStart(2, '0')}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/pl012?month=&year= — Bảng kê mua vào (input invoices)
router.get('/pl012', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = monthPeriodSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');

    const { month, year } = parsed.data;
    const generator = new VatDeclarationGenerator();
    const buffer = await generator.generatePL012(req.user!.companyId!, month, year);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PL01-2_${year}_${String(month).padStart(2, '0')}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/monthly-summary?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/monthly-summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start, end, month, year } = resolvePeriod(req.query);
    const companyId = req.user!.companyId!;

    const [company, invoiceSummary, vatRecon, topCounterparties] = await Promise.all([
      pool.query(
        `SELECT name, tax_code, address FROM companies WHERE id = $1`,
        [companyId]
      ),
      pool.query(
        `SELECT
           direction,
           COUNT(*) AS invoice_count,
           SUM(subtotal) AS subtotal,
           SUM(vat_amount) AS vat_total,
           SUM(total_amount) AS total,
           COUNT(*) FILTER (WHERE status = 'valid') AS valid_count,
           COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
           COUNT(*) FILTER (WHERE gdt_validated = false AND status = 'valid') AS unvalidated_count
         FROM invoices
         WHERE company_id = $1
           AND deleted_at IS NULL
           AND invoice_date BETWEEN $2 AND $3
         GROUP BY direction`,
        [companyId, start, end]
      ),
      pool.query(
        `SELECT
           SUM(vr.output_vat) AS output_vat,
           SUM(vr.input_vat) AS input_vat,
           SUM(vr.payable_vat) AS payable_vat,
           SUM(COALESCE(td.ct43_carry_forward_vat, 0)) AS carry_forward_vat
         FROM vat_reconciliations vr
         LEFT JOIN tax_declarations td
           ON td.company_id = vr.company_id
          AND td.period_month = vr.period_month
          AND td.period_year = vr.period_year
         WHERE vr.company_id = $1
           AND MAKE_DATE(vr.period_year::int, vr.period_month::int, 1) BETWEEN $2::date AND $3::date`,
        [companyId, start, end]
      ),
      pool.query(
        `SELECT direction,
                CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END AS counterparty_name,
                CASE WHEN direction = 'output' THEN buyer_tax_code ELSE seller_tax_code END AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount
         FROM invoices
         WHERE company_id = $1
           AND deleted_at IS NULL
           AND invoice_date BETWEEN $2 AND $3
           AND status = 'valid'
           AND (CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END) IS NOT NULL
         GROUP BY direction,
                  CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END,
                  CASE WHEN direction = 'output' THEN buyer_tax_code ELSE seller_tax_code END
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 10`,
        [companyId, start, end]
      ),
    ]);

    sendSuccess(res, {
      period: { month, year },
      company: company.rows[0] ?? null,
      invoiceSummary: invoiceSummary.rows,
      vatReconciliation: vatRecon.rows[0]?.output_vat != null ? vatRecon.rows[0] : null,
      topCounterparties: topCounterparties.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/reports/trends?months=12 — monthly trend aggregates for trend analysis page
router.get('/trends', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const months = Math.min(24, Math.max(3, parseInt(String(req.query['months'] ?? '12'))));
    const companyId = req.user!.companyId!;

    const [monthly, topCustomers, topSuppliers] = await Promise.all([
      pool.query<{
        period_year: number; period_month: number;
        revenue: string; cost: string; output_vat: string; input_vat: string;
        payable_vat: string; invoice_count: string; valid_count: string;
        invalid_count: string; unvalidated_count: string; avg_invoice_value: string;
      }>(
        `SELECT
           EXTRACT(YEAR FROM invoice_date)::int  AS period_year,
           EXTRACT(MONTH FROM invoice_date)::int AS period_month,
           COALESCE(SUM(subtotal) FILTER (WHERE direction='output'), 0)            AS revenue,
           COALESCE(SUM(subtotal) FILTER (WHERE direction='input'), 0)             AS cost,
           COALESCE(SUM(vat_amount) FILTER (WHERE direction='output'), 0)          AS output_vat,
           COALESCE(SUM(vat_amount) FILTER (WHERE direction='input'), 0)           AS input_vat,
           COALESCE(SUM(vat_amount) FILTER (WHERE direction='output'), 0)
             - COALESCE(SUM(vat_amount) FILTER (WHERE direction='input' AND gdt_validated=true), 0)
                                                                                   AS payable_vat,
           COUNT(*)                                                                AS invoice_count,
           COUNT(*) FILTER (WHERE status='valid')                                 AS valid_count,
           COUNT(*) FILTER (WHERE status='cancelled')                             AS invalid_count,
           COUNT(*) FILTER (WHERE gdt_validated=false AND status='valid')         AS unvalidated_count,
           CASE WHEN COUNT(*) > 0 THEN (SUM(total_amount) / COUNT(*)) ELSE 0 END AS avg_invoice_value
         FROM invoices
         WHERE company_id = $1
           AND deleted_at IS NULL
           AND invoice_date >= DATE_TRUNC('month', NOW()) - ($2 - 1) * INTERVAL '1 month'
         GROUP BY period_year, period_month
         ORDER BY period_year, period_month`,
        [companyId, months]
      ),
      pool.query<{ buyer_name: string; total_revenue: string }>(
        `SELECT
           COALESCE(buyer_name, buyer_tax_code) AS buyer_name,
           SUM(total_amount) AS total_revenue
         FROM invoices
         WHERE company_id = $1 AND direction = 'output' AND status = 'valid'
           AND deleted_at IS NULL
           AND invoice_date >= NOW() - INTERVAL '12 months'
           AND buyer_name IS NOT NULL
         GROUP BY COALESCE(buyer_name, buyer_tax_code)
         ORDER BY total_revenue DESC NULLS LAST
         LIMIT 5`,
        [companyId]
      ),
      pool.query<{ seller_name: string; total_spend: string }>(
        `SELECT
           COALESCE(seller_name, seller_tax_code) AS seller_name,
           SUM(total_amount) AS total_spend
         FROM invoices
         WHERE company_id = $1 AND direction = 'input' AND status = 'valid'
           AND deleted_at IS NULL
           AND invoice_date >= NOW() - INTERVAL '12 months'
           AND seller_name IS NOT NULL
         GROUP BY COALESCE(seller_name, seller_tax_code)
         ORDER BY total_spend DESC NULLS LAST
         LIMIT 5`,
        [companyId]
      ),
    ]);

    sendSuccess(res, {
      monthly: monthly.rows,
      topCustomers: topCustomers.rows,
      topSuppliers: topSuppliers.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
