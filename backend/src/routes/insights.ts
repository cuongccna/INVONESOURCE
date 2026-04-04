import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { esgService } from '../services/EsgEstimationService';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/insights/seasonal
router.get('/seasonal', async (req: Request, res: Response) => {
  const companyId = req.user?.companyId;
  if (!companyId) throw new ValidationError('Thiếu công ty đang hoạt động (X-Company-Id)');
  const data = await esgService.getSeasonalInsights(companyId);
  sendSuccess(res, data);
});

export default router;
