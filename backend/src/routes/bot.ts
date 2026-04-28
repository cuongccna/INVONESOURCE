import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { encrypt, decrypt } from '../utils/encryption';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess, sendPaginated } from '../utils/response';
import { quotaService } from '../services/QuotaService';
import { licenseService } from '../services/LicenseService';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';

const _redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
const BOT_WORKER_HEARTBEAT_KEY     = 'bot:worker:heartbeat';
const STALE_RUN_GRACE_MS           = 15_000;
const BOT_WORKER_OFFLINE_MESSAGE   = 'BOT worker đang tắt hoặc vừa restart. Phiên treo đã được đóng, bạn có thể chạy lại khi worker sẵn sàng.';
const BOT_MISSING_JOB_MESSAGE      = 'BOT job cũ không còn trong queue. Phiên treo đã được đóng để mở lại thao tác UI.';
const MANUAL_USER_SERIAL_DELAY_MS  = 40 * 60 * 1000;

const router = Router();
router.use(authenticate);

// ── BOT-REFACTOR-04: Phase 2 progress routes (user-scoped, no requireCompany) ─

/** Max companies that can be actively processing detail simultaneously. */
const MAX_CONCURRENT_COMPANIES = 20;

/**
 * GET /api/bot/users/me/sync-status
 * Returns aggregate Phase 2 detail-fetch progress for ALL companies the user has access to.
 *
 * Response shape:
 *   { total, pending, processing, done, failed, skipped, byCompany: [...] }
 *
 * Only considers rows enqueued in the last 48 hours so the response stays relevant.
 */
router.get('/users/me/sync-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      return;
    }

    // Aggregate over all companies the user has access to (last 48h of queue rows)
    const aggRes = await pool.query<{
      total:      string;
      pending:    string;
      processing: string;
      done:       string;
      failed:     string;
      skipped:    string;
    }>(
      `SELECT
         COUNT(*)                                       AS total,
         COUNT(*) FILTER (WHERE q.status = 'pending')  AS pending,
         COUNT(*) FILTER (WHERE q.status = 'processing') AS processing,
         COUNT(*) FILTER (WHERE q.status = 'done')     AS done,
         COUNT(*) FILTER (WHERE q.status = 'failed')   AS failed,
         COUNT(*) FILTER (WHERE q.status = 'skipped')  AS skipped
       FROM invoice_detail_queue q
       JOIN user_companies uc ON uc.company_id = q.company_id
       WHERE uc.user_id      = $1
         AND q.enqueued_at  > NOW() - INTERVAL '48 hours'`,
      [userId],
    );
    const agg = aggRes.rows[0] ?? { total: '0', pending: '0', processing: '0', done: '0', failed: '0', skipped: '0' };

    // Per-company breakdown with real tax_code display
    const byCompanyRes = await pool.query<{
      company_id:   string;
      tax_code:     string;
      company_name: string;
      total:        string;
      pending:      string;
      processing:   string;
      done:         string;
      failed:       string;
      skipped:      string;
    }>(
      `SELECT
         q.company_id,
         co.tax_code,
         co.name                                              AS company_name,
         COUNT(*)                                             AS total,
         COUNT(*) FILTER (WHERE q.status = 'pending')        AS pending,
         COUNT(*) FILTER (WHERE q.status = 'processing')     AS processing,
         COUNT(*) FILTER (WHERE q.status = 'done')           AS done,
         COUNT(*) FILTER (WHERE q.status = 'failed')         AS failed,
         COUNT(*) FILTER (WHERE q.status = 'skipped')        AS skipped
       FROM invoice_detail_queue q
       JOIN user_companies uc ON uc.company_id = q.company_id
       JOIN companies co      ON co.id          = q.company_id
       WHERE uc.user_id      = $1
         AND q.enqueued_at  > NOW() - INTERVAL '48 hours'
       GROUP BY q.company_id, co.tax_code, co.name
       ORDER BY total DESC
       LIMIT $2`,
      [userId, MAX_CONCURRENT_COMPANIES],
    );

    sendSuccess(res, {
      total:      parseInt(agg.total,      10),
      pending:    parseInt(agg.pending,    10),
      processing: parseInt(agg.processing, 10),
      done:       parseInt(agg.done,       10),
      failed:     parseInt(agg.failed,     10),
      skipped:    parseInt(agg.skipped,    10),
      byCompany:  byCompanyRes.rows.map(r => ({
        companyId:   r.company_id,
        taxCode:     r.tax_code,
        companyName: r.company_name,
        total:       parseInt(r.total,      10),
        pending:     parseInt(r.pending,    10),
        processing:  parseInt(r.processing, 10),
        done:        parseInt(r.done,       10),
        failed:      parseInt(r.failed,     10),
        skipped:     parseInt(r.skipped,    10),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/bot/users/me/sync-status/retry
 * Resets all failed detail-queue rows (for user's companies) back to pending
 * so detail.worker will retry them.
 *
 * Only resets rows where attempts < max_attempts.
 * Returns { reset: number } — count of rows reset.
 */
router.post('/users/me/sync-status/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as Request & { user?: { id: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      return;
    }

    const retryRes = await pool.query<{ count: string }>(
      `WITH resetted AS (
         UPDATE invoice_detail_queue q
         SET status = 'pending', last_error = NULL
         FROM user_companies uc
         WHERE uc.company_id = q.company_id
           AND uc.user_id    = $1
           AND q.status      = 'failed'
           AND q.attempts    < q.max_attempts
         RETURNING q.id
       )
       SELECT COUNT(*) AS count FROM resetted`,
      [userId],
    );
    const reset = parseInt(retryRes.rows[0]?.count ?? '0', 10);
    sendSuccess(res, { reset });
  } catch (err) {
    next(err);
  }
});

// ── End Phase 2 progress routes ──────────────────────────────────────────────

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

let autoBotQueue: Queue | null = null;
function getAutoBotQueue(): Queue {
  if (!autoBotQueue) {
    autoBotQueue = new Queue('gdt-sync-auto', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return autoBotQueue;
}

async function getSyncJobFromAnyQueue(jobId: string): Promise<{ job: Awaited<ReturnType<Queue['getJob']>>; queue: Queue } | null> {
  const queues: Queue[] = [getManualBotQueue(), getAutoBotQueue(), getBotQueue()];
  for (const queue of queues) {
    const job = await queue.getJob(jobId);
    if (job) return { job, queue };
  }
  return null;
}

type ManualBotJobData = {
  companyId?: string;
  triggeredByUserId?: string;
  runId?: string;
};

async function findBlockingManualJobForUser(userId: string): Promise<{ jobId: string; companyId: string; state: string } | null> {
  const jobs = await getManualBotQueue().getJobs(['active', 'waiting', 'delayed']);
  const match = jobs
    .map((job) => ({ job, data: job.data as ManualBotJobData }))
    .filter(({ data }) => data.triggeredByUserId === userId && typeof data.companyId === 'string')
    .sort((left, right) => (left.job.timestamp ?? 0) - (right.job.timestamp ?? 0))[0];

  if (!match) return null;

  const state = await match.job.getState().catch(() => 'waiting');
  return {
    jobId: String(match.job.id ?? match.data.runId ?? ''),
    companyId: match.data.companyId!,
    state,
  };
}

async function isBotWorkerAlive(): Promise<boolean> {
  try {
    return await _redis.exists(BOT_WORKER_HEARTBEAT_KEY) === 1;
  } catch {
    return true;
  }
}

async function finalizeStaleRun(companyId: string, runId: string, message: string): Promise<void> {
  await Promise.all([
    pool.query(
      `UPDATE gdt_bot_runs
       SET status = 'error',
           finished_at = COALESCE(finished_at, NOW()),
           error_detail = $1
       WHERE id = $2
         AND company_id = $3
         AND finished_at IS NULL
         AND status IN ('pending', 'delayed', 'running')`,
      [message, runId, companyId],
    ),
    pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_status = 'error',
           last_error = $1,
           updated_at = NOW()
       WHERE company_id = $2
         AND last_run_status IN ('pending', 'delayed', 'running')`,
      [message, companyId],
    ),
  ]);
}

async function reconcileCompanySyncState(companyId: string): Promise<void> {
  const activeRunRes = await pool.query<{
    id: string;
    status: string;
    started_at: string;
  }>(
    `SELECT id, status, started_at
     FROM gdt_bot_runs
     WHERE company_id = $1
       AND finished_at IS NULL
       AND status IN ('pending', 'delayed', 'running')
     ORDER BY started_at DESC
     LIMIT 1`,
    [companyId],
  );

  const activeRun = activeRunRes.rows[0];
  if (!activeRun) return;

  const runAgeMs = Date.now() - new Date(activeRun.started_at).getTime();
  if (runAgeMs < STALE_RUN_GRACE_MS) return;

  const workerAlive = await isBotWorkerAlive();
  if (!workerAlive) {
    await finalizeStaleRun(companyId, activeRun.id, BOT_WORKER_OFFLINE_MESSAGE);
    return;
  }

  const queued = await getSyncJobFromAnyQueue(activeRun.id);
  if (!queued) {
    await finalizeStaleRun(companyId, activeRun.id, BOT_MISSING_JOB_MESSAGE);
    return;
  }

  const queueState = await queued.job!.getState();
  if (queueState === 'failed') {
    await finalizeStaleRun(
      companyId,
      activeRun.id,
      queued.job!.failedReason || 'BOT job failed before DB status could be updated.',
    );
    return;
  }

  if (queueState === 'completed') {
    await Promise.all([
      pool.query(
        `UPDATE gdt_bot_runs
         SET status = 'success',
             finished_at = COALESCE(finished_at, NOW())
         WHERE id = $1
           AND company_id = $2
           AND finished_at IS NULL
           AND status IN ('pending', 'delayed', 'running')`,
        [activeRun.id, companyId],
      ),
      pool.query(
        `UPDATE gdt_bot_configs
         SET last_run_status = 'success',
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $1
           AND last_run_status IN ('pending', 'delayed', 'running')`,
        [companyId],
      ),
    ]);
  }
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
  quick:     z.boolean().optional().default(false),  // true = Đồng bộ hôm nay (5-min cooldown riêng)
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

      // Fetch company tax code and type
      const compRes = await pool.query(`SELECT tax_code, company_type FROM companies WHERE id = $1`, [companyId]);
      if (compRes.rows.length === 0) throw new NotFoundError('Company not found');
      const taxCode: string    = compRes.rows[0].tax_code;
      const companyType: string = compRes.rows[0].company_type ?? 'enterprise';

      // Validate tax code based on company type:
      //   HKD (household): 9–13 chữ số thuần (CMND 9 số / MST 10 số / CCCD 12 số / HKD 13 số)
      //   DN / Chi nhánh:  10 chữ số, hoặc 10+"-"+3 cho chi nhánh (vd: 0123456789-001)
      const isHousehold = companyType === 'household';
      const validTaxCode = isHousehold
        ? /^\d{9,13}$/.test(taxCode)
        : /^\d{10}(-\d{3})?$/.test(taxCode);
      if (!validTaxCode) {
        const hint = isHousehold
          ? 'Hộ kinh doanh: MST phải là 9–13 chữ số.'
          : 'Doanh nghiệp: MST phải là 10 chữ số (hoặc 10+"-"+3 cho chi nhánh).';
        throw new ValidationError(`Mã số thuế không hợp lệ — ${hint} Vui lòng cập nhật hồ sơ công ty trước.`);
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

      // NOTE: No auto-enqueue on setup — user triggers first sync via "Lấy từ GDT" button.
      // Auto-enqueuing caused a LOCK_CONFLICT race: the first-run job (legacy queue) and the
      // user's manual-trigger job (manual queue) would both start simultaneously for the same
      // company, resulting in one job wasting a GDT login and the other failing with LOCK_CONFLICT.

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
      if (!companyId) throw new ValidationError('Company not associated');

      await reconcileCompanySyncState(companyId);

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

      // ── Quota info for warning banner ─────────────────────────────────────
      const userId = req.user!.userId;
      const quotaRes = await pool.query(
        `SELECT us.quota_used, us.quota_total, us.quota_reset_at
         FROM user_subscriptions us
         WHERE us.user_id = $1 AND us.status IN ('active', 'trial')
         ORDER BY us.created_at DESC LIMIT 1`,
        [userId]
      );
      const quotaInfo = quotaRes.rows.length > 0 ? {
        quota_used:      Number(quotaRes.rows[0].quota_used),
        quota_total:     Number(quotaRes.rows[0].quota_total),
        quota_reset_at:  quotaRes.rows[0].quota_reset_at,
      } : null;

      // ── Proxy assignment check ────────────────────────────────────────────
      // Only enforce when at least one active static proxy exists in the pool.
      const poolCountRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM static_proxies WHERE status = 'active'`
      );
      const poolHasProxies = Number(poolCountRes.rows[0].cnt) > 0;
      let proxyAssigned = true; // default: no enforcement when pool is empty
      if (poolHasProxies) {
        const assignedRes = await pool.query(
          `SELECT proxy_id FROM proxy_user_assignments_v2 WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        proxyAssigned = assignedRes.rowCount !== null && assignedRes.rowCount > 0;
      }

      sendSuccess(res, {
        config:                cfgRes.rows[0] ?? null,
        lastRuns:              runsRes.rows,
        manualCooldownSec:     0,
        quickSyncCooldownSec:  0,
        quotaInfo,
        proxyAssigned,
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

      const parsed = runNowSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');
      const { from_date, to_date, quick } = parsed.data;

      const cfgRes = await pool.query(
        `SELECT id, is_active, last_run_at FROM gdt_bot_configs WHERE company_id = $1`,
        [companyId]
      );
      if (cfgRes.rows.length === 0) throw new NotFoundError('GDT Bot chưa được cấu hình');
      if (!cfgRes.rows[0].is_active) throw new ValidationError('GDT Bot hiện đang tắt');

      // ── Quota pre-check: fail fast before enqueuing ────────────────────────
      // The bot worker also checks quota, but pre-checking here gives the user
      // immediate feedback instead of a delayed job failure.
      try {
        await quotaService.checkCanSync(req.user!.userId);
      } catch (quotaErr) {
        // Re-throw as-is — QuotaExceededError (429) or SubscriptionRequiredError (403)
        throw quotaErr;
      }

      // ── Static proxy enforcement ──────────────────────────────────────────
      // Only enforce when the pool has at least one active proxy. This avoids
      // blocking all users during initial setup before any proxies are added.
      const poolCountRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM static_proxies WHERE status = 'active'`
      );
      if (Number(poolCountRes.rows[0].cnt) > 0) {
        const proxyRow = await pool.query(
          `SELECT proxy_id FROM proxy_user_assignments_v2 WHERE user_id = $1 LIMIT 1`,
          [req.user!.userId]
        );
        if (proxyRow.rowCount === 0) {
          res.status(403).json({
            success: false,
            error: {
              code:    'NO_PROXY_ASSIGNED',
              message: 'Tài khoản chưa được cấp IP tĩnh. Vui lòng liên hệ Admin để được gán quyền đồng bộ.',
            },
          });
          return;
        }
      }

      const queuedRunRes = await pool.query<{ id: string; status: string }>(
        `SELECT id, status
         FROM gdt_bot_runs
         WHERE company_id = $1
           AND finished_at IS NULL
           AND status IN ('pending', 'delayed')
         ORDER BY started_at DESC
         LIMIT 1`,
        [companyId],
      );
      if (queuedRunRes.rowCount !== null && queuedRunRes.rowCount > 0) {
        res.status(409).json({
          success: false,
          error: {
            code:    'ALREADY_RUNNING',
            message: 'Bot đã có một phiên đồng bộ đang chờ trong hàng. Vui lòng đợi phiên đó bắt đầu hoặc hủy trước khi tạo phiên mới.',
          },
        });
        return;
      }

      // Check if a job is currently RUNNING for this company (Redis lock held by worker).
      // If so, return 409 immediately — no point enqueuing a job that will fail with LOCK_CONFLICT.
      const syncLockKey = `bot:sync:lock:${companyId}`;
      const isLocked = await _redis.exists(syncLockKey);
      if (isLocked) {
        res.status(409).json({
          success: false,
          error: {
            code:    'ALREADY_RUNNING',
            message: 'Bot đang chạy job đồng bộ cho công ty này. Vui lòng đợi hoàn tất rồi thử lại.',
          },
        });
        return;
      }

      // BOT-ENT-01: Reset block state — manual sync = user explicitly wants to sync now.
      // Clears consecutive_failures + blocked_until so the job can proceed even after auto-blocks.
      if (!quick) {
        await pool.query(
          `UPDATE gdt_bot_configs
           SET consecutive_failures = 0,
               blocked_until        = NULL
           WHERE company_id = $1`,
          [companyId],
        );
      }

      const runId = uuidv4();
      const blockingManualRun = await findBlockingManualJobForUser(req.user!.userId);
      const initialDelayMs = blockingManualRun ? MANUAL_USER_SERIAL_DELAY_MS : 0;
      const estimatedStartAt = initialDelayMs > 0 ? null : new Date();
      const queuedStatus = initialDelayMs > 0 ? 'delayed' : 'pending';
      // BOT-LICENSE-01: resolve user plan for proper rate limiting in the worker
      const userPlan = await licenseService.getPlanId(req.user!.userId);
      await pool.query(
        `INSERT INTO gdt_bot_runs (id, company_id, started_at, status)
         VALUES ($1, $2, NOW(), $3)`,
        [runId, companyId, queuedStatus],
      );

      try {
        // BOT-ENT-01: Push to dedicated manual queue (high priority, concurrency=10)
        await getManualBotQueue().add('sync', {
          companyId,
          runId,
          triggeredByUserId: req.user!.userId,  // BUG2 FIX: proxy acquired for triggering user
          userPlan,
          ...(from_date ? { fromDate: from_date } : {}),
          ...(to_date   ? { toDate:   to_date   } : {}),
          triggeredBy: quick ? 'user_quick_sync' : 'user_manual',
        }, {
          jobId: runId,
          ...(initialDelayMs > 0 ? { delay: initialDelayMs } : {}),
          priority: 1,            // highest priority in manual queue
          attempts: 3,
          backoff:  { type: 'exponential', delay: 30_000 },
        });
      } catch (queueErr) {
        await pool.query(`DELETE FROM gdt_bot_runs WHERE id = $1`, [runId]).catch(() => undefined);
        throw queueErr;
      }

      await pool.query(
        `UPDATE gdt_bot_configs
         SET last_run_status = $1,
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $2`,
        [queuedStatus, companyId],
      ).catch(() => undefined);

      sendSuccess(res, {
        queued:            true,
        jobId:             runId,
        quick:             quick ?? false,
        runStatus:         queuedStatus,
        delayed_sec:       initialDelayMs > 0 ? Math.round(initialDelayMs / 1000) : 0,
        estimated_start:   estimatedStartAt?.toISOString() ?? null,
      });
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
      if (!companyId) throw new ValidationError('Company not associated');

      await reconcileCompanySyncState(companyId);

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

// ── GET /api/bot/invoice-count — so sánh số HĐ trong DB vs lần sync cuối ───────
// Trả về: db_output, db_input, last_run_output, last_run_input, last_run_at
// Người dùng dùng để phát hiện hóa đơn bị thiếu sau khi bot đồng bộ.
router.get(
  '/invoice-count',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const companyId = req.user!.companyId;
      if (!companyId) throw new ValidationError('Company not associated');

      const fromDate = req.query['fromDate'] as string | undefined;
      const toDate   = req.query['toDate']   as string | undefined;

      const dateFilter = fromDate && toDate
        ? `AND invoice_date BETWEEN $2::date AND $3::date`
        : fromDate
          ? `AND invoice_date >= $2::date`
          : toDate
            ? `AND invoice_date <= $2::date`
            : '';
      const dateParams: unknown[] = fromDate && toDate
        ? [companyId, fromDate, toDate]
        : fromDate
          ? [companyId, fromDate]
          : toDate
            ? [companyId, toDate]
            : [companyId];

      const [dbCountRes, lastRunRes] = await Promise.all([
        pool.query<{ output: string; input: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE direction = 'output') AS output,
             COUNT(*) FILTER (WHERE direction = 'input')  AS input
           FROM invoices
           WHERE company_id = $1
             AND deleted_at IS NULL
             AND status NOT IN ('cancelled', 'replaced')
             ${dateFilter}`,
          dateParams,
        ),
        pool.query<{
          output_count: number; input_count: number; started_at: string; status: string;
        }>(
          `SELECT output_count, input_count, started_at, status
           FROM gdt_bot_runs
           WHERE company_id = $1 AND status = 'success'
           ORDER BY started_at DESC LIMIT 1`,
          [companyId],
        ),
      ]);

      const dbOutput  = parseInt(dbCountRes.rows[0]?.output ?? '0', 10);
      const dbInput   = parseInt(dbCountRes.rows[0]?.input  ?? '0', 10);
      const lastRun   = lastRunRes.rows[0] ?? null;

      sendSuccess(res, {
        db_output:       dbOutput,
        db_input:        dbInput,
        db_total:        dbOutput + dbInput,
        last_run_output: lastRun?.output_count ?? null,
        last_run_input:  lastRun?.input_count  ?? null,
        last_run_total:  lastRun ? (lastRun.output_count + lastRun.input_count) : null,
        last_run_at:     lastRun?.started_at ?? null,
        from_date:       fromDate ?? null,
        to_date:         toDate   ?? null,
      });
    } catch (err) { next(err); }
  }
);

export default router;
