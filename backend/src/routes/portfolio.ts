import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';
import { PortfolioService } from '../services/PortfolioService';

const router = Router();
router.use(authenticate);

// GET /api/portfolio/kpi?month=&year=
router.get('/kpi', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;
    const year  = parseInt(req.query.year  as string) || now.getFullYear();
    const organizationId = (req.query.organizationId as string) || null;

    if (month < 1 || month > 12) throw new ValidationError('month phải nằm trong khoảng 1–12');
    if (year  < 2020 || year > 2100) throw new ValidationError('year không hợp lệ');

    const data = await PortfolioService.getKpi(req.user!.userId, month, year, organizationId);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
});

// GET /api/portfolio/trend?organizationId=
router.get('/trend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = (req.query.organizationId as string) || null;
    const data = await PortfolioService.getTrend(req.user!.userId, organizationId);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
});

export default router;
