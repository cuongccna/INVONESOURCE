import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { pool } from '../db/pool';
import { sendSuccess, sendPaginated } from '../utils/response';
import { AppError } from '../utils/AppError';
import { RfmAnalysisService } from '../services/RfmAnalysisService';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/crm/rfm/summary
router.get('/rfm/summary', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const data = await RfmAnalysisService.getSummary(companyId);
  sendSuccess(res, data);
});

// GET /api/crm/rfm?segment=&page=&pageSize=
router.get('/rfm', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { segment, page, pageSize } = req.query as Record<string, string>;
  const { data, total } = await RfmAnalysisService.getList(
    companyId,
    segment,
    Number(page ?? 1),
    Number(pageSize ?? 50),
  );
  sendPaginated(res, data as object[], total, Number(page ?? 1), Number(pageSize ?? 50));
});

// POST /api/crm/rfm/recalculate
router.post('/rfm/recalculate', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  // Run inline (fast enough for current volumes; can queue later)
  await RfmAnalysisService.calculateRfm(companyId);
  sendSuccess(res, { ok: true });
});

// GET /api/crm/aging — accounts receivable aging report
router.get('/aging', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const today = new Date().toISOString().split('T')[0];

  const res2 = await pool.query(
    `SELECT
       buyer_tax_code,
       buyer_name,
       COUNT(*) AS invoice_count,
       SUM(total_amount) AS total_amount,
       -- Invoices without payment_due_date are treated as not yet overdue (current)
       SUM(CASE WHEN COALESCE(payment_due_date, CURRENT_DATE + 30) >= $2::date THEN total_amount ELSE 0 END) AS current_amount,
       SUM(CASE WHEN $2::date - COALESCE(payment_due_date, CURRENT_DATE + 30) BETWEEN 1  AND 30 THEN total_amount ELSE 0 END) AS overdue_1_30,
       SUM(CASE WHEN $2::date - COALESCE(payment_due_date, CURRENT_DATE + 30) BETWEEN 31 AND 60 THEN total_amount ELSE 0 END) AS overdue_31_60,
       SUM(CASE WHEN $2::date - COALESCE(payment_due_date, CURRENT_DATE + 30) BETWEEN 61 AND 90 THEN total_amount ELSE 0 END) AS overdue_61_90,
       SUM(CASE WHEN $2::date - COALESCE(payment_due_date, CURRENT_DATE + 30) > 90             THEN total_amount ELSE 0 END) AS overdue_90plus,
       MAX(invoice_date) AS last_invoice_date
     FROM invoices
     WHERE company_id = $1
       AND direction = 'output'
       AND status = 'valid'
       AND payment_date IS NULL
       AND deleted_at IS NULL
     GROUP BY buyer_tax_code, buyer_name
     ORDER BY total_amount DESC`,
    [companyId, today],
  );

  sendSuccess(res, res2.rows);
});

// PATCH /api/crm/invoices/:id/mark-paid
router.patch('/invoices/:id/mark-paid', async (req: Request, res: Response) => {
  const companyId = req.user!.companyId!;
  const { paymentDate } = req.body as { paymentDate?: string };

  const result = await pool.query(
    `UPDATE invoices SET payment_date = $1
     WHERE id = $2 AND company_id = $3
     RETURNING id, payment_date`,
    [paymentDate ?? new Date().toISOString().split('T')[0], req.params.id, companyId],
  );
  if (result.rowCount === 0) throw new AppError('Invoice not found', 404, 'NOT_FOUND');
  sendSuccess(res, result.rows[0]);
});

// POST /api/crm/rfm/analyze — Gemini AI customer analysis
router.post('/rfm/analyze', async (req: Request, res: Response) => {
  const { buyer_tax_code, buyer_name, invoice_count_12m, total_amount_12m, r_score, f_score, m_score, segment } = req.body as {
    buyer_tax_code: string; buyer_name: string;
    invoice_count_12m: number; total_amount_12m: string;
    r_score: number; f_score: number; m_score: number; segment: string;
  };

  const prompt = `Bạn là chuyên gia phân tích khách hàng của một công ty Việt Nam. Hãy phân tích ngắn gọn (3-5 câu, tiếng Việt) dựa trên dữ liệu sau:

Khách hàng: ${buyer_name} (MST: ${buyer_tax_code})
Phân khúc: ${segment}
Điểm RFM: R=${r_score} F=${f_score} M=${m_score}
Số đơn 12 tháng: ${invoice_count_12m}
Tổng doanh thu 12 tháng: ${Number(total_amount_12m).toLocaleString('vi-VN')}đ

Phân tích:
1. Mẫu hành vi mua hàng chính
2. Rủi ro rời bỏ (churn risk) và lý do
3. Đề xuất chiến lược giữ chân / phát triển`;

  try {
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const analysis = result.response.text();
    sendSuccess(res, { analysis });
  } catch {
    sendSuccess(res, { analysis: 'Không thể kết nối với Gemini AI lúc này. Vui lòng thử lại sau.' });
  }
});

export default router;

