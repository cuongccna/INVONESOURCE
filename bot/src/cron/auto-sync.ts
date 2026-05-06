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
    const due = await pool.query<{ company_id: string }>(
      `SELECT b.company_id
       FROM gdt_bot_configs b
       WHERE b.is_active = true
         AND (b.next_auto_sync_at IS NULL OR b.next_auto_sync_at <= NOW())
         AND (b.blocked_until IS NULL OR b.blocked_until < NOW())
         AND b.consecutive_failures < $2
       ORDER BY b.next_auto_sync_at ASC NULLS FIRST
       LIMIT $1`,
      [
        cfg.number('bot.auto_sync_companies_per_cycle', 15),
        cfg.number('bot.auto_sync_skip_failures_threshold', 3),
      ],
    );

    if (due.rows.length === 0) return;

    let queued = 0;
    for (const row of due.rows) {
      // Dedup: skip if a job is already waiting/active for this company
      const jobId = `auto-sync-${row.company_id}`;
      const existing = await autoSyncQueue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'waiting' || state === 'active' || state === 'delayed') continue;
      }

      // Spread dispatch using configurable jitter window (default 0–8 min).
      // Admin can tune this in /admin/system-settings under the 'queue' group.
      const dispatchDelayMs = Math.floor(Math.random() * cfg.number('bot.dispatch_jitter_max_ms', 480_000));


      // ── FIX: Bump next_auto_sync_at TRƯỚC KHI add vào queue ──────────────────
      // Nếu không làm điều này, polling loop 5 phút tiếp theo sẽ thấy
      // next_auto_sync_at vẫn <= NOW() (chưa được cập nhật vì job chưa complete)
      // và queue lại công ty này liên tục, gây ra log "Queued N companies" mỗi 5p.
      //
      // sync_worker.ts sẽ ghi đè next_auto_sync_at một lần nữa sau khi complete
      // với giá trị chính xác hơn (dựa trên thời điểm sync thực tế kết thúc).
      // Đây là "optimistic lock" — tránh double-queue, chấp nhận drift nhỏ ~0–8 phút.
      const freqHours = row.sync_frequency_hours > 0 ? row.sync_frequency_hours : 6;
      await pool.query(
        `UPDATE gdt_bot_configs
         SET next_auto_sync_at = NOW()
           + ($1 || ' hours')::INTERVAL
           + (dispatchDelayMs/60000.0 || ' minutes')::INTERVAL
         WHERE company_id = $2
           AND (next_auto_sync_at IS NULL OR next_auto_sync_at <= NOW())`,
        [freqHours, row.company_id],
      );
      
      await autoSyncQueue.add(
        'sync',
        { companyId: row.company_id, triggeredBy: 'scheduled_auto' },
        { jobId, delay: dispatchDelayMs, priority: 5 },
      );
      queued++;
    }

    if (queued > 0) {
      logger.info(`[AutoSync] Queued ${queued} companies (limit=${cfg.number('bot.auto_sync_companies_per_cycle', 15)})`);
    }
  } catch (err) {
    logger.error('[AutoSync] Cycle failed', { error: (err as Error).message });
  }
}
