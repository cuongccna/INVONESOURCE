import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { ValidationError } from '../utils/AppError';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

let _queue: Queue | null = null;
function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('gdt-bot-sync', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return _queue;
}

// Manual queue — user-triggered syncs processed with high concurrency by manualWorker
let _manualQueue: Queue | null = null;
function getManualQueue(): Queue {
  if (!_manualQueue) {
    _manualQueue = new Queue('gdt-sync-manual', {
      connection: { url: env.REDIS_URL } as unknown,
    } as ConstructorParameters<typeof Queue>[1]);
  }
  return _manualQueue;
}

/**
 * Try to find a job by ID across all bot queues: manual first, then legacy.
 * Returns [job, queue] or [null, null] if not found.
 */
async function getJobFromAnyQueue(jobId: string): Promise<{ job: Awaited<ReturnType<Queue['getJob']>>; queue: Queue } | null> {
  const queues: Queue[] = [getManualQueue(), getQueue()];
  for (const q of queues) {
    const job = await q.getJob(jobId);
    if (job) return { job, queue: q };
  }
  return null;
}

// Shared Redis client for distributed locks
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return _redis;
}
const SYNC_LOCK_PREFIX = 'sync:lock:';
const SYNC_LOCK_TTL = 30 * 60; // 30 min
const BOT_WORKER_HEARTBEAT_KEY = 'bot:worker:heartbeat';
const BOT_WORKER_OFFLINE_MESSAGE = 'BOT worker đang offline. Phiên đồng bộ đã được đóng để tránh treo trạng thái.';

async function promoteNextDelayedManualJobForUser(userId: string, removedJobId?: string): Promise<void> {
  const delayedJobs = await getManualQueue().getJobs(['delayed']);
  const nextJob = delayedJobs
    .filter((job) => {
      if (removedJobId && String(job.id ?? '') === removedJobId) return false;
      return (job.data as { triggeredByUserId?: string }).triggeredByUserId === userId;
    })
    .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))[0];

  if (!nextJob) return;

  await nextJob.promote();

  const nextRunId = (nextJob.data as { runId?: string }).runId ?? (typeof nextJob.id === 'string' ? nextJob.id : null);
  const nextCompanyId = (nextJob.data as { companyId?: string }).companyId;
  if (!nextRunId || !nextCompanyId) return;

  await Promise.all([
    pool.query(
      `UPDATE gdt_bot_runs
       SET status = 'pending',
           error_detail = NULL,
           finished_at = NULL,
           started_at = NOW()
       WHERE id = $1
         AND company_id = $2
         AND finished_at IS NULL
         AND status = 'delayed'`,
      [nextRunId, nextCompanyId],
    ),
    pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_status = 'pending',
           last_error = NULL,
           updated_at = NOW()
       WHERE company_id = $1
         AND last_run_status = 'delayed'`,
      [nextCompanyId],
    ),
  ]);
}

async function isBotWorkerAlive(): Promise<boolean> {
  try {
    return await getRedis().exists(BOT_WORKER_HEARTBEAT_KEY) === 1;
  } catch {
    // If Redis status check itself fails, do not turn that into a false offline signal.
    return true;
  }
}

async function markRunWorkerOffline(jobId: string, companyId: string): Promise<void> {
  await Promise.all([
    pool.query(
      `UPDATE gdt_bot_runs
       SET status = 'error',
           finished_at = COALESCE(finished_at, NOW()),
           error_detail = $1
       WHERE id = $2
         AND company_id = $3
         AND status IN ('pending', 'delayed', 'running')`,
      [BOT_WORKER_OFFLINE_MESSAGE, jobId, companyId],
    ),
    pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_status = 'error',
           last_error = $1,
           updated_at = NOW()
       WHERE company_id = $2
         AND last_run_status IN ('pending', 'delayed', 'running')`,
      [BOT_WORKER_OFFLINE_MESSAGE, companyId],
    ),
  ]).catch(() => undefined);
}

// ─── POST /api/sync/start — enqueue sync jobs (month or quarter) ────────────

const startSchema = z.object({
  jobs: z.array(z.object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    label: z.string().max(100),
  })).min(1).max(3),
});

// Rate limit sync starts: 5 requests per minute per user (IP-based key for simplicity)
const syncStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId ?? req.ip ?? 'unknown',
  message: { success: false, error: { code: 'RATE_LIMIT', message: 'Quá nhiều lần đồng bộ. Vui lòng thử lại sau.' } },
});

router.post('/start', syncStartLimiter, requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) throw new ValidationError('Company not associated');

    const body = startSchema.safeParse(req.body);
    if (!body.success) throw new ValidationError(body.error.issues[0]?.message ?? 'Invalid body');
    const { jobs } = body.data;

    // Check GDT Bot configured
    const cfgRes = await pool.query(
      `SELECT id, is_active FROM gdt_bot_configs WHERE company_id = $1`,
      [companyId],
    );
    if (cfgRes.rows.length === 0) {
      res.status(428).json({
        success: false,
        error: { code: 'BOT_NOT_CONFIGURED', message: 'Chưa cấu hình đồng bộ GDT.' },
      });
      return;
    }
    if (!cfgRes.rows[0].is_active) {
      res.status(403).json({
        success: false,
        error: { code: 'BOT_DISABLED', message: 'GDT Bot hiện đang tắt.' },
      });
      return;
    }

    // Atomic per-company lock via Redis SET NX EX — prevents TOCTOU race
    const redis = getRedis();
    const lockKey = `${SYNC_LOCK_PREFIX}${companyId}`;
    const lockAcquired = await redis.set(lockKey, Date.now().toString(), 'EX', SYNC_LOCK_TTL, 'NX');

    if (!lockAcquired) {
      res.status(409).json({
        success: false,
        error: { code: 'SYNC_ALREADY_RUNNING', message: 'Đang có đồng bộ đang chạy.' },
      });
      return;
    }

    // Validate each job: max 31 days
    for (const job of jobs) {
      const diff = new Date(job.toDate).getTime() - new Date(job.fromDate).getTime();
      if (diff < 0 || diff > 31 * 24 * 60 * 60 * 1000) {
        // Release lock on validation failure
        await redis.del(lockKey);
        throw new ValidationError(`Khoảng từ ${job.fromDate} → ${job.toDate} vượt quá 31 ngày.`);
      }
    }

    const queue = getManualQueue();  // user-triggered → manual queue (high priority)
    const groupId = `sync-${companyId}-${Date.now()}`;
    // Pre-compute all jobIds so the frontend can open SSE for all of them upfront.
    // Only job 0 is enqueued here — the bot chains jobs 1 and 2 sequentially after
    // each completes. This eliminates LOCK_CONFLICT on concurrent quarter jobs.
    const jobIds = jobs.map((_, i) => `${groupId}-${i}`);

    await queue.add('sync', {
      companyId,
      fromDate: jobs[0]!.fromDate,
      toDate:   jobs[0]!.toDate,
      label:    jobs[0]!.label,
      groupId,
      jobIndex: 0,
      jobTotal: jobs.length,
      allJobs:  jobs, // bot reads this to chain job 1, 2 after each completes
    }, {
      jobId:    jobIds[0],
      attempts: 6,
      backoff:  { type: 'exponential', delay: 60000 },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 50 },
    });

    sendSuccess(res, { jobIds, groupId }, 'Sync jobs queued');
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/sync/progress/:jobId — SSE endpoint ──────────────────────────
// NOTE: EventSource cannot send custom headers, so requireCompany middleware
// cannot resolve companyId. We verify ownership inline via ?companyId= query param.

router.get('/progress/:jobId', async (req: Request, res: Response) => {
  // ── Auth: verify company access BEFORE opening SSE headers ─────────────────
  const qCompanyId = typeof req.query.companyId === 'string' ? req.query.companyId : null;
  const authCompanyId = qCompanyId || req.user!.companyId;

  if (!authCompanyId) {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'companyId is required' } });
    return;
  }

  if (qCompanyId) {
    const access = await pool.query(
      'SELECT 1 FROM user_companies WHERE user_id = $1 AND company_id = $2',
      [req.user!.userId, qCompanyId],
    );
    if (access.rows.length === 0) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      return;
    }
  }

  const queue = getQueue();
  const jobId  = req.params.jobId;

  // Pre-flight: if the job exists, verify it belongs to this company.
  // Check all queues — job may be in gdt-sync-manual or legacy gdt-bot-sync.
  // If it doesn't exist yet (chained job 1 or 2), allow SSE — we send "waiting" events
  // until the bot enqueues it. Ownership will be verified when the job appears.
  // If job not found AND no qCompanyId → can't verify ownership → 404.
  const found = await getJobFromAnyQueue(jobId);
  if (found) {
    if (found.job!.data.companyId !== authCompanyId) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      return;
    }
  } else if (!qCompanyId) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const SSE_POLL_INTERVAL = 3000;
  // 20 min — enough for a full quarter sync (3 months × ~4 min each)
  const SSE_MAX_DURATION = 20 * 60 * 1000;
  const connStart = Date.now();

  const sendEvent = async () => {
    try {
      if (res.destroyed) return true;
      const result = await getJobFromAnyQueue(jobId);
      const freshJob = result?.job ?? null;

      if (!freshJob) {
        if (!(await isBotWorkerAlive())) {
          await markRunWorkerOffline(jobId, authCompanyId);
          res.write(`data: ${JSON.stringify({
            jobId,
            state: 'failed',
            progress: 0,
            invoicesFetched: 0,
            currentPage: 0,
            totalPages: null,
            currentMonth: '',
            message: 'BOT worker offline',
            error: BOT_WORKER_OFFLINE_MESSAGE,
          })}\n\n`);
          return true;
        }
      }

      if (!freshJob) {
        // Job not yet enqueued (bot is still processing the previous month in the chain).
        // Send a "waiting" event so the frontend shows "Chờ..." instead of timing out.
        if (Date.now() - connStart > SSE_MAX_DURATION) return true;
        res.write(`data: ${JSON.stringify({
          jobId,
          state: 'waiting',
          progress: 0,
          invoicesFetched: 0,
          currentPage: 0,
          totalPages: null,
          currentMonth: '',
          message: 'Chờ lượt trước hoàn thành...',
          error: null,
        })}\n\n`);
        return false;
      }

      const state = await freshJob.getState();

      if (state !== 'completed' && state !== 'failed' && !(await isBotWorkerAlive())) {
        const progress = freshJob.progress as Record<string, unknown> | number;
        const progressData = typeof progress === 'object' ? progress : { percent: progress };

        await markRunWorkerOffline(jobId, authCompanyId);
        res.write(`data: ${JSON.stringify({
          jobId: freshJob.id,
          state: 'failed',
          progress: typeof progress === 'number' ? progress : (progressData.percent ?? 0),
          invoicesFetched: progressData.invoicesFetched ?? 0,
          currentPage: progressData.currentPage ?? 0,
          totalPages: progressData.totalPages ?? null,
          currentMonth: freshJob.data.label ?? '',
          message: 'BOT worker offline',
          error: BOT_WORKER_OFFLINE_MESSAGE,
        })}\n\n`);
        return true;
      }

      const progress = freshJob.progress as Record<string, unknown> | number;
      const progressData = typeof progress === 'object' ? progress : { percent: progress };

      const event = {
        jobId: freshJob.id,
        state,
        progress: typeof progress === 'number' ? progress : (progressData.percent ?? 0),
        invoicesFetched: progressData.invoicesFetched ?? 0,
        currentPage: progressData.currentPage ?? 0,
        totalPages: progressData.totalPages ?? null,
        currentMonth: freshJob.data.label ?? '',
        message: progressData.statusMessage ?? '',
        error: freshJob.failedReason ?? null,
      };

      res.write(`data: ${JSON.stringify(event)}\n\n`);

      if (state === 'completed' || state === 'failed') {
        return true;
      }
      // Auto-close if exceeding max duration
      if (Date.now() - connStart > SSE_MAX_DURATION) {
        res.write(`data: ${JSON.stringify({ ...event, message: 'Connection timeout — refresh to reconnect' })}\n\n`);
        return true;
      }
      return false;
    } catch {
      return true;
    }
  };

  // Send initial event immediately
  const done = await sendEvent();
  if (done) { res.end(); return; }

  const interval = setInterval(async () => {
    const finished = await sendEvent();
    if (finished) {
      clearInterval(interval);
      res.end();
    }
  }, SSE_POLL_INTERVAL);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// ─── DELETE /api/sync/cancel — stop a running sync ───────────────────────────
// Removes all pending/delayed jobs for the company, releases Redis locks,
// and sets a bot:sync:cancel:{companyId} key that the worker checks each loop.

router.delete('/cancel', requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) throw new ValidationError('Company not associated');

    const queue       = getQueue();
    const manualQueue = getManualQueue();
    const redis       = getRedis();

    // Remove waiting/delayed jobs from both queues
    const [activeJobs, waitingJobs, delayedJobs,
           manualActive, manualWaiting, manualDelayed] = await Promise.all([
      queue.getJobs(['active']),
      queue.getJobs(['waiting']),
      queue.getJobs(['delayed']),
      manualQueue.getJobs(['active']),
      manualQueue.getJobs(['waiting']),
      manualQueue.getJobs(['delayed']),
    ]);
    let removed = 0;
    const cancelledManualUsers = new Map<string, string>();
    for (const j of [...waitingJobs, ...delayedJobs, ...manualWaiting, ...manualDelayed]) {
      if (j.data.companyId === companyId) {
        if ([...manualWaiting, ...manualDelayed].includes(j)) {
          const userId = (j.data as { triggeredByUserId?: string }).triggeredByUserId;
          if (userId) {
            cancelledManualUsers.set(userId, String(j.id ?? ''));
          }
        }
        try { await j.remove(); removed++; } catch { /* ignore */ }
      }
    }
    // Active jobs: can't remove, but signal cancellation
    const allActive = [...activeJobs, ...manualActive];
    const activeCount = allActive.filter(j => j.data.companyId === companyId).length;

    // 2. Release locks so a new sync can start after cancellation
    await Promise.all([
      redis.del(`${SYNC_LOCK_PREFIX}${companyId}`),
      redis.del(`bot:sync:lock:${companyId}`),
    ]);

    // 3. Set cancellation signal — worker checks this key each invoice loop iteration
    //    TTL: 10 min — enough to reach the next check point in any active job
    await redis.set(`bot:sync:cancel:${companyId}`, '1', 'EX', 10 * 60);

    if (removed > 0) {
      await pool.query(
        `UPDATE gdt_bot_runs
         SET status = 'cancelled',
             finished_at = NOW(),
             error_detail = COALESCE(error_detail, 'Đã hủy trước khi bắt đầu')
         WHERE company_id = $1
           AND finished_at IS NULL
           AND status IN ('pending', 'delayed')`,
        [companyId],
      ).catch(() => undefined);
    }

    if (removed > 0 || activeCount > 0) {
      await pool.query(
        `UPDATE gdt_bot_configs
         SET last_run_status = 'cancelled',
             last_error = NULL,
             updated_at = NOW()
         WHERE company_id = $1`,
        [companyId],
      ).catch(() => undefined);
    }

    await Promise.all(
      [...cancelledManualUsers.entries()].map(([userId, removedJobId]) => {
        return promoteNextDelayedManualJobForUser(userId, removedJobId).catch(() => undefined);
      }),
    );

    sendSuccess(res, { removed, activeCount }, activeCount > 0
      ? `Đã hủy ${removed} job đang chờ. Job đang chạy sẽ dừng trong giây lát.`
      : `Đã hủy ${removed} job.`
    );
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/sync/clear-stale — force-remove stale jobs ─────────────────

router.delete('/clear-stale', requireRole('OWNER', 'ADMIN'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const companyId = req.user!.companyId;
    if (!companyId) throw new ValidationError('Company not associated');

    const queue       = getQueue();
    const manualQueue = getManualQueue();
    const [activeJobs, waitingJobs, delayedJobs,
           mActive, mWaiting, mDelayed] = await Promise.all([
      queue.getJobs(['active']),
      queue.getJobs(['waiting']),
      queue.getJobs(['delayed']),
      manualQueue.getJobs(['active']),
      manualQueue.getJobs(['waiting']),
      manualQueue.getJobs(['delayed']),
    ]);

    let removed = 0;
    for (const j of [...activeJobs, ...waitingJobs, ...delayedJobs, ...mActive, ...mWaiting, ...mDelayed]) {
      if (j.data.companyId === companyId) {
        try { await j.remove(); removed++; } catch { /* ignore */ }
      }
    }

    // Release the Redis distributed lock so a new sync can start
    const redis = getRedis();
    await redis.del(`${SYNC_LOCK_PREFIX}${companyId}`);

    sendSuccess(res, { removed }, `Đã xóa ${removed} job cũ`);
  } catch (err) {
    next(err);
  }
});

export default router;
