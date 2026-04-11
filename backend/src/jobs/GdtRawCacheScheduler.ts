/**
 * GdtRawCacheScheduler.ts
 *
 * Schedules background GDT raw cache sync jobs for all active companies.
 * Runs every 15 minutes (tick), checks freshness per MST × invoice_type × period,
 * and enqueues sync jobs with appropriate priority and refresh intervals.
 *
 * Refresh intervals:
 *   Current month   → every 4 hours  (data changes frequently during month)
 *   Previous months → every 24 hours (data rarely changes)
 *   >3 months ago   → every 72 hours (historical, very rare changes)
 *   User-triggered  → immediate (priority=high)
 *
 * Anti-patterns prevented:
 *   - Max 3 active jobs per MST simultaneously
 *   - Stagger: max 10 MSTs per tick (spread load)
 *   - If sync lock already held → skip (syncQueueGuard ensures dedup)
 *
 * Does NOT modify any existing table or service other than gdt_raw_cache + gdt_sync_queue_log.
 */

import { Queue, Worker, Job } from 'bullmq';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';
import {
  tryAcquireSyncLock,
  setJobId,
  type SyncTriggeredBy,
} from '../services/syncQueueGuard';
import {
  gdtRawCacheSyncQueue,
  RAW_CACHE_QUEUE_NAME,
  type GdtRawCacheSyncJobPayload,
} from './GdtRawCacheSyncWorker';
import { getCacheMeta } from '../services/gdtRawCacheService';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEDULER_QUEUE  = 'gdt-raw-cache-scheduler';
const TICK_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const MAX_MSTS_PER_TICK = 10;              // stagger load across ticks
const MAX_JOBS_PER_MST  = 3;              // max concurrent jobs per MST

// Refresh intervals in milliseconds
const REFRESH_CURRENT_MONTH_MS = 4  * 60 * 60 * 1000;  // 4 hours
const REFRESH_PREV_MONTHS_MS   = 24 * 60 * 60 * 1000;  // 24 hours
const REFRESH_HISTORICAL_MS    = 72 * 60 * 60 * 1000;  // 72 hours

// ─── Scheduler queue ──────────────────────────────────────────────────────────

const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: { removeOnComplete: 5, removeOnFail: 5 },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRefreshIntervalMs(periodYear: number, periodMonth: number | null): number {
  const now   = new Date();
  const nowYear  = now.getFullYear();
  const nowMonth = now.getMonth() + 1;

  if (periodYear === nowYear && (periodMonth === null || periodMonth === nowMonth)) {
    return REFRESH_CURRENT_MONTH_MS;
  }

  const monthsAgo =
    (nowYear - periodYear) * 12 +
    (nowMonth - (periodMonth ?? nowMonth));

  if (monthsAgo > 3) return REFRESH_HISTORICAL_MS;
  return REFRESH_PREV_MONTHS_MS;
}

interface ActiveCompany {
  company_id: string;
  tax_code:   string;
}

async function getActiveCompanies(): Promise<ActiveCompany[]> {
  const res = await pool.query<ActiveCompany>(
    `SELECT DISTINCT gbc.company_id, c.tax_code
     FROM gdt_bot_configs gbc
     JOIN companies c ON c.id = gbc.company_id
     WHERE gbc.is_active = true
       AND c.tax_code IS NOT NULL
       AND c.deleted_at IS NULL
     LIMIT $1`,
    [MAX_MSTS_PER_TICK],
  );
  return res.rows;
}

// ─── Core scheduler tick ──────────────────────────────────────────────────────

async function runSchedulerTick(_job: Job): Promise<void> {
  const companies = await getActiveCompanies();

  if (companies.length === 0) return;

  const now       = new Date();
  const nowYear   = now.getFullYear();
  const nowMonth  = now.getMonth() + 1;

  // Determine periods to check: current month + last 3 months
  const periods: Array<{ year: number; month: number | null }> = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(nowYear, nowMonth - 1 - i, 1);
    periods.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  for (const company of companies) {
    const mst = company.tax_code;

    // Count active jobs — skip company if already at max
    const activeJobsRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM gdt_sync_queue_log
       WHERE mst = $1 AND status IN ('pending', 'running')`,
      [mst],
    );
    const activeJobs = parseInt(activeJobsRes.rows[0]?.cnt ?? '0', 10);
    if (activeJobs >= MAX_JOBS_PER_MST) continue;

    for (const { year, month } of periods) {
      for (const invoiceType of ['purchase', 'sale'] as const) {
        // Check cache freshness
        const meta = await getCacheMeta(mst, invoiceType, year, month ?? undefined);
        const refreshInterval = getRefreshIntervalMs(year, month);

        const ageMs = meta.lastFetchedAt
          ? Date.now() - meta.lastFetchedAt.getTime()
          : Infinity;

        if (ageMs < refreshInterval) continue; // Not due yet

        // Try to acquire lock
        const lockResult = await tryAcquireSyncLock(
          mst, invoiceType, year, month, 'scheduler',
        );
        if (!lockResult.acquired || !lockResult.logId) continue;

        // Enqueue with random jitter 0–5 min to spread load
        const jitterMs = Math.floor(Math.random() * 5 * 60 * 1000);

        const job = await gdtRawCacheSyncQueue.add(
          'sync',
          {
            mst,
            companyId:   company.company_id,
            invoiceType,
            periodYear:  year,
            periodMonth: month,
            triggeredBy: 'scheduler',
            logId:       lockResult.logId,
            priority:    'normal',
          } satisfies GdtRawCacheSyncJobPayload,
          {
            delay:       jitterMs,
            priority:    5,   // normal priority
            jobId:       `raw-cache-sched-${mst}-${invoiceType}-${year}-${month ?? 'all'}-${Date.now()}`,
          },
        );

        // Store BullMQ job ID in lock record
        await setJobId(
          lockResult.logId, mst, invoiceType, year, month,
          job.id ?? uuidv4(),
        );
      }
    }
  }
}

// ─── Scheduler worker ────────────────────────────────────────────────────────

export const gdtRawCacheSchedulerWorker = new Worker(
  SCHEDULER_QUEUE,
  runSchedulerTick,
  {
    connection:  { url: env.REDIS_URL },
    concurrency: 1,  // Scheduler ticks are serial
  },
);

gdtRawCacheSchedulerWorker.on('failed', (_job, err) => {
  console.error('[GdtRawCacheScheduler] Tick failed:', err.message);
});

// ─── Registration (call on startup) ──────────────────────────────────────────

/**
 * Register the repeatable scheduler job in BullMQ (idempotent, call on startup).
 * Fires every 15 minutes to check which companies need cache refresh.
 */
export async function scheduleGdtRawCacheSync(): Promise<void> {
  // Remove any stale repeatable jobs
  const existing = await schedulerQueue.getRepeatableJobs();
  for (const j of existing) {
    await schedulerQueue.removeRepeatableByKey(j.key);
  }

  await schedulerQueue.add(
    'tick',
    {},
    {
      repeat:           { every: TICK_INTERVAL_MS },
      jobId:            'gdt-raw-cache-scheduler-tick',
      attempts:         1,
      removeOnComplete: 5,
      removeOnFail:     5,
    },
  );

  // Run once immediately at startup so the first sync doesn't wait 15 min
  await schedulerQueue.add('tick', {}, {
    jobId:            `gdt-raw-cache-scheduler-startup-${Date.now()}`,
    attempts:         1,
    removeOnComplete: 3,
    removeOnFail:     3,
  });

  console.info('[GdtRawCacheScheduler] Registered — tick every 15 minutes');
}

// ─── Immediate sync trigger (for user-triggered "refresh now") ───────────────

/**
 * Enqueue a high-priority immediate sync job.
 * Called by the API when user clicks "Làm mới ngay".
 * Returns jobId for SSE tracking.
 */
export async function scheduleImmediateSync(
  mst: string,
  companyId: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null,
  triggeredBy: SyncTriggeredBy = 'user',
): Promise<{ jobId: string; alreadyRunning: boolean; logId?: number }> {
  const lockResult = await tryAcquireSyncLock(
    mst, invoiceType, periodYear, periodMonth, triggeredBy,
  );

  if (!lockResult.acquired) {
    return {
      jobId:         lockResult.existingJobId ?? '',
      alreadyRunning: true,
    };
  }

  const job = await gdtRawCacheSyncQueue.add(
    'sync',
    {
      mst,
      companyId,
      invoiceType,
      periodYear,
      periodMonth,
      triggeredBy,
      logId:    lockResult.logId!,
      priority: 'high',
    } satisfies GdtRawCacheSyncJobPayload,
    {
      priority: 1,    // Highest priority
      jobId:    `raw-cache-immediate-${mst}-${invoiceType}-${periodYear}-${periodMonth ?? 'all'}-${Date.now()}`,
    },
  );

  const finalJobId = job.id ?? uuidv4();

  await setJobId(
    lockResult.logId!, mst, invoiceType, periodYear, periodMonth, finalJobId,
  );

  return { jobId: finalJobId, alreadyRunning: false, logId: lockResult.logId };
}
