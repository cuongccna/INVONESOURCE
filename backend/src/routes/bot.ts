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
import IORedis from 'ioredis';
import { env } from '../config/env';

const _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const MANUAL_COOLDOWN_PREFIX  = 'bot:manual:cooldown:';
const MANUAL_COOLDOWN_TTL_SEC = 5 * 60;  // 5 minutes between manual syncs per company

const router = Router();
router.use(authenticate);
router.use(requireCompany);

// ── BullMQ queues for bot sync jobs ─────────────────────────────────────────
// gdt-sync-manual = high-priority (manual/user-triggered) — BOT-ENT-01
// gdt-bot-sync    = general/auto queue (scheduler)
let botQueue: Queue | null = null;
function getBotQueue(): Queue {
  if (!botQueue) {
    botQueue = new Queue('gdt-bot-sync', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return botQueue;
}

let manualBotQueue: Queue | null = null;
function getManualBotQueue(): Queue {
  if (!manualBotQueue) {
    // BOT-ENT-01: dedicated high-priority queue, processed by manualWorker (concurrency=10)
    manualBotQueue = new Queue('gdt-sync-manual', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return manualBotQueue;
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

      // 5-minute manual trigger cooldown (Redis key per company)
      const cooldownKey = `${MANUAL_COOLDOWN_PREFIX}${companyId}`;
      const cooldownTtl = await _redis.ttl(cooldownKey);
      if (cooldownTtl > 0) {
        res.status(429).json({
          success: false,
          error: {
            code:        'COOLDOWN',
            waitMinutes: Math.ceil(cooldownTtl / 60),
            message:     `Vui lòng chờ thêm ${Math.ceil(cooldownTtl / 60)} phút trước khi đồng bộ lại.`,
          },
        });
        return;
      }

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

      // BOT-ENT-01: Reset block state — manual sync = user explicitly wants to sync now.
      // Clears consecutive_failures + blocked_until so the job can proceed even after auto-blocks.
      await pool.query(
        `UPDATE gdt_bot_configs
         SET consecutive_failures = 0,
             blocked_until        = NULL
         WHERE company_id = $1`,
        [companyId],
      );

      const jobId = `gdt-bot-manual-${companyId}-${Date.now()}`;
      // BOT-ENT-01: Push to dedicated manual queue (high priority, concurrency=10)
      await getManualBotQueue().add('sync', {
        companyId,
        ...(from_date ? { fromDate: from_date } : {}),
        ...(to_date   ? { toDate:   to_date   } : {}),
        triggeredBy: 'user_manual',
      }, {
        jobId,
        priority: 1,           // highest priority in manual queue
        attempts: 3,
        backoff:  { type: 'exponential', delay: 30_000 },
      });

      // Set 5-minute manual-trigger cooldown key
      await _redis.set(`${MANUAL_COOLDOWN_PREFIX}${companyId}`, '1', 'EX', MANUAL_COOLDOWN_TTL_SEC);

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

// ── GET /api/bot/failed-jobs — DLQ list (ADMIN only) ─────────────────────────
router.get(
  '/failed-jobs',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;
      const { page = '1', pageSize = '50', errorType } = req.query as Record<string, string>;
      const pg     = Number(page);
      const pgSz   = Number(pageSize);
      const offset = (pg - 1) * pgSz;
      const params: unknown[] = [companyId, pgSz, offset];
      let errorFilter = '';
      if (errorType) {
        params.push(errorType);
        errorFilter = `AND error_type = $${params.length}`;
      }
      const [dataRes, countRes] = await Promise.all([
        pool.query(
          `SELECT id, company_id, run_id, error_type, error_message, failed_at, resolution, resolved_by, resolved_at
           FROM bot_failed_jobs
           WHERE company_id = $1 ${errorFilter}
           ORDER BY failed_at DESC LIMIT $2 OFFSET $3`,
          params,
        ),
        pool.query(
          `SELECT COUNT(*) FROM bot_failed_jobs WHERE company_id = $1 ${errorFilter}`,
          [companyId, ...(errorType ? [errorType] : [])],
        ),
      ]);
      sendPaginated(res, dataRes.rows, Number(countRes.rows[0].count), pg, pgSz);
    } catch (err) { next(err); }
  }
);

// ── POST /api/bot/failed-jobs/:id/resolve — mark DLQ item as resolved ────────
router.post(
  '/failed-jobs/:id/resolve',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId!;
      const userId    = req.user!.userId;
      const { resolution } = req.body as { resolution?: string };
      await pool.query(
        `UPDATE bot_failed_jobs
         SET resolution = $1, resolved_by = $2, resolved_at = NOW()
         WHERE id = $3 AND company_id = $4`,
        [resolution ?? 'manually_resolved', userId, req.params.id, companyId],
      );
      sendSuccess(res, { ok: true });
    } catch (err) { next(err); }
  }
);

// ── PATCH /api/bot/failed-jobs/:id/review — admin review with resolution ─────
router.patch(
  '/failed-jobs/:id/review',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId    = req.user!.userId;
      const { resolution } = req.body as { resolution?: string };
      await pool.query(
        `UPDATE bot_failed_jobs
         SET admin_reviewed = true, resolution = COALESCE($1, resolution),
             resolved_by = $2, resolved_at = NOW()
         WHERE id = $3`,
        [resolution ?? null, userId, req.params.id],
      );
      sendSuccess(res, { ok: true });
    } catch (err) { next(err); }
  }
);

// ── POST /api/bot/retry-job/:id — retry a single failed job ─────────────────
router.post(
  '/retry-job/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const jobRow = await pool.query(
        `SELECT company_id, job_data FROM bot_failed_jobs WHERE id = $1`,
        [req.params.id],
      );
      if (!jobRow.rows.length) throw new NotFoundError('Failed job not found');
      const { company_id, job_data } = jobRow.rows[0] as { company_id: string; job_data: Record<string, unknown> };

      const manualQ = new Queue('gdt-sync-manual', {
        connection: { url: env.REDIS_URL } as unknown,
      } as ConstructorParameters<typeof Queue>[1]);
      const job = await manualQ.add('retry', { ...job_data, tenantId: company_id, triggeredBy: 'admin_retry' }, { priority: 1 });
      await manualQ.close();

      await pool.query(
        `UPDATE bot_failed_jobs SET retry_count = retry_count + 1, resolved_by = $1,
          resolution = 'retried', resolved_at = NOW() WHERE id = $2`,
        [userId, req.params.id],
      );
      sendSuccess(res, { queued: true, jobId: job.id });
    } catch (err) { next(err); }
  }
);

// ── POST /api/bot/retry-bulk — retry all failed jobs of error type ────────────
router.post(
  '/retry-bulk',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { errorType } = req.body as { errorType?: string };
      const userId = req.user!.userId;

      const rows = await pool.query(
        `SELECT id, company_id, job_data FROM bot_failed_jobs
         WHERE admin_reviewed = false AND resolution IS NULL
           AND ($1::text IS NULL OR error_type = $1)
         LIMIT 200`,
        [errorType ?? null],
      );

      const manualQ = new Queue('gdt-sync-manual', {
        connection: { url: env.REDIS_URL } as unknown,
      } as ConstructorParameters<typeof Queue>[1]);

      let queued = 0;
      for (const row of rows.rows) {
        const r = row as { id: string; company_id: string; job_data: Record<string, unknown> };
        await manualQ.add('retry-bulk', { ...r.job_data, tenantId: r.company_id, triggeredBy: 'admin_bulk_retry' }, { priority: 2 });
        queued++;
      }
      await manualQ.close();

      if (rows.rows.length > 0) {
        const ids = (rows.rows as { id: string }[]).map(r => r.id);
        await pool.query(
          `UPDATE bot_failed_jobs SET retry_count = retry_count + 1, resolved_by = $1,
            resolution = 'retried', resolved_at = NOW() WHERE id = ANY($2)`,
          [userId, ids],
        );
      }
      sendSuccess(res, { queued });
    } catch (err) { next(err); }
  }
);

// ── DELETE /api/bot/failed-jobs/cleanup — delete old failed jobs ─────────────
router.delete(
  '/failed-jobs/cleanup',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { olderThanDays = 7 } = req.body as { olderThanDays?: number };
      const days = Math.max(1, Math.min(365, Number(olderThanDays)));
      const res2 = await pool.query(
        `DELETE FROM bot_failed_jobs WHERE failed_at < NOW() - ($1 || ' days')::INTERVAL RETURNING id`,
        [days],
      );
      sendSuccess(res, { deleted: res2.rowCount ?? 0 });
    } catch (err) { next(err); }
  }
);

// ── POST /api/bot/circuit-breaker/reset — admin reset (BOT-ENT-03) ──────────
router.post(
  '/circuit-breaker/reset',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await _redis.del('gdt:circuit_breaker:errors');
      await _redis.set('gdt:circuit_breaker:status', JSON.stringify({ tripped: false }));
      // Signal workers to resume via Redis flag — workers check this on job processing
      await _redis.set('gdt:circuit_breaker:resume', '1', 'EX', 60);
      sendSuccess(res, { reset: true, message: 'Circuit breaker reset. Workers đã tiếp tục.' });
    } catch (err) { next(err); }
  }
);

// ── POST /api/bot/reparse-failed — reparse raw XML for failed parses ─────────
router.post(
  '/reparse-failed',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = (req.body as { companyId?: string }).companyId ?? null;
      const rows = await pool.query(
        `SELECT id, company_id, invoice_number, raw_content
         FROM raw_invoice_data
         WHERE parse_status = 'failed'
           AND ($1::uuid IS NULL OR company_id = $1)
         LIMIT 1000`,
        [companyId],
      );

      let reparsed = 0;
      let stillFailed = 0;
      for (const row of rows.rows) {
        const r = row as { id: string; company_id: string; invoice_number: string; raw_content: string };
        try {
          // Re-attempt basic parse — extract key fields from XML using regex (no cheerio dependency)
          const invoiceNo = r.raw_content.match(/<shdon[^>]*>([^<]+)<\/shdon>/i)?.[1] ?? r.invoice_number;
          if (invoiceNo) {
            await pool.query(
              `UPDATE raw_invoice_data SET parse_status='success', parsed_at=NOW() WHERE id=$1`,
              [r.id],
            );
            reparsed++;
          } else {
            stillFailed++;
          }
        } catch {
          stillFailed++;
        }
      }
      sendSuccess(res, { reparsed, stillFailed });
    } catch (err) { next(err); }
  }
);

// ── GET /api/bot/metrics — admin metrics (BOT-ENT-06) ───────────────────────
router.get(
  '/metrics',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Collect last 24 hours of hourly buckets
      const hours: string[] = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const h = new Date(now.getTime() - i * 3600_000);
        hours.push(`bot:metrics:${h.toISOString().slice(0, 13)}`);
      }

      const pipeline = _redis.pipeline();
      for (const h of hours) pipeline.hgetall(h);
      pipeline.lrange('bot:metrics:durations', 0, 99);
      pipeline.get('gdt:circuit_breaker:errors');
      pipeline.get('gdt:circuit_breaker:status');
      const results = await pipeline.exec();

      const hourlyData = hours.map((hKey, i) => {
        const raw = (results?.[i]?.[1] ?? {}) as Record<string, string>;
        return {
          hour:    hKey.slice(-13),
          total:   parseInt(raw['total'] ?? '0', 10),
          success: parseInt(raw['success'] ?? '0', 10),
          failed:  parseInt(raw['failed'] ?? '0', 10),
          captcha_attempts: parseInt(raw['captcha_attempts'] ?? '0', 10),
          captcha_fails:    parseInt(raw['captcha_fails'] ?? '0', 10),
        };
      });

      const durations = ((results?.[24]?.[1] ?? []) as string[]).map(Number);
      const avgDuration = durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

      const cbErrors    = parseInt((results?.[25]?.[1] as string | null) ?? '0', 10);
      const cbStatusRaw = (results?.[26]?.[1] as string | null) ?? '{}';
      let cbStatus: Record<string, unknown> = {};
      try { cbStatus = JSON.parse(cbStatusRaw); } catch { /* */ }

      // Per-company breakdown (top 20 by last activity)
      const companies = await pool.query(
        `SELECT c.id, c.name, c.tax_code,
                b.is_active, b.last_run_at, b.last_run_status,
                b.consecutive_failures, b.blocked_until, b.next_auto_sync_at,
                (SELECT COUNT(*) FROM invoices i
                  WHERE i.company_id = c.id
                    AND i.created_at >= NOW() - INTERVAL '24 hours') AS invoices_today
         FROM gdt_bot_configs b
         JOIN companies c ON b.company_id = c.id
         ORDER BY b.last_run_at DESC NULLS LAST
         LIMIT 20`,
      );

      // Queue depth from BullMQ
      const manualQ = new Queue('gdt-sync-manual', { connection: { url: env.REDIS_URL } as unknown } as ConstructorParameters<typeof Queue>[1]);
      const autoQ   = new Queue('gdt-sync-auto',   { connection: { url: env.REDIS_URL } as unknown } as ConstructorParameters<typeof Queue>[1]);
      const [manualWaiting, autoWaiting, manualActive, autoActive] = await Promise.all([
        manualQ.getWaitingCount(),
        autoQ.getWaitingCount(),
        manualQ.getActiveCount(),
        autoQ.getActiveCount(),
      ]);
      await Promise.all([manualQ.close(), autoQ.close()]);

      // Totals for today
      const today = hourlyData.slice(hourlyData.length - 24);
      const todayTotal   = today.reduce((a, h) => a + h.total,   0);
      const todaySuccess = today.reduce((a, h) => a + h.success, 0);
      const todayFailed  = today.reduce((a, h) => a + h.failed,  0);

      // Failed jobs last 24h
      const failedCount = await pool.query(
        `SELECT COUNT(*) AS n, error_type FROM bot_failed_jobs
         WHERE failed_at >= NOW() - INTERVAL '24 hours'
         GROUP BY error_type`,
      );

      sendSuccess(res, {
        queues: { manualWaiting, manualActive, autoWaiting, autoActive },
        circuitBreaker: { errorCount: cbErrors, threshold: 20, ...cbStatus },
        hourlyData,
        summary: {
          todayTotal, todaySuccess, todayFailed,
          successRate:    todayTotal > 0 ? Math.round((todaySuccess / todayTotal) * 100) : 100,
          avgDurationMs:  avgDuration,
        },
        companies: companies.rows,
        failedByType: failedCount.rows,
      });
    } catch (err) { next(err); }
  }
);

export default router;
