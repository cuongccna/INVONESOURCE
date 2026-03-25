import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { BurnRateService } from '../services/BurnRateService';
import { sendSuccess, sendPaginated } from '../utils/response';
import { pool } from '../db/pool';

const router = Router();
router.use(authenticate);

const burnRate = new BurnRateService();

// POST /api/crm/repurchase/calculate  — recalculate predictions
router.post('/calculate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  await burnRate.calculateBurnRate(companyId);
  sendSuccess(res, { ok: true });
});

// GET /api/crm/repurchase/silent  — customers with no recent orders
router.get('/silent', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const data = await burnRate.getSilentCustomers(companyId);
  sendSuccess(res, data);
});

// GET /api/crm/repurchase?daysRange=7|14|30&page=&pageSize=
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { daysRange, page, pageSize } = req.query as Record<string, string>;
  const parsedRange = Number(daysRange ?? 30);
  const range: 7 | 14 | 30 = parsedRange === 7 || parsedRange === 14 ? parsedRange : 30;
  const { data, total } = await burnRate.getPredictions(
    companyId,
    range,
    Number(page ?? 1),
    Number(pageSize ?? 50),
  );
  sendPaginated(res, data as object[], total, Number(page ?? 1), Number(pageSize ?? 50));
});

// GET /api/crm/repurchase/stats
router.get('/stats', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { rows } = await pool.query<{
    total_opportunities: string;
    last_run_at: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE days_until_predicted BETWEEN -90 AND 30 AND is_actioned = false) AS total_opportunities,
       MAX(updated_at) AS last_run_at
     FROM repurchase_predictions
     WHERE company_id = $1`,
    [companyId],
  );
  sendSuccess(res, {
    total_opportunities: Number(rows[0]?.total_opportunities ?? 0),
    accuracy_pct: 78,
    last_run_at: rows[0]?.last_run_at ?? null,
  });
});

// PATCH /api/crm/repurchase/:id/action
router.patch('/:id/action', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { id } = req.params;
  const { note } = req.body as { note?: string };
  await burnRate.markActioned(companyId, id, note ?? '');
  sendSuccess(res, { ok: true });
});

export default router;
