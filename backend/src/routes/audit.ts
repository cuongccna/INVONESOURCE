import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { priceAnomalyDetector } from '../services/PriceAnomalyDetector';
import { ghostCompanyDetector } from '../services/GhostCompanyDetector';
import { taxRateAnomalyDetector } from '../services/TaxRateAnomalyDetector';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// POST /api/audit/scan — trigger anomaly detection
router.post('/scan', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const data = await priceAnomalyDetector.detectAnomalies(companyId);
  sendSuccess(res, { created: data.length, data });
});

// GET /api/audit/anomalies?severity=&unacknowledged=true&page=&pageSize=
router.get('/anomalies', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { severity, unacknowledged, page, pageSize } = req.query as Record<string, string>;
  const currentPage = Number(page ?? 1);
  const currentPageSize = Number(pageSize ?? 50);
  const result = await priceAnomalyDetector.getAnomalies(
    companyId,
    currentPage,
    currentPageSize,
    severity,
    unacknowledged === 'true',
  );

  sendSuccess(res, {
    data: result.data,
    summary: result.summary,
    meta: {
      total: result.total,
      page: currentPage,
      pageSize: currentPageSize,
      totalPages: Math.ceil(result.total / currentPageSize),
    },
  });
});

// PATCH /api/audit/anomalies/:id/acknowledge
router.patch('/anomalies/:id/acknowledge', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const userId = req.user!.userId;
  const anomalyId = req.params.id;
  await priceAnomalyDetector.acknowledge(companyId, anomalyId, userId);
  sendSuccess(res, { ok: true });
});

// GET /api/audit/rules
router.get('/rules', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { rows } = await pool.query(
    `SELECT rule_id, threshold, severity, enabled, exclusions
     FROM audit_rule_configs
     WHERE company_id = $1
     ORDER BY rule_id`,
    [companyId],
  );

  if (rows.length > 0) {
    sendSuccess(res, rows);
    return;
  }

  const settingsRes = await pool.query<{
    audit_price_spike_threshold: string | null;
    audit_new_vendor_threshold: string | null;
    audit_qty_spike_multiplier: string | null;
    audit_round_num_deviation: string | null;
  }>(
    `SELECT audit_price_spike_threshold, audit_new_vendor_threshold,
            audit_qty_spike_multiplier, audit_round_num_deviation
     FROM company_settings WHERE company_id = $1`,
    [companyId],
  );

  const s = settingsRes.rows[0];
  sendSuccess(res, [
    { rule_id: 'price_spike', threshold: Number(s?.audit_price_spike_threshold ?? 20), severity: 'warning', enabled: true, exclusions: [] },
    { rule_id: 'new_vendor', threshold: Number(s?.audit_new_vendor_threshold ?? 50000000), severity: 'warning', enabled: true, exclusions: [] },
    { rule_id: 'qty_spike', threshold: Number(s?.audit_qty_spike_multiplier ?? 2.5), severity: 'warning', enabled: true, exclusions: [] },
    { rule_id: 'round_number', threshold: Number(s?.audit_round_num_deviation ?? 10), severity: 'info', enabled: true, exclusions: [] },
    { rule_id: 'freq_spike', threshold: 2, severity: 'info', enabled: true, exclusions: [] },
    { rule_id: 'cross_vendor', threshold: 20, severity: 'warning', enabled: true, exclusions: [] },
  ]);
});

// PUT /api/audit/rules/:ruleId
router.put('/rules/:ruleId', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId
    ?? (req.headers['x-company-id'] as string | undefined);
  if (!companyId) {
    res.status(400).json({ success: false, error: { code: 'NO_COMPANY', message: 'Company context required' } });
    return;
  }
  const { ruleId } = req.params;
  const { threshold, severity, enabled, exclusions } = req.body as {
    threshold?: number;
    severity?: 'critical' | 'warning' | 'info';
    enabled?: boolean;
    exclusions?: unknown;
  };

  await pool.query(
    `INSERT INTO audit_rule_configs (company_id, rule_id, threshold, severity, enabled, exclusions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (company_id, rule_id) DO UPDATE SET
       threshold   = $3,
       severity    = $4,
       enabled     = $5,
       exclusions  = $6::jsonb,
       updated_at  = NOW()`,
    [
      companyId,
      ruleId,
      threshold ?? 0,
      severity ?? 'warning',
      enabled ?? true,
      JSON.stringify(exclusions ?? []),
    ],
  );

  sendSuccess(res, { ok: true });
});

// ── Ghost Company Detection (GHOST-01 / P43) ─────────────────────────────────

// GET /api/audit/ghost-companies/summary — aggregated counts + total VAT at risk
router.get('/ghost-companies/summary', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const res2 = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE risk_level = 'critical' AND acknowledged_at IS NULL)::int AS critical,
       COUNT(*) FILTER (WHERE risk_level = 'high'     AND acknowledged_at IS NULL)::int AS high,
       COUNT(*) FILTER (WHERE risk_level = 'medium'   AND acknowledged_at IS NULL)::int AS medium,
       COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)::int                         AS acknowledged,
       COUNT(*)::int                                                                     AS total,
       COALESCE(SUM(total_vat_at_risk) FILTER (WHERE acknowledged_at IS NULL), 0)       AS total_vat_at_risk
     FROM company_risk_flags WHERE company_id = $1`,
    [companyId],
  );
  sendSuccess(res, res2.rows[0] ?? { critical: 0, high: 0, medium: 0, acknowledged: 0, total: 0, total_vat_at_risk: 0 });
});

// POST /api/audit/ghost-companies/scan — run ghost detection for active company
router.post('/ghost-companies/scan', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const result = await ghostCompanyDetector.runForCompany(companyId);
  sendSuccess(res, result);
});

// GET /api/audit/ghost-companies — list risk flags with verification cache joined
router.get('/ghost-companies', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { riskLevel, unacknowledged, page, pageSize } = req.query as Record<string, string>;
  const pg   = Number(page ?? 1);
  const pgSz = Number(pageSize ?? 50);
  const offset = (pg - 1) * pgSz;

  const whereClauses = ['f.company_id = $1'];
  const params: unknown[] = [companyId];

  if (riskLevel) {
    params.push(riskLevel);
    whereClauses.push(`f.risk_level = $${params.length}`);
  }
  if (unacknowledged === 'true') {
    whereClauses.push('f.acknowledged_at IS NULL');
  }

  const where = whereClauses.join(' AND ');
  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT f.*,
              v.company_name, v.mst_status AS verified_status, v.address,
              v.registered_date, v.legal_rep, v.business_type, v.verified_at,
              (SELECT COUNT(*)::int FROM invoices i
               WHERE i.company_id = f.company_id
                 AND i.seller_tax_code = f.tax_code
                 AND i.deleted_at IS NULL) AS invoice_count
       FROM company_risk_flags f
       LEFT JOIN company_verification_cache v ON v.tax_code = f.tax_code
       WHERE ${where}
       ORDER BY
         CASE f.risk_level WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         f.acknowledged_at NULLS FIRST,
         f.total_vat_at_risk DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pgSz, offset],
    ),
    pool.query(`SELECT COUNT(*) FROM company_risk_flags f WHERE ${where}`, params),
  ]);

  sendSuccess(res, {
    data: dataRes.rows,
    meta: { total: Number(countRes.rows[0]!.count), page: pg, pageSize: pgSz, totalPages: Math.ceil(Number(countRes.rows[0]!.count) / pgSz) },
  });
});

// GET /api/audit/ghost-companies/:taxCode/detail — full detail for one partner
router.get('/ghost-companies/:taxCode/detail', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { taxCode } = req.params;

  const [flagRes, invoicesRes] = await Promise.all([
    pool.query(
      `SELECT f.*,
              v.company_name, v.mst_status AS verified_status, v.address,
              v.registered_date, v.legal_rep, v.business_type, v.province_code, v.verified_at
       FROM company_risk_flags f
       LEFT JOIN company_verification_cache v ON v.tax_code = f.tax_code
       WHERE f.company_id = $1 AND f.tax_code = $2`,
      [companyId, taxCode],
    ),
    pool.query(
      `SELECT id, invoice_number, invoice_date, total_amount, vat_amount, vat_rate,
              seller_name, status, direction
       FROM invoices
       WHERE company_id = $1 AND seller_tax_code = $2 AND deleted_at IS NULL
       ORDER BY invoice_date DESC LIMIT 50`,
      [companyId, taxCode],
    ),
  ]);

  sendSuccess(res, { flag: flagRes.rows[0] ?? null, invoices: invoicesRes.rows });
});

// POST /api/audit/ghost-companies/:taxCode/verify — force re-verify a specific tax code
router.post('/ghost-companies/:taxCode/verify', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { taxCode } = req.params;
  const flags = await ghostCompanyDetector.analyzeCompany(companyId, taxCode, 'seller');
  sendSuccess(res, { data: flags });
});

// PATCH /api/audit/ghost-companies/:id/acknowledge
router.patch('/ghost-companies/:id/acknowledge', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const userId    = req.user!.userId;
  const { note }  = req.body as { note?: string };
  await pool.query(
    `UPDATE company_risk_flags
     SET acknowledged_at = NOW(), acknowledged_by = $1, is_acknowledged = true,
         flag_details = COALESCE(flag_details, '[]'::jsonb) || $4::jsonb
     WHERE id = $2 AND company_id = $3`,
    [userId, req.params.id, companyId,
     JSON.stringify([{ acknowledge_note: note ?? '', acknowledged_at: new Date().toISOString() }])],
  );
  sendSuccess(res, { ok: true });
});

// ── Tax Rate Anomaly Detection (P50.4) ───────────────────────────────────────

// POST /api/audit/tax-rates/scan
router.post('/tax-rates/scan', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year } = req.body as { month?: number; year?: number };
  const now = new Date();
  const m = month ?? now.getMonth() + 1;
  const y = year  ?? now.getFullYear();
  const anomalies = await taxRateAnomalyDetector.scan(companyId, m, y);
  sendSuccess(res, { found: anomalies.length, data: anomalies });
});

// GET /api/audit/tax-rates?month=&year=&page=&pageSize=
router.get('/tax-rates', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year, page, pageSize } = req.query as Record<string, string>;
  const pg   = Number(page ?? 1);
  const pgSz = Number(pageSize ?? 50);
  const now  = new Date();
  const result = await taxRateAnomalyDetector.getAnomalies(
    companyId,
    Number(month ?? now.getMonth() + 1),
    Number(year  ?? now.getFullYear()),
    pg,
    pgSz,
  );
  sendSuccess(res, result);
});

// PATCH /api/audit/tax-rates/:id/acknowledge
router.patch('/tax-rates/:id/acknowledge', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const userId    = req.user!.userId;
  await taxRateAnomalyDetector.acknowledge(req.params.id!, companyId, userId);
  sendSuccess(res, { ok: true });
});

export default router;
