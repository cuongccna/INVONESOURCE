import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { VatReconciliationService } from '../services/VatReconciliationService';
import { sendSuccess, sendPaginated } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { pool } from '../db/pool';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const reconcileSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2020).max(2100),
});

// GET /api/reconciliation
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 12);
    const offset = (page - 1) * pageSize;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM vat_reconciliations WHERE company_id = $1`,
        [req.user!.companyId]
      ),
      pool.query(
        `SELECT period_month, period_year, output_vat, input_vat, payable_vat, generated_at
         FROM vat_reconciliations WHERE company_id = $1
         ORDER BY period_year DESC, period_month DESC
         LIMIT $2 OFFSET $3`,
        [req.user!.companyId, pageSize, offset]
      ),
    ]);

    sendPaginated(res, dataResult.rows, Number(countResult.rows[0].count), page, pageSize);
  } catch (err) {
    next(err);
  }
});

// GET /api/reconciliation/:year/:month
router.get('/:year/:month', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);

    const result = await pool.query(
      `SELECT * FROM vat_reconciliations WHERE company_id = $1 AND period_year = $2 AND period_month = $3`,
      [req.user!.companyId, year, month]
    );
    if (!result.rows[0]) throw new NotFoundError('Reconciliation period not found');
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/reconciliation/calculate
router.post(
  '/calculate',
  requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = reconcileSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const service = new VatReconciliationService();
      const result = await service.calculatePeriod(req.user!.companyId!, parsed.data.month, parsed.data.year);
      sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
