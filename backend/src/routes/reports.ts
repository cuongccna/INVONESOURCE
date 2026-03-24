import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { VatDeclarationGenerator } from '../reports/VatDeclarationGenerator';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const periodSchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2020).max(2100),
});

// GET /api/reports/pl011?month=&year= — Bảng kê bán ra (output invoices)
router.get('/pl011', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = periodSchema.safeParse(req.query);
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
    const parsed = periodSchema.safeParse(req.query);
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

// GET /api/reports/monthly-summary?month=&year= — JSON data for printable report
router.get('/monthly-summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = periodSchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');

    const { month, year } = parsed.data;
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
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR FROM invoice_date) = $3
         GROUP BY direction`,
        [companyId, month, year]
      ),
      pool.query(
        `SELECT vr.output_vat,
                vr.input_vat,
                vr.payable_vat,
                COALESCE(td.ct43_carry_forward_vat, 0) AS carry_forward_vat
         FROM vat_reconciliations vr
         LEFT JOIN tax_declarations td
           ON td.company_id = vr.company_id
          AND td.period_month = vr.period_month
          AND td.period_year = vr.period_year
         WHERE vr.company_id = $1 AND vr.period_month = $2 AND vr.period_year = $3`,
        [companyId, month, year]
      ),
      pool.query(
        `SELECT direction,
                CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END AS counterparty_name,
                CASE WHEN direction = 'output' THEN buyer_tax_code ELSE seller_tax_code END AS counterparty_tax_code,
                COUNT(*) AS invoice_count,
                SUM(total_amount) AS total_amount
         FROM invoices
         WHERE company_id = $1
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR FROM invoice_date) = $3
           AND status = 'valid'
           AND (CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END) IS NOT NULL
         GROUP BY direction,
                  CASE WHEN direction = 'output' THEN buyer_name ELSE seller_name END,
                  CASE WHEN direction = 'output' THEN buyer_tax_code ELSE seller_tax_code END
         ORDER BY total_amount DESC NULLS LAST
         LIMIT 10`,
        [companyId, month, year]
      ),
    ]);

    sendSuccess(res, {
      period: { month, year },
      company: company.rows[0] ?? null,
      invoiceSummary: invoiceSummary.rows,
      vatReconciliation: vatRecon.rows[0] ?? null,
      topCounterparties: topCounterparties.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
