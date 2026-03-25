import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';
import { ConsolidatedGroupService } from '../services/ConsolidatedGroupService';

const router = Router();
router.use(authenticate);

// GET /api/group/:orgId/kpi?month=&year=
router.get('/:orgId/kpi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params;
    const now = new Date();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;
    const year  = parseInt(req.query.year  as string) || now.getFullYear();

    if (!orgId?.match(/^[0-9a-f-]{36}$/i)) throw new ValidationError('orgId phải là UUID hợp lệ');
    if (month < 1 || month > 12) throw new ValidationError('month phải nằm trong khoảng 1–12');
    if (year  < 2020 || year > 2100) throw new ValidationError('year không hợp lệ');

    const data = await ConsolidatedGroupService.getKpi(req.user!.userId, orgId, month, year);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
});

// GET /api/group/:orgId/trend
router.get('/:orgId/trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId } = req.params;
    if (!orgId?.match(/^[0-9a-f-]{36}$/i)) throw new ValidationError('orgId phải là UUID hợp lệ');

    const data = await ConsolidatedGroupService.getTrend(req.user!.userId, orgId);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
