import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

/**
 * GET /api/compare?companyIds=id1,id2,id3&month=3&year=2026
 * Returns aggregated stats for each company in a single query.
 * Max 6 companies allowed.
 */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { companyIds: rawIds, month, year } = req.query as Record<string, string>;

  if (!rawIds) throw new AppError('companyIds is required', 400, 'VALIDATION_ERROR');
  const ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
  if (ids.length < 2) throw new AppError('At least 2 companyIds required', 400, 'VALIDATION_ERROR');

  const m = parseInt(month ?? String(new Date().getMonth() + 1), 10);
  const y = parseInt(year ?? String(new Date().getFullYear()), 10);

  // Verify user has access to all requested companies
  const accessRes = await pool.query(
    `SELECT company_id FROM user_companies WHERE user_id = $1 AND company_id = ANY($2::uuid[])`,
    [userId, ids],
  );
  const accessible = new Set(accessRes.rows.map((r: { company_id: string }) => r.company_id));
  const denied = ids.filter((id) => !accessible.has(id));
  if (denied.length > 0) throw new AppError('Access denied to some companies', 403, 'FORBIDDEN');

  // Single SQL: current period stats
  const statsRes = await pool.query(
    `SELECT
       c.id, c.name, c.tax_code, c.entity_type,
       COALESCE(o.invoice_count, 0)  AS output_invoices,
       COALESCE(o.subtotal, 0)       AS output_total,
       COALESCE(o.vat_amount, 0)     AS output_vat,
       COALESCE(i.invoice_count, 0)  AS input_invoices,
       COALESCE(i.subtotal, 0)       AS input_total,
       COALESCE(i.vat_amount, 0)     AS input_vat,
       COALESCE(o.vat_amount, 0) - COALESCE(i.vat_amount, 0) AS payable_vat,
       COALESCE(u.unvalidated, 0)    AS unvalidated_count
     FROM companies c
     LEFT JOIN (
       SELECT company_id,
              COUNT(*)          AS invoice_count,
              SUM(subtotal)     AS subtotal,
              SUM(vat_amount)   AS vat_amount
       FROM invoices
       WHERE direction = 'output' AND status = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR  FROM invoice_date) = $3
         AND company_id = ANY($1::uuid[])
       GROUP BY company_id
     ) o ON c.id = o.company_id
     LEFT JOIN (
       SELECT company_id,
              COUNT(*)          AS invoice_count,
              SUM(subtotal)     AS subtotal,
              SUM(vat_amount)   AS vat_amount
       FROM invoices
       WHERE direction = 'input' AND status = 'valid'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR  FROM invoice_date) = $3
         AND company_id = ANY($1::uuid[])
       GROUP BY company_id
     ) i ON c.id = i.company_id
     LEFT JOIN (
       SELECT company_id, COUNT(*) AS unvalidated
       FROM invoices
       WHERE gdt_validated = false AND status != 'cancelled'
         AND deleted_at IS NULL
         AND company_id = ANY($1::uuid[])
       GROUP BY company_id
     ) u ON c.id = u.company_id
     WHERE c.id = ANY($1::uuid[])
     ORDER BY o.subtotal DESC NULLS LAST`,
    [ids, m, y],
  );

  // 12-month trend per company (single query)
  const trendRes = await pool.query(
    `SELECT
       company_id,
       EXTRACT(MONTH FROM invoice_date)::int AS month,
       EXTRACT(YEAR  FROM invoice_date)::int AS year,
       SUM(CASE WHEN direction='output' THEN subtotal   ELSE 0 END) AS output_total,
       SUM(CASE WHEN direction='input'  THEN subtotal   ELSE 0 END) AS input_total,
       SUM(CASE WHEN direction='output' THEN vat_amount ELSE 0 END) AS output_vat,
       SUM(CASE WHEN direction='input'  THEN vat_amount ELSE 0 END) AS input_vat
     FROM invoices
     WHERE company_id = ANY($1::uuid[])
       AND status = 'valid'
       AND deleted_at IS NULL
       AND invoice_date >= NOW() - INTERVAL '12 months'
     GROUP BY company_id, EXTRACT(MONTH FROM invoice_date), EXTRACT(YEAR FROM invoice_date)
     ORDER BY year, month`,
    [ids],
  );

  // Group trend rows by company
  const trendByCompany: Record<string, unknown[]> = {};
  for (const row of trendRes.rows as Array<{ company_id: string }>) {
    if (!trendByCompany[row.company_id]) trendByCompany[row.company_id] = [];
    trendByCompany[row.company_id].push(row);
  }

  sendSuccess(res, {
    period: { month: m, year: y },
    companies: statsRes.rows,
    trend: trendByCompany,
  });
});

export default router;
