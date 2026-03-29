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
import { resolvePeriod } from '../utils/period';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/reports/profit-loss?month=&year=&periodType=monthly|quarterly|yearly&quarter=&compare=true
router.get('/', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year, quarter, periodType } = resolvePeriod(req.query);

  let current = null;
  if (periodType === 'monthly') {
    current = await profitLossService.getPL(companyId, month, year);
  } else if (periodType === 'quarterly') {
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    current = await profitLossService.getAggregatedPL(companyId, year, startMonth, endMonth);
  } else {
    current = await profitLossService.getAggregatedPL(companyId, year, 1, 12);
  }

  let previous = null;
  if (req.query['compare'] === 'true' && periodType === 'monthly') {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    previous = await profitLossService.getPL(companyId, prevMonth, prevYear);
  }

  sendSuccess(res, { current, previous });
});

// POST /api/reports/profit-loss/generate  — (re)calculate and save
// Supports periodType: 'monthly' (default) | 'quarterly' | 'yearly'
router.post('/generate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { month, year, periodType, quarter } = req.body as {
    month?: number; year?: number; periodType?: string; quarter?: number;
  };
  const y = parseInt(String(year)) || new Date().getFullYear();
  const pt = periodType ?? 'monthly';

  if (pt === 'quarterly') {
    const q = parseInt(String(quarter)) || Math.ceil((new Date().getMonth() + 1) / 3);
    if (q < 1 || q > 4) throw new AppError('quarter must be 1-4', 400, 'VALIDATION');
    const startMonth = (q - 1) * 3 + 1;
    const results = await Promise.all([
      profitLossService.calculatePL(companyId, startMonth,     y),
      profitLossService.calculatePL(companyId, startMonth + 1, y),
      profitLossService.calculatePL(companyId, startMonth + 2, y),
    ]);
    sendSuccess(res, results, 'Quarterly P&L recalculated');
  } else if (pt === 'yearly') {
    const months = [1,2,3,4,5,6,7,8,9,10,11,12];
    const results = await Promise.all(months.map((m) => profitLossService.calculatePL(companyId, m, y)));
    sendSuccess(res, results, 'Yearly P&L recalculated');
  } else {
    const m = parseInt(String(month)) || new Date().getMonth() + 1;
    if (m < 1 || m > 12) throw new AppError('month must be 1-12', 400, 'VALIDATION');
    const result = await profitLossService.calculatePL(companyId, m, y);
    sendSuccess(res, result, 'P&L statement generated');
  }
});

export default router;
