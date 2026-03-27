import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { sendSuccess } from '../utils/response';
import { telegramService, TelegramEvent } from '../services/TelegramNotificationService';
import { env } from '../config/env';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// GET /api/telegram/configs
router.get('/configs', async (req, res) => {
  const companyId = req.user!.companyId!;
  const configs = await telegramService.getConfigs(companyId);
  sendSuccess(res, { configs, bot_enabled: telegramService.isEnabled() });
});

// POST /api/telegram/configs — add or update a chat
router.post('/configs', async (req, res) => {
  const companyId = req.user!.companyId!;
  const { chat_id, chat_type = 'private', subscribed_events = [] } = req.body as {
    chat_id: string;
    chat_type?: 'private' | 'group';
    subscribed_events?: TelegramEvent[];
  };

  if (!chat_id || typeof chat_id !== 'string') {
    res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'chat_id is required' } });
    return;
  }

  const config = await telegramService.upsertConfig(companyId, chat_id.trim(), chat_type, subscribed_events);
  sendSuccess(res, config);
});

// PATCH /api/telegram/configs/:chatId/toggle
router.patch('/configs/:chatId/toggle', async (req, res) => {
  const companyId = req.user!.companyId!;
  const { is_active } = req.body as { is_active: boolean };
  await telegramService.updateActive(companyId, req.params.chatId, !!is_active);
  sendSuccess(res, { updated: true });
});

// DELETE /api/telegram/configs/:chatId
router.delete('/configs/:chatId', async (req, res) => {
  const companyId = req.user!.companyId!;
  await telegramService.deleteConfig(companyId, req.params.chatId);
  sendSuccess(res, { deleted: true });
});

// POST /api/telegram/test — send a test message
router.post('/test', async (req, res) => {
  const companyId = req.user!.companyId!;
  const { chat_id } = req.body as { chat_id: string };
  if (!chat_id) {
    res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'chat_id required' } });
    return;
  }
  const ok = await telegramService.sendMessage(
    chat_id,
    '✅ <b>Kết nối thành công!</b>\nBạn đã kết nối Telegram với hệ thống INVONE.\nCác thông báo sẽ được gửi qua đây.',
  );
  sendSuccess(res, { sent: ok });
});

// GET /api/telegram/bot-info
router.get('/bot-info', (_req, res) => {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    sendSuccess(res, { enabled: false });
    return;
  }
  // Extract bot username from token start (format: <id>:<secret>) — not possible, return placeholder
  sendSuccess(res, { enabled: true });
});

export default router;
