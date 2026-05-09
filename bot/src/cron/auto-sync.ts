/**
 * Auto-Sync Cron — BOT-ENT-01+02
 *
 * Called every 5 minutes from bot/src/index.ts via setInterval.
 * Pushes eligible companies into the slow-path 'gdt-sync-auto' queue.
 *
 * NOTE: This is the ONLY auto-sync scheduler. The backend GdtBotSchedulerJob.ts
 * has been disabled to avoid double-enqueue conflicts.
 *
 * Hot-reload: subscribes to Redis channel 'bot:schedule:reset' published by backend
 * when user changes sync_frequency_hours — no bot restart required.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { pool } from '../db';
import { logger } from '../logger';
import { cfg } from '../config/ConfigStore';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const autoSyncQueue = new Queue('gdt-sync-auto', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

/** Enqueue a single company immediately (bypasses the 5-min cycle). */
async function enqueueCompanyNow(companyId: string): Promise<void> {
  try {
    const res = await pool.query<{
      company_id: string;
      sync_frequency_hours: number;
      next_auto_sync_at: Date | null;
      consecutive_failures: number;
    }>(
      `SELECT b.company_id, b.sync_frequency_hours,
              b.next_auto_sync_at, b.consecutive_failures
       FROM gdt_bot_configs b
       WHERE b.company_id = $1
         AND b.is_active = true
         AND (b.blocked_until IS NULL OR b.blocked_until < NOW())
         AND b.consecutive_failures < $2`,
      [companyId, cfg.number('bot.auto_sync_skip_failures_threshold', 3)],
    );
    if (res.rows.length === 0) return;
    const row = res.rows[0]!;

    // Check for active/waiting jobs in BullMQ before enqueuing
    const activeJobs = await autoSyncQueue.getJobs(['active', 'waiting', 'delayed']);
    if (activeJobs.some(j => j.data.companyId === companyId)) {
      logger.info(`[AutoSync] Schedule-reset skipped — company already has active job`, { companyId });
      return;
    }

    const scheduleTime = row.next_auto_sync_at
      ? new Date(row.next_auto_sync_at).getTime()
      : 'reset';
    const failCount = row.consecutive_failures || 0;
    const jobId = `auto-sync-${companyId}-sched_${scheduleTime}-fail_${failCount}`;

    await autoSyncQueue.add(
      'sync',
      { companyId, triggeredBy: 'schedule_reset' },
      {
        jobId,
        delay: 0,
        priority: 5,
        attempts: 3,
        backoff: { type: 'exponential', delay: 120_000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );
    logger.info(`[AutoSync] Schedule-reset enqueued`, { companyId });
  } catch (err) {
    logger.error('[AutoSync] enqueueCompanyNow failed', { companyId, error: (err as Error).message });
  }
}

/** Subscribe to schedule-reset events published by backend when user changes sync interval. */
export function startScheduleResetListener(): void {
  const sub = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  sub.connect().then(() => {
    sub.subscribe('bot:schedule:reset', (err) => {
      if (err) logger.error('[AutoSync] Redis subscribe error', { error: (err as Error).message });
      else logger.info('[AutoSync] Subscribed to bot:schedule:reset');
    });
    sub.on('message', (_channel: string, msg: string) => {
      try {
        const { companyId } = JSON.parse(msg) as { companyId: string };
        if (companyId) void enqueueCompanyNow(companyId);
      } catch {
        // ignore malformed messages
      }
    });
    sub.on('error', (err: Error) => {
      logger.warn('[AutoSync] Redis subscriber error', { error: err.message });
    });
  }).catch((err: Error) => {
    logger.error('[AutoSync] Redis subscriber connect failed', { error: err.message });
  });
}

export async function runAutoSyncCycle(): Promise<void> {
  try {
    const due = await pool.query<{
      company_id: string;
      sync_frequency_hours: number;
      next_auto_sync_at: Date | null;
      consecutive_failures: number;
    }>(
      `SELECT b.company_id, b.sync_frequency_hours,
              b.next_auto_sync_at, b.consecutive_failures
       FROM gdt_bot_configs b
       WHERE b.is_active = true
         AND (b.next_auto_sync_at IS NULL OR b.next_auto_sync_at <= NOW())
         AND (b.blocked_until IS NULL OR b.blocked_until < NOW())
         AND b.consecutive_failures < $2
       ORDER BY b.next_auto_sync_at ASC NULLS FIRST
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [
        cfg.number('bot.auto_sync_companies_per_cycle', 15),
        cfg.number('bot.auto_sync_skip_failures_threshold', 3),
      ],
    );

    if (due.rows.length === 0) return;

    // Fetch active/waiting/delayed job companyIds to skip duplicates.
    // Prevents LOCK_CONFLICT storm when a company is already running (e.g. zombie lock).
    const activeJobs = await autoSyncQueue.getJobs(['active', 'waiting', 'delayed']);
    const activeCompanyIds = new Set(activeJobs.map(j => j.data.companyId as string));

    let queued = 0;
    for (const row of due.rows) {
      if (activeCompanyIds.has(row.company_id)) {
        logger.debug(`[AutoSync] Skipping company — already has active/waiting job`, { companyId: row.company_id });
        continue;
      }

      // State-Derived ID: thay đổi khi DB state thay đổi, tự dedup khi state giữ nguyên.
      // BullMQ idempotent trên jobId → cùng state = cùng ID = không tạo job trùng.
      const scheduleTime = row.next_auto_sync_at
        ? new Date(row.next_auto_sync_at).getTime()
        : 'init';
      const failCount = row.consecutive_failures || 0;
      const jobId = `auto-sync-${row.company_id}-sched_${scheduleTime}-fail_${failCount}`;

      const dispatchDelayMs = Math.floor(
        Math.random() * cfg.number('bot.dispatch_jitter_max_ms', 480_000),
      );

      await autoSyncQueue.add(
        'sync',
        { companyId: row.company_id, triggeredBy: 'scheduled_auto' },
        {
          jobId,
          delay: dispatchDelayMs,
          priority: 5,
          attempts: 3,
          backoff: { type: 'exponential', delay: 120_000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
      queued++;
    }

    if (queued > 0) {
      logger.info(
        `[AutoSync] Queued ${queued} companies (limit=${cfg.number('bot.auto_sync_companies_per_cycle', 15)})`,
      );
    }
  } catch (err) {
    logger.error('[AutoSync] Cycle failed', { error: (err as Error).message });
  }
}
