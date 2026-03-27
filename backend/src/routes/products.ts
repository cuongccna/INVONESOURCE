import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { productCatalogService } from '../services/ProductCatalogService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/products/profitability?month=&year=
router.get('/profitability', async (req, res) => {
  const companyId = req.user!.companyId!;
  const now = new Date();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const year = Number(req.query.year) || now.getFullYear();

  const data = await productCatalogService.getProfitability(companyId, month, year);
  sendSuccess(res, data);
});

export default router;
