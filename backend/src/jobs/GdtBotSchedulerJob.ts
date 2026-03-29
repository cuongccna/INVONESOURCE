/**
 * GdtBotSchedulerJob
 *
 * Runs every 30 minutes on the backend. For each active gdt_bot_configs row,
 * checks whether the company is due for a sync based on sync_frequency_hours
 * and last_run_at. If due, enqueues a job to the 'gdt-bot-sync' queue.
 *
 * Human-like scheduling: each enqueued job gets a random delay of 0–10 minutes
 * so that companies never all hit GDT at the exact same second, mimicking
 * organic human behavior.
 */
import { Queue, Worker, Job } from 'bullmq';
import { pool } from '../db/pool';
import { env } from '../config/env';

const SCHEDULER_QUEUE   = 'gdt-bot-scheduler';
const BOT_SYNC_QUEUE    = 'gdt-bot-sync';
const POLL_EVERY_MS     = 30 * 60 * 1000;   // 30 minutes
const MAX_JITTER_MS     = 10 * 60 * 1000;   // up to 10-min random delay per company

// The queue this scheduler will enqueue work into
const botSyncQueue = new Queue<{ companyId: string }>(BOT_SYNC_QUEUE, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 1,          // No retries: scheduler re-evaluates every 30 min
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

// The scheduler itself (internal repeatable job)
const schedulerQueue = new Queue(SCHEDULER_QUEUE, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: { removeOnComplete: 5, removeOnFail: 5 },
});

async function runScheduler(_job: Job): Promise<void> {
  // Load every active bot config that has automatic syncing enabled
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

  const now = Date.now();
  let enqueued = 0;

  for (const row of res.rows) {
    // Skip if still blocked
    if (row.blocked_until && new Date(row.blocked_until).getTime() > now) continue;

    // Calculate next due time
    const lastRun = row.last_run_at ? new Date(row.last_run_at).getTime() : 0;
    const intervalMs = row.sync_frequency_hours * 60 * 60 * 1000;
    const dueAt      = lastRun + intervalMs;

    if (now < dueAt) continue;  // Not due yet

    // Random jitter 0–10 min so companies don't storm GDT simultaneously
    const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);

    const jobId = `gdt-bot-sched-${row.company_id}`;   // deduplicate: one pending job per company

    // Avoid double-enqueueing: if a job with same ID is already waiting, skip
    const existing = await botSyncQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'waiting' || state === 'active' || state === 'delayed') continue;
    }

    await botSyncQueue.add(
      'sync',
      { companyId: row.company_id },
      {
        jobId,
        delay:    jitterMs,
        attempts: 1,      // No retries: UnrecoverableError on concurrent/cooldown/no-proxy;
                          // scheduler re-enqueues on next 30-min tick if a transient error occurs.
      },
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

  console.info('[GdtBotScheduler] Registered — polling every 30 min');
}
