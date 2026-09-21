/**
 * Admin — Chẩn đoán GDT
 *
 * GET  /api/admin/gdt-diagnose/companies      — danh sách công ty có bot + trạng thái
 * POST /api/admin/gdt-diagnose/run            — { companyId } → enqueue gdt-diagnose, trả jobId
 * GET  /api/admin/gdt-diagnose/run/:jobId     — tiến độ từng mốc + kết luận (bot ghi vào job)
 * POST /api/admin/gdt-diagnose/fix            — { companyId, action } → áp dụng hướng khắc phục
 *
 * Việc chẩn đoán chạy trong process bot (bot/src/gdt-diagnose.worker.ts) vì chỉ bot có
 * proxy tunnel, 2Captcha và đúng luồng đăng nhập GDT đang dùng thật.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { licenseService } from '../services/LicenseService';
import { env } from '../config/env';

const router = Router();
router.use(authenticate, requireAdmin);

const AUTO_SYNC_PAUSE_KEY = 'gdt:auto_sync:paused';

let _diagQueue: Queue | null = null;
function diagQueue(): Queue {
  if (!_diagQueue) {
    _diagQueue = new Queue('gdt-diagnose', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return _diagQueue;
}

let _manualQueue: Queue | null = null;
function manualQueue(): Queue {
  if (!_manualQueue) {
    _manualQueue = new Queue('gdt-sync-manual', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return _manualQueue;
}

let _redis: IORedis | null = null;
function redis(): IORedis {
  if (!_redis) _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  return _redis;
}

// ── Danh sách công ty ─────────────────────────────────────────────────────────
router.get('/companies', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await pool.query(
      `SELECT b.company_id, c.name, COALESCE(b.tax_code, c.tax_code) AS tax_code,
              b.is_active, b.blocked_until, b.consecutive_failures,
              b.last_run_at, b.last_run_status, b.last_error,
              u.email AS owner_email,
              g.checked_at AS check_at, g.ok AS check_ok, g.verdict_code AS check_code,
              g.verdict_title AS check_title, g.source AS check_source
       FROM gdt_bot_configs b
       JOIN companies c ON c.id = b.company_id
       LEFT JOIN gdt_connection_checks g ON g.company_id = b.company_id
       LEFT JOIN LATERAL (
         SELECT uc.user_id FROM user_companies uc
         WHERE uc.company_id = b.company_id AND uc.role = 'OWNER' LIMIT 1
       ) o ON TRUE
       LEFT JOIN users u ON u.id = o.user_id
       ORDER BY (g.ok = false) DESC NULLS LAST, (b.last_run_status = 'error') DESC, b.last_run_at DESC NULLS LAST`,
    );
    const globalPaused = (await redis().get(AUTO_SYNC_PAUSE_KEY)) === '1';
    sendSuccess(res, { globalPaused, companies: rows.rows });
  } catch (err) { next(err); }
});

// ── Chạy chẩn đoán ────────────────────────────────────────────────────────────
const runSchema = z.object({ companyId: z.string().uuid() });

router.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('companyId không hợp lệ');
    const { companyId } = parsed.data;

    // Mỗi công ty chỉ một phiên chẩn đoán tại một thời điểm — tránh dồn login lên GDT.
    const pending = await diagQueue().getJobs(['active', 'waiting']);
    const existing = pending.find(j => j.data?.companyId === companyId);
    if (existing) {
      sendSuccess(res, { jobId: existing.id, reused: true });
      return;
    }

    const job = await diagQueue().add('diagnose', { companyId, requestedBy: req.user!.userId }, {
      jobId: `diag-${uuidv4()}`,
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail:     { age: 24 * 3600, count: 200 },
    });
    sendSuccess(res, { jobId: job.id, reused: false });
  } catch (err) { next(err); }
});

router.get('/run/:jobId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const job = await diagQueue().getJob(String(req.params['jobId']));
    if (!job) throw new NotFoundError('Không tìm thấy phiên chẩn đoán');
    const state = await job.getState();
    const progress = (job.progress && typeof job.progress === 'object') ? job.progress as { steps?: unknown[] } : {};
    sendSuccess(res, {
      jobId:        job.id,
      state,                                   // waiting | active | completed | failed
      steps:        progress.steps ?? [],
      result:       state === 'completed' ? job.returnvalue : null,
      failedReason: job.failedReason ?? null,
      queuedAt:     job.timestamp,
    });
  } catch (err) { next(err); }
});

// ── Khắc phục ─────────────────────────────────────────────────────────────────
const fixSchema = z.object({
  companyId: z.string().uuid().optional(),
  action: z.enum(['clear_block', 'reactivate_bot', 'reset_proxy_session', 'resume_auto_sync', 'run_sync']),
});

router.post('/fix', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = fixSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Tham số không hợp lệ');
    const { companyId, action } = parsed.data;

    if (action === 'resume_auto_sync') {
      await redis().del(AUTO_SYNC_PAUSE_KEY);
      sendSuccess(res, { action, message: 'Đã bật lại auto-sync toàn hệ thống' });
      return;
    }

    if (!companyId) throw new ValidationError('Thiếu companyId');
    const exists = await pool.query(`SELECT 1 FROM gdt_bot_configs WHERE company_id = $1`, [companyId]);
    if (exists.rowCount === 0) throw new NotFoundError('Công ty chưa cấu hình bot');

    switch (action) {
      case 'clear_block':
        await pool.query(
          `UPDATE gdt_bot_configs SET blocked_until = NULL, consecutive_failures = 0, updated_at = NOW()
           WHERE company_id = $1`, [companyId]);
        sendSuccess(res, { action, message: 'Đã gỡ tự khoá và đặt lại bộ đếm lỗi' });
        return;

      case 'reactivate_bot':
        await pool.query(
          `UPDATE gdt_bot_configs
           SET is_active = true, blocked_until = NULL, consecutive_failures = 0,
               last_error = NULL, next_auto_sync_at = NOW(), updated_at = NOW()
           WHERE company_id = $1`, [companyId]);
        sendSuccess(res, { action, message: 'Đã bật lại bot cho công ty' });
        return;

      case 'reset_proxy_session':
        await pool.query(
          `UPDATE gdt_bot_configs SET proxy_session_id = NULL, updated_at = NOW() WHERE company_id = $1`,
          [companyId]);
        // Xoá token GDT đã cache theo phiên proxy cũ để lần sau đăng nhập lại qua proxy mới.
        {
          let cursor = '0';
          do {
            const [nextCursor, keys] = await redis().scan(cursor, 'MATCH', `gdt:session:${companyId}:*`, 'COUNT', 100);
            if (keys.length) await redis().del(...keys);
            cursor = nextCursor;
          } while (cursor !== '0');
        }
        sendSuccess(res, { action, message: 'Đã đặt lại phiên proxy — lần đồng bộ sau sẽ chọn proxy mới' });
        return;

      case 'run_sync': {
        const owner = await pool.query<{ user_id: string }>(
          `SELECT user_id FROM user_companies WHERE company_id = $1 AND role = 'OWNER' LIMIT 1`, [companyId]);
        const ownerId = owner.rows[0]?.user_id;
        if (!ownerId) throw new ValidationError('Công ty không có OWNER — không chọn được proxy');
        if (await redis().exists(`bot:sync:lock:${companyId}`)) {
          throw new ValidationError('Bot đang đồng bộ công ty này, vui lòng đợi');
        }
        await pool.query(
          `UPDATE gdt_bot_configs SET blocked_until = NULL, consecutive_failures = 0 WHERE company_id = $1`,
          [companyId]);
        const runId = uuidv4();
        await pool.query(
          `INSERT INTO gdt_bot_runs (id, company_id, started_at, status, trigger_source)
           VALUES ($1, $2, NOW(), 'pending', 'admin_diagnose')`, [runId, companyId]);
        try {
          await manualQueue().add('sync', {
            companyId, runId,
            triggeredByUserId: ownerId,       // proxy của chủ công ty, giống user tự bấm đồng bộ
            userPlan: await licenseService.getPlanId(ownerId),
            triggeredBy: 'admin_diagnose',
          }, { jobId: runId, priority: 1, attempts: 1 });
        } catch (queueErr) {
          await pool.query(`DELETE FROM gdt_bot_runs WHERE id = $1`, [runId]).catch(() => undefined);
          throw queueErr;
        }
        await pool.query(
          `UPDATE gdt_bot_configs SET last_run_status = 'pending', last_error = NULL, updated_at = NOW()
           WHERE company_id = $1`, [companyId]).catch(() => undefined);
        sendSuccess(res, { action, runId, message: 'Đã đưa công ty vào hàng đồng bộ thủ công' });
        return;
      }
    }
  } catch (err) { next(err); }
});

export default router;
