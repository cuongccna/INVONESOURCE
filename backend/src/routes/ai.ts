import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { geminiChatService, ChatMessage } from '../services/GeminiChatService';
import { GeminiOCRService } from '../services/GeminiOCRService';
import { GeminiAnomalyService } from '../services/GeminiAnomalyService';
import { sendSuccess } from '../utils/response';
import { ValidationError } from '../utils/AppError';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only JPEG/PNG/WebP images are accepted'));
    }
  },
});

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        content: z.string(),
      })
    )
    .max(20)
    .default([]),
});

// POST /api/ai/chat
router.post('/chat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const { message, history } = parsed.data;
    const companyId = req.user!.companyId ?? '';

    const reply = await geminiChatService.chat(companyId, message, history as ChatMessage[]);
    sendSuccess(res, { reply });
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/stream — SSE streaming chat
router.post('/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

    const { message, history } = parsed.data;
    const companyId = req.user!.companyId ?? '';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
    res.flushHeaders();

    try {
      const stream = geminiChatService.streamChat(companyId, message, history as ChatMessage[]);
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (streamErr) {
      res.write(`data: ${JSON.stringify({ error: 'Lỗi sinh nội dung. Vui lòng thử lại.' })}\n\n`);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      res.end();
    }
  }
});

// POST /api/ai/ocr — scan invoice image
router.post('/ocr', upload.single('invoice'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new ValidationError('Invoice image is required');

    const ocrService = new GeminiOCRService();
    const result = await ocrService.extractInvoiceFromImage(
      req.file.buffer,
      req.file.mimetype
    );

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// GET /api/ai/anomalies?month=&year=
router.get('/anomalies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const month = req.query.month ? parseInt(req.query.month as string, 10) : undefined;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;

    const anomalyService = new GeminiAnomalyService();
    const report = await anomalyService.analyzeAnomalies(
      req.user!.companyId!,
      { month: month ?? new Date().getMonth() + 1, year: year ?? new Date().getFullYear() }
    );
    sendSuccess(res, report);
  } catch (err) {
    next(err);
  }
});

export default router;
