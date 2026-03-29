import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { productCatalogService } from '../services/ProductCatalogService';
import { resolvePeriod } from '../utils/period';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/products/profitability?month=&year=&periodType=monthly|quarterly|yearly&quarter=
router.get('/profitability', async (req, res) => {
  const companyId = req.user!.companyId!;
  const { start, end, month, year } = resolvePeriod(req.query);

  const data = await productCatalogService.getProfitability(companyId, month, year, start, end);
  sendSuccess(res, data);
});

export default router;
