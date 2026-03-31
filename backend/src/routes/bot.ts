import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { encrypt, decrypt } from '../utils/encryption';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import { Queue } from 'bullmq';
import { env } from '../config/env';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// ── BullMQ queue for bot sync jobs ──────────────────────────────────────────
let botQueue: Queue | null = null;
function getBotQueue(): Queue {
  if (!botQueue) {
    // Use same connection pattern as SyncWorker
    botQueue = new Queue('gdt-bot-sync', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return botQueue;
}

// ── Schemas ──────────────────────────────────────────────────────────────────
const setupSchema = z.object({
  password:             z.string().min(4).max(256),
  has_otp:              z.boolean().default(false),
  otp_method:           z.enum(['sms', 'email', 'app']).nullable().default(null),
  sync_frequency_hours: z.number().int().min(0).max(168).default(6),
});

const runNowSchema = z.object({
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine(data => {
  if (!data.from_date || !data.to_date) return true;
  const diffMs = new Date(data.to_date).getTime() - new Date(data.from_date).getTime();
  return diffMs >= 0 && diffMs <= 31 * 24 * 60 * 60 * 1000;
}, { message: 'Khoảng thời gian tối đa 31 ngày theo quy định GDT. Vui lòng chọn lại.' });

const otpSchema = z.object({
  otp: z.string().min(4).max(10),
});

// ── POST /api/bot/setup ──────────────────────────────────────────────────────
router.post(
  '/setup',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const { password, has_otp, otp_method, sync_frequency_hours } = parsed.data;
      const companyId = req.user!.companyId;

      // Fetch company tax code
      const compRes = await pool.query(`SELECT tax_code FROM companies WHERE id = $1`, [companyId]);
      if (compRes.rows.length === 0) throw new NotFoundError('Company not found');
      const taxCode: string = compRes.rows[0].tax_code;

      // Check if tax_code looks valid: /^\d{10}(-\d{3})?$/
      if (!/^\d{10}(-\d{3})?$/.test(taxCode)) {
        throw new ValidationError('Mã số thuế công ty không hợp lệ. Vui lòng cập nhật hồ sơ công ty trước.');
      }

      // Encrypt password — store as JSON blob with username = tax_code (GDT portal)
      const encryptedCreds = encrypt(JSON.stringify({ username: taxCode, password }));

      await pool.query(
        `INSERT INTO gdt_bot_configs
           (id, company_id, tax_code, encrypted_credentials, has_otp, otp_method,
            sync_frequency_hours, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())
         ON CONFLICT (company_id) DO UPDATE SET
           tax_code             = EXCLUDED.tax_code,
           encrypted_credentials= EXCLUDED.encrypted_credentials,
           has_otp              = EXCLUDED.has_otp,
           otp_method           = EXCLUDED.otp_method,
           sync_frequency_hours = EXCLUDED.sync_frequency_hours,
           is_active            = true,
           updated_at           = NOW()`,
        [uuidv4(), companyId, taxCode, encryptedCreds, has_otp, otp_method, sync_frequency_hours]
      );

      // Enqueue first run if frequency > 0
      if (sync_frequency_hours > 0) {
        await getBotQueue().add('sync', { companyId }, {
          jobId:   `gdt-bot-first-${companyId}`,
          attempts: 3,
          backoff:  { type: 'exponential', delay: 60000 },
        });
      }

      sendSuccess(res, { configured: true, taxCode });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/bot/status ──────────────────────────────────────────────────────
router.get(
  '/status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;

      const cfgRes = await pool.query(
        `SELECT id, company_id, tax_code, has_otp, otp_method, is_active,
                sync_frequency_hours, last_run_at, last_run_status,
                last_run_output_count, last_run_input_count, last_error, blocked_until
         FROM gdt_bot_configs WHERE company_id = $1`,
        [companyId]
      );

      const runsRes = await pool.query(
        `SELECT id, started_at, finished_at, status, output_count, input_count, duration_ms, error_detail
         FROM gdt_bot_runs WHERE company_id = $1
         ORDER BY started_at DESC LIMIT 10`,
        [companyId]
      );

      sendSuccess(res, {
        config:   cfgRes.rows[0] ?? null,
        lastRuns: runsRes.rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/bot/run-now ────────────────────────────────────────────────────
router.post(
  '/run-now',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;

      const cfgRes = await pool.query(
        `SELECT id, is_active, last_run_at FROM gdt_bot_configs WHERE company_id = $1`,
        [companyId]
      );
      if (cfgRes.rows.length === 0) throw new NotFoundError('GDT Bot chưa được cấu hình');
      if (!cfgRes.rows[0].is_active) throw new ValidationError('GDT Bot hiện đang tắt');

      // Enforce same 15-minute login cooldown as sync.worker — give user a clear message
      const MIN_LOGIN_INTERVAL_MS = 15 * 60 * 1000;
      if (cfgRes.rows[0].last_run_at) {
        const elapsedMs = Date.now() - new Date(cfgRes.rows[0].last_run_at as string).getTime();
        if (elapsedMs < MIN_LOGIN_INTERVAL_MS) {
          const waitMinutes = Math.ceil((MIN_LOGIN_INTERVAL_MS - elapsedMs) / 60_000);
          res.status(429).json({
            success: false,
            error: {
              code:    'COOLDOWN',
              waitMinutes,
              message: `Bot vừa chạy xong. Vui lòng chờ thêm ${waitMinutes} phút trước khi đồng bộ lại.`,
            },
          });
          return;
        }
      }

      const parsed = runNowSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
      const { from_date, to_date } = parsed.data;

      const jobId = `gdt-bot-manual-${companyId}-${Date.now()}`;
      await getBotQueue().add('sync', {
        companyId,
        ...(from_date ? { fromDate: from_date } : {}),
        ...(to_date   ? { toDate:   to_date   } : {}),
      }, {
        jobId,
        attempts: 2,
        backoff:  { type: 'exponential', delay: 30000 },
      });

      sendSuccess(res, { queued: true, jobId });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/bot/submit-otp ─────────────────────────────────────────────────
router.post(
  '/submit-otp',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = otpSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('OTP không hợp lệ');

      const { otp } = parsed.data;
      const companyId = req.user!.companyId;

      // Store OTP in Redis with 5-minute TTL for the bot worker to pick up
      const Redis = (await import('ioredis')).default;
      const redisClient = new Redis(env.REDIS_URL);
      await redisClient.set(`gdt_otp:${companyId}`, otp, 'EX', 300);
      await redisClient.quit();

      // Update bot status to clear otp_required
      await pool.query(
        `UPDATE gdt_bot_configs SET last_run_status = 'pending', updated_at = NOW() WHERE company_id = $1`,
        [companyId]
      );

      // Re-enqueue sync job
      await getBotQueue().add('sync', { companyId, hasOtp: true }, {
        jobId:   `gdt-bot-otp-${companyId}-${Date.now()}`,
        attempts: 2,
      });

      sendSuccess(res, { submitted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── PATCH /api/bot/toggle ─────────────────────────────────────────────────────
router.patch(
  '/toggle',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;
      const result = await pool.query(
        `UPDATE gdt_bot_configs
         SET is_active = NOT is_active, updated_at = NOW()
         WHERE company_id = $1
         RETURNING is_active`,
        [companyId]
      );
      if (result.rows.length === 0) throw new NotFoundError('GDT Bot chưa được cấu hình');
      sendSuccess(res, { is_active: result.rows[0].is_active });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/bot/config ───────────────────────────────────────────────────
router.delete(
  '/config',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;
      await pool.query(`DELETE FROM gdt_bot_configs WHERE company_id = $1`, [companyId]);
      sendSuccess(res, { deleted: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/bot/runs ────────────────────────────────────────────────────────
router.get(
  '/runs',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;
      const page     = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10));
      const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query['pageSize'] ?? '20'), 10)));
      const offset   = (page - 1) * pageSize;

      const [countRes, dataRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) FROM gdt_bot_runs WHERE company_id = $1`, [companyId]),
        pool.query(
          `SELECT id, started_at, finished_at, status, output_count, input_count, duration_ms, error_detail
           FROM gdt_bot_runs WHERE company_id = $1
           ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
          [companyId, pageSize, offset]
        ),
      ]);

      sendPaginated(res, dataRes.rows, parseInt(countRes.rows[0].count, 10), page, pageSize);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
