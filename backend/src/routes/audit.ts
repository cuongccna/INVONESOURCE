import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { priceAnomalyDetector } from '../services/PriceAnomalyDetector';
import { pool } from '../db/pool';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);

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

export default router;
