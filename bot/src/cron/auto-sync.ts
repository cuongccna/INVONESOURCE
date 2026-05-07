/**
 * Auto-Sync Cron — BOT-ENT-01+02
 *
 * Called every 5 minutes from bot/src/index.ts via setInterval.
 * Pushes eligible companies into the slow-path 'gdt-sync-auto' queue.
 *
 * NOTE: This is the ONLY auto-sync scheduler. The backend GdtBotSchedulerJob.ts
 * has been disabled to avoid double-enqueue conflicts.
 */
import { Queue } from 'bullmq';
import { pool } from '../db';
import { logger } from '../logger';
import { cfg } from '../config/ConfigStore';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const autoSyncQueue = new Queue('gdt-sync-auto', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

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

    let queued = 0;
    for (const row of due.rows) {
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
