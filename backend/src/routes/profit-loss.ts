/**
 * Group 40 — P&L routes
 * Profit & Loss statement B02-DN.
 */
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/AppError';
import { profitLossService } from '../services/ProfitLossService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/reports/profit-loss?month=&year=&compare=true
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  if (month < 1 || month > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const current = await profitLossService.getPL(companyId, month, year);
  let previous = null;
  if (req.query.compare === 'true') {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    previous = await profitLossService.getPL(companyId, prevMonth, prevYear);
  }

  sendSuccess(res, { current, previous });
});

// POST /api/reports/profit-loss/generate  — (re)calculate and save
router.post('/generate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year } = req.body as { month?: number; year?: number };
  const m = parseInt(String(month)) || new Date().getMonth() + 1;
  const y = parseInt(String(year)) || new Date().getFullYear();
  if (m < 1 || m > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');

  const result = await profitLossService.calculatePL(companyId, m, y);
  sendSuccess(res, result, 'P&L statement generated');
});

export default router;
