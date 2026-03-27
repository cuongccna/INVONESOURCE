import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { esgService } from '../services/EsgEstimationService';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/esg/estimate?year=2024
router.get('/estimate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const year = Number(req.query.year ?? new Date().getFullYear());
  const data = await esgService.estimateForYear(companyId, year);
  sendSuccess(res, data);
});

// GET /api/esg/seasonal
router.get('/seasonal', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const data = await esgService.getSeasonalInsights(companyId);
  sendSuccess(res, data);
});

export default router;
