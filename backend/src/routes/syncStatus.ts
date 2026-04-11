/**
 * syncStatus.ts — GDT Raw Cache Sync Status & Control API
 *
 * Routes:
 *   GET /api/sync-status/status/:mst         — cache freshness for all periods
 *   POST /api/sync-status/trigger            — force immediate sync
 *   GET /api/sync-status/job/:jobId/status   — SSE stream for job progress
 *   GET /api/sync-status/history/:mst        — last 50 sync log entries
 *
 * Security:
 *   - All routes require valid JWT (authenticate middleware)
 *   - :mst must belong to authenticated user's company/org
 *
 * SSE (Server-Sent Events):
 *   Worker publishes progress to Redis channel: gdt-raw-cache-job:{jobId}
 *   SSE endpoint subscribes and streams to client.
 *   Auto-closes after 'complete' or 'error' event, or after 10min timeout.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import Redis from 'ioredis';
import { authenticate } from '../middleware/auth';
import { ValidationError, ForbiddenError } from '../utils/AppError';
import { sendSuccess } from '../utils/response';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { GdtDataBridge } from '../services/gdtDataBridge';
import { getActiveSyncStatus, getSyncHistory } from '../services/syncQueueGuard';
import { gdtRawCacheSyncQueue } from '../jobs/GdtRawCacheSyncWorker';

const router = Router();
router.use(authenticate);

// ─── Redis (sub + pub clients) ────────────────────────────────────────────────

let _redisPub: Redis | null = null;
function getPub(): Redis {
  if (!_redisPub) {
    _redisPub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return _redisPub;
}

// ─── MST ownership guard ──────────────────────────────────────────────────────

async function assertMstBelongsToUser(mst: string, userId: string): Promise<string> {
  const res = await pool.query<{ id: string; tax_code: string }>(
    `SELECT c.id, c.tax_code
     FROM companies c
     JOIN user_companies cu ON cu.company_id = c.id
     WHERE cu.user_id = $1 AND c.tax_code = $2 AND c.deleted_at IS NULL
     LIMIT 1`,
    [userId, mst],
  );
  if (res.rowCount === 0) {
    throw new ForbiddenError('MST không thuộc quyền truy cập của bạn');
  }
  return res.rows[0].id;
}

// ─── GET /api/sync-status/status/:mst ────────────────────────────────────────

router.get(
  '/status/:mst',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mst } = req.params;
      if (!/^\d{10}(-\d{3})?$/.test(mst)) throw new ValidationError('MST không hợp lệ');

      await assertMstBelongsToUser(mst, req.user!.userId);

      const yearParam = typeof req.query.year === 'string'
        ? parseInt(req.query.year, 10)
        : new Date().getFullYear();

      const [periods, activeJobs] = await Promise.all([
        GdtDataBridge.getPeriodSummary(mst, yearParam),
        getActiveSyncStatus(mst),
      ]);

      sendSuccess(res, { mst, year: yearParam, periods, activeJobs });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/sync-status/trigger ───────────────────────────────────────────

const triggerSchema = z.object({
  mst:         z.string().regex(/^\d{10}(-\d{3})?$/, 'MST không hợp lệ'),
  invoiceType: z.enum(['purchase', 'sale']),
  periodYear:  z.number().int().min(2020).max(2100),
  periodMonth: z.number().int().min(1).max(12).nullable().optional(),
});

router.post(
  '/trigger',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = triggerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ');
      }

      const { mst, invoiceType, periodYear, periodMonth } = parsed.data;

      await assertMstBelongsToUser(mst, req.user!.userId);

      const result = await GdtDataBridge.triggerForceSync(
        mst,
        invoiceType,
        periodYear,
        periodMonth ?? undefined,
      );

      sendSuccess(res, {
        jobId:          result.jobId,
        alreadyRunning: result.alreadyRunning,
        message:        result.alreadyRunning
          ? 'Đang đồng bộ, vui lòng chờ...'
          : 'Đã bắt đầu đồng bộ. Theo dõi tiến trình qua SSE.',
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/sync-status/job/:jobId/status  (SSE) ───────────────────────────

const SSE_TIMEOUT_MS     = 10 * 60 * 1000;  // 10 minutes max
const SSE_HEARTBEAT_MS   = 30 * 1000;        // 30s heartbeat to keep connection alive

router.get(
  '/job/:jobId/status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { jobId } = req.params;
      if (!jobId || jobId.length > 200) throw new ValidationError('jobId không hợp lệ');

      // Set SSE headers
      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const sendEvent = (event: string, data: Record<string, unknown>): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // @ts-expect-error — flush exists on compressed responses
        if (typeof res.flush === 'function') res.flush();
      };

      // ── Check if job already completed ──
      const job = await gdtRawCacheSyncQueue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        if (state === 'completed') {
          sendEvent('complete', { jobId, status: 'completed', returnvalue: job.returnvalue });
          res.end();
          return;
        }
        if (state === 'failed') {
          sendEvent('error', { jobId, message: job.failedReason ?? 'Job failed' });
          res.end();
          return;
        }
      }

      // ── Subscribe to Redis pub/sub for live updates ──
      const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1 });
      const channel = `gdt-raw-cache-job:${jobId}`;

      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        sub.unsubscribe(channel).catch(() => {/* ignore */});
        sub.quit().catch(() => {/* ignore */});
        if (!res.writableEnded) res.end();
      };

      req.on('close', cleanup);

      await sub.subscribe(channel);

      sub.on('message', (_ch: string, message: string) => {
        try {
          const payload = JSON.parse(message) as Record<string, unknown>;
          const event   = (payload['event'] as string) ?? 'progress';
          sendEvent(event, payload);
          if (event === 'complete' || event === 'error') {
            cleanup();
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Heartbeat: prevent proxy/LB from closing idle SSE connections
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(': heartbeat\n\n');
          // @ts-expect-error — flush exists on compressed responses
          if (typeof res.flush === 'function') res.flush();
        }
      }, SSE_HEARTBEAT_MS);

      // Safety timeout
      const timeout = setTimeout(() => {
        sendEvent('error', { message: 'Timeout: job took too long, please check status manually.' });
        cleanup();
      }, SSE_TIMEOUT_MS);

    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/sync-status/history/:mst ───────────────────────────────────────

router.get(
  '/history/:mst',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { mst } = req.params;
      if (!/^\d{10}(-\d{3})?$/.test(mst)) throw new ValidationError('MST không hợp lệ');

      await assertMstBelongsToUser(mst, req.user!.userId);

      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
      const history = await getSyncHistory(mst, limit);

      sendSuccess(res, { mst, history });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Helper: Worker publishes progress event ─────────────────────────────────

/**
 * Publish a progress event from the worker to the SSE channel.
 * Call this from GdtRawCacheSyncWorker during processing.
 *
 * Usage: await publishJobProgress(jobId, { step: 'processing', count: 45, total: 100 })
 */
export async function publishJobProgress(
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const pub = getPub();
  const channel = `gdt-raw-cache-job:${jobId}`;
  await pub.publish(channel, JSON.stringify({ event: 'progress', jobId, ...payload }));
}

export async function publishJobComplete(
  jobId: string,
  stats: { updated: number; skipped: number; duration: number },
): Promise<void> {
  const pub = getPub();
  const channel = `gdt-raw-cache-job:${jobId}`;
  await pub.publish(channel, JSON.stringify({ event: 'complete', jobId, ...stats }));
}

export async function publishJobError(jobId: string, message: string): Promise<void> {
  const pub = getPub();
  const channel = `gdt-raw-cache-job:${jobId}`;
  await pub.publish(channel, JSON.stringify({ event: 'error', jobId, message }));
}

export default router;
