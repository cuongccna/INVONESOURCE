/**
 * Tools Route — Penalty Calculator (P50.5)
 *
 * Public calculation routes — no DB writes, only calculations.
 * Authentication required; no company context needed for penalty calculation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { penaltyCalculator } from '../services/PenaltyCalculator';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';

const router = Router();
router.use(authenticate);

// POST /api/tools/penalty-calculate
router.post('/penalty-calculate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { month, year, vatUnderpaid, hasPriorVoluntary } = req.body as {
      month:              number;
      year:               number;
      vatUnderpaid:       number;
      hasPriorVoluntary?: boolean;
    };

    if (!month || !year || vatUnderpaid === undefined) {
      throw new ValidationError('month, year, and vatUnderpaid are required');
    }
    if (month < 1 || month > 12) throw new ValidationError('month must be between 1 and 12');
    if (year  < 2000 || year > 2100) throw new ValidationError('year out of range');

    // deadline = 20th of the month following the declaration period
    const originalDeadline = new Date(year, month, 20); // month is 0-indexed internally, but 1-12 input → next month
    const paymentDate = new Date();

    const result = penaltyCalculator.calculate({
      taxAmount:         Number(vatUnderpaid),
      originalDeadline,
      paymentDate,
      hasPriorVoluntary: hasPriorVoluntary === true,
    });

    sendSuccess(res, result);
  } catch (err) { next(err); }
});

// POST /api/tools/cost-benefit
router.post('/cost-benefit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { month, year, vatUnderpaid, riskLevel } = req.body as {
      month:      number;
      year:       number;
      vatUnderpaid: number;
      riskLevel?: 'low' | 'medium' | 'high';
    };

    if (!month || !year || vatUnderpaid === undefined) {
      throw new ValidationError('month, year, and vatUnderpaid are required');
    }

    const originalDeadline = new Date(year, month, 20);

    const penalty = penaltyCalculator.calculate({
      taxAmount:        Number(vatUnderpaid),
      originalDeadline,
      paymentDate:      new Date(),
      hasPriorVoluntary: true,
    });

    const costBenefit = penaltyCalculator.costBenefitAnalysis({
      taxDifference:      Number(vatUnderpaid),
      originalDeadline,
      estimatedAuditRisk: riskLevel ?? 'medium',
    });

    sendSuccess(res, { penalty, costBenefit });
  } catch (err) { next(err); }
});

export default router;
