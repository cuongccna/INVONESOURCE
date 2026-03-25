import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { esgService } from '../services/EsgEstimationService';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);

// GET /api/insights/seasonal
router.get('/seasonal', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const data = await esgService.getSeasonalInsights(companyId);
  sendSuccess(res, data);
});

export default router;
