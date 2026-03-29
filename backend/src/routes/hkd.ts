/**
 * Group 41 — HKD routes
 * Ho kinh doanh / ca nhan declaration and tax settings.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const HKD_MONTHLY_THRESHOLD = 8_330_000; // VND — mandatory declaration if exceeded

// GET /api/hkd/tax-statement?month=&year=
router.get('/tax-statement', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  if (month < 1 || month > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  // Fetch company tax settings
  const compAny = await pool.query<{
    business_type: string; tax_regime: string; vat_rate_hkd: string;
  }>(
    `SELECT COALESCE(business_type,'DN') AS business_type,
            COALESCE(tax_regime,'khau_tru') AS tax_regime,
            COALESCE(vat_rate_hkd,1.0) AS vat_rate_hkd
     FROM companies WHERE id=$1`,
    [companyId],
  );
  const comp = compAny.rows[0];
if (!comp) throw new AppError('Company not found', 404, 'NOT_FOUND');

  // Fetch existing statement if any
  const existing = await pool.query(
    `SELECT * FROM hkd_tax_statements WHERE company_id=$1 AND period_month=$2 AND period_year=$3`,
    [companyId, month, year],
  );

  // Calculate revenue for the period
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = new Date(year, month, 0).toISOString().split('T')[0];

  const revRes = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
     WHERE company_id=$1 AND direction='output' AND status='valid'
       AND deleted_at IS NULL
       AND invoice_date BETWEEN $2 AND $3`,
    [companyId, startDate, endDate],
  );
  const revenue = Number(revRes.rows[0]?.total ?? 0);
  const vatRate = Number(comp.vat_rate_hkd);
  const vatPayable = comp.tax_regime === 'khoan' ? Math.round(revenue * vatRate / 100) : 0;
  const pitPayable = ['HKD','HND','CA_NHAN'].includes(comp.business_type)
    ? Math.round(revenue * 0.005)
    : 0;
  const totalPayable = vatPayable + pitPayable;
  const mustDeclare = revenue > HKD_MONTHLY_THRESHOLD;

  sendSuccess(res, {
    period: { month, year },
    company_type: comp.business_type,
    tax_regime: comp.tax_regime,
    vat_rate_hkd: vatRate,
    revenue,
    vat_payable: vatPayable,
    pit_payable: pitPayable,
    total_payable: totalPayable,
    must_declare: mustDeclare,
    threshold: HKD_MONTHLY_THRESHOLD,
    saved_statement: existing.rows[0] ?? null,
  });
});

// POST /api/hkd/generate  — generate & save HKD tax statement
router.post('/generate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year } = req.body as { month?: number; year?: number };
  const m = parseInt(String(month)) || new Date().getMonth() + 1;
  const y = parseInt(String(year)) || new Date().getFullYear();
  if (m < 1 || m > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = new Date(y, m, 0).toISOString().split('T')[0];

  const [compAny, revRes] = await Promise.all([
    pool.query<{ vat_rate_hkd: string; tax_regime: string; business_type: string }>(
      `SELECT COALESCE(vat_rate_hkd,1.0) AS vat_rate_hkd,
              COALESCE(tax_regime,'khoan') AS tax_regime,
              COALESCE(business_type,'HKD') AS business_type
       FROM companies WHERE id=$1`,
      [companyId],
    ),
    pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
       WHERE company_id=$1 AND direction='output' AND status='valid'
         AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3`,
      [companyId, startDate, endDate],
    ),
  ]);

  const comp = compAny.rows[0];
  if (!comp) throw new AppError('Company not found', 404, 'NOT_FOUND');
  const revenue = Number(revRes.rows[0]?.total ?? 0);
  const vatRate = Number(comp.vat_rate_hkd);
  const vatPayable = comp.tax_regime === 'khoan' ? Math.round(revenue * vatRate / 100) : 0;
  const pitPayable = Math.round(revenue * 0.005);
  const totalPayable = vatPayable + pitPayable;

  const { rows } = await pool.query(
    `INSERT INTO hkd_tax_statements
       (company_id, period_month, period_year, revenue, vat_rate, vat_payable, pit_payable, total_payable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (company_id, period_month, period_year) DO UPDATE SET
       revenue=$4, vat_rate=$5, vat_payable=$6, pit_payable=$7, total_payable=$8, generated_at=NOW()
     RETURNING *`,
    [companyId, m, y, revenue, vatRate, vatPayable, pitPayable, totalPayable],
  );

  sendSuccess(res, rows[0], 'HKD tax statement generated');
});

// PATCH /api/hkd/settings  — update company tax type settings
router.patch('/settings', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { business_type, tax_regime, vat_rate_hkd } = req.body as Record<string, unknown>;

  const validBusinessTypes = ['DN','HKD','HND','CA_NHAN'];
  const validTaxRegimes = ['khoan','thuc_te','khau_tru'];

  if (business_type && !validBusinessTypes.includes(String(business_type))) {
    throw new AppError(`business_type must be one of: ${validBusinessTypes.join(', ')}`, 400, 'VALIDATION');
  }
  if (tax_regime && !validTaxRegimes.includes(String(tax_regime))) {
    throw new AppError(`tax_regime must be one of: ${validTaxRegimes.join(', ')}`, 400, 'VALIDATION');
  }
  if (vat_rate_hkd !== undefined && (Number(vat_rate_hkd) < 0 || Number(vat_rate_hkd) > 100)) {
    throw new AppError('vat_rate_hkd must be 0-100', 400, 'VALIDATION');
  }

  const { rows } = await pool.query(
    `UPDATE companies SET
       business_type=COALESCE($2::business_type_enum, business_type),
       tax_regime=COALESCE($3::tax_regime_enum, tax_regime),
       vat_rate_hkd=COALESCE($4, vat_rate_hkd),
       updated_at=NOW()
     WHERE id=$1
     RETURNING id, name, business_type, tax_regime, vat_rate_hkd`,
    [companyId,
     business_type ? String(business_type) : null,
     tax_regime ? String(tax_regime) : null,
     vat_rate_hkd !== undefined ? Number(vat_rate_hkd) : null],
  );
  if (!rows.length) throw new AppError('Company not found', 404, 'NOT_FOUND');
  sendSuccess(res, rows[0]);
});

export default router;
