import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { vatForecastService } from '../services/VatForecastService';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/forecast/vat
router.get('/vat', async (req, res) => {
  const companyId = req.user?.companyId;
  if (!companyId) {
    return sendSuccess(res, {
      forecast_output_vat: 0,
      forecast_input_vat: 0,
      forecast_payable: 0,
      carry_forward: 0,
      net_forecast: 0,
      periods_used: 0,
      confidence_note: 'Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ.',
    });
  }

  const data = await vatForecastService.forecastNextPeriod(companyId);
  return sendSuccess(res, data);
});

export default router;
