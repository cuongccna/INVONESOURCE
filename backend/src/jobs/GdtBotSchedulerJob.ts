/**
 * GdtBotSchedulerJob
 *
 * Runs every 15 minutes on the backend as a lightweight polling tick.
 * For each active gdt_bot_configs row, checks whether the company is due for
 * a sync based on sync_frequency_hours (configured by user: 6h / 12h / 24h)
 * and last_run_at. If due, enqueues a job to the 'gdt-sync-auto' queue.
 *
 * Anti-bot jitter design:
 *   - Each company's "next due" time is computed with a per-company seeded
 *     random offset of ±(interval × JITTER_FRACTION).
 *     e.g. user selects 6h → actual run window is 5h 30m to 6h 30m (±30min)
 *          user selects 12h → window is 11h to 13h (±1h)
 *          user selects 24h → window is 22h to 26h (±2h)
 *   - Jitter is seeded by (company_id + lastRun epoch) so it stays consistent
 *     across multiple 15-min ticks in the same interval — avoids flapping.
 *   - Additionally, each enqueued job gets an extra BullMQ execution delay of
 *     0–5 min so concurrent companies don't hit GDT at the exact same second.
 *
 * Human-like: a company running at 09:00 today will run at ~09:23 tomorrow
 * (with random offset each cycle), never at a predictable fixed clock time.
 */
import { createHash } from 'crypto';
import { Queue, Worker, Job } from 'bullmq';
import { pool } from '../db/pool';
import { env } from '../config/env';

const SCHEDULER_QUEUE  = 'gdt-bot-scheduler';
const BOT_SYNC_QUEUE   = 'gdt-sync-auto';
const POLL_EVERY_MS    = 15 * 60 * 1000;    // check every 15 minutes

/**
 * Jitter fraction: ±8.33% of the sync interval.
 * 6h  → ±30min window  |  12h → ±60min window  |  24h → ±2h window
 */
const JITTER_FRACTION  = 1 / 12;

/**
 * Extra execution delay added to BullMQ job so companies that become due at the
 * same tick don't all hit GDT within the same second.
 */
const MAX_DISPATCH_JITTER_MS = 5 * 60 * 1000;  // 0–5 min random dispatch spread

const botSyncQueue = new Queue<{ companyId: string }>(BOT_SYNC_QUEUE, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 120_000 },
    removeOnComplete: 100,
    removeOnFail:     50,
  },
});

const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: { removeOnComplete: 5, removeOnFail: 5 },
});

/**
 * Deterministic pseudo-random float in [0, 1) seeded by an arbitrary string.
 * Uses first 8 hex chars of SHA-256(seed) → 32-bit unsigned integer → divide by 2^32.
 * Consistent for the same seed across multiple calls — no flapping on re-check.
 */
function seededRandom(seed: string): number {
  const hash = createHash('sha256').update(seed).digest('hex');
  const int32 = parseInt(hash.slice(0, 8), 16);   // 0 … 4 294 967 295
  return int32 / 0x1_0000_0000;                    // 0.0 … 0.999…
}

async function runScheduler(_job: Job): Promise<void> {
  const res = await pool.query<{
    company_id:           string;
    sync_frequency_hours: number;
    last_run_at:          string | null;
    blocked_until:        string | null;
  }>(
    `SELECT company_id, sync_frequency_hours, last_run_at, blocked_until
     FROM gdt_bot_configs
     WHERE is_active = true AND sync_frequency_hours > 0`,
  );

  const now      = Date.now();
  let   enqueued = 0;

  for (const row of res.rows) {
    // Skip if still blocked (e.g. wrong credentials, quota exhausted)
    if (row.blocked_until && new Date(row.blocked_until).getTime() > now) continue;

    const lastRun    = row.last_run_at ? new Date(row.last_run_at).getTime() : 0;
    const intervalMs = row.sync_frequency_hours * 60 * 60 * 1000;

    // Seeded jitter: consistent within the same (company × interval cycle).
    // Offset is ±(interval × JITTER_FRACTION), seeded so it's stable across polls.
    const jitterSeed   = `${row.company_id}:${lastRun}`;
    const jitterOffsetMs = Math.floor(
      (seededRandom(jitterSeed) * 2 - 1)  // [-1, +1)
      * JITTER_FRACTION
      * intervalMs,
    );
    // e.g. 6h + jitter ∈ [5h 30m, 6h 30m]
    const dueAt = lastRun + intervalMs + jitterOffsetMs;

    if (now < dueAt) continue;  // Not yet due for this company

    // Avoid double-enqueueing
    const jobId   = `gdt-bot-sched-${row.company_id}`;
    const existing = await botSyncQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') continue;
    }

    // Random dispatch spread so companies that become due simultaneously
    // don't all start at the exact same second.
    const dispatchDelayMs = Math.floor(Math.random() * MAX_DISPATCH_JITTER_MS);

    await botSyncQueue.add(
      'sync',
      { companyId: row.company_id },
      { jobId, delay: dispatchDelayMs },
    );
    enqueued++;
  }

  if (enqueued > 0) {
    console.info(`[GdtBotScheduler] Enqueued ${enqueued} sync jobs`);
  }
}

// Worker that processes scheduler ticks
export const gdtBotSchedulerWorker = new Worker(SCHEDULER_QUEUE, runScheduler, {
  connection: { url: env.REDIS_URL },
  concurrency: 1,
});

/**
 * Register the repeatable scheduler job in BullMQ (idempotent, call on startup).
 * Fires every 30 minutes to check which companies need syncing.
 */
export async function scheduleGdtBotSync(): Promise<void> {
  // Remove stale repeatable jobs
  const existing = await schedulerQueue.getRepeatableJobs();
  for (const job of existing) {
    await schedulerQueue.removeRepeatableByKey(job.key);
  }

  await schedulerQueue.add(
    'tick',
    {},
    {
      repeat:   { every: POLL_EVERY_MS },
      jobId:    'gdt-bot-scheduler-tick',
      attempts: 1,
      removeOnComplete: 5,
      removeOnFail:     5,
    },
  );

  // Run immediately once at startup so the first sync doesn't wait 30 min
  await schedulerQueue.add('tick', {}, {
    jobId:            `gdt-bot-scheduler-startup-${Date.now()}`,
    delay:            5_000,   // 5s after startup
    removeOnComplete: true,
  });

  console.info('[GdtBotScheduler] Registered — polling every 15 min');
}
