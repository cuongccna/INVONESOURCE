/**
 * Auto-Sync Cron — BOT-ENT-01+02
 *
 * Runs every 5 minutes and pushes eligible companies into the slow-path
 * 'gdt-sync-auto' queue.  Implements:
 *   - Night sleep (23:00–06:00 VN time)
 *   - Time-of-day slowdown (evening/morning ramp)
 *   - Reads next_auto_sync_at from gdt_bot_configs (set with jitter by sync.worker.ts)
 *   - Tenant preferred hours filter
 *   - Limits batch size based on current VN hour
 */
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { logger } from '../logger';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export const autoQueue = new Queue('gdt-sync-auto', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

/** Vietnam is UTC+7. Returns current hour in VN local time (0–23). */
function vnHour(): number {
  return new Date(Date.now() + 7 * 3_600_000).getUTCHours();
}

/** True if we are in VN night-time (23:00–06:00). */
function isNightTime(): boolean {
  const h = vnHour();
  return h >= 23 || h < 6;
}

/**
 * Fraction of LIMIT_BASE to use based on time of day.
 * Full speed during business hours; slowed at morning/evening.
 */
function slowdownFactor(): number {
  const h = vnHour();
  if (h >= 9  && h < 17) return 1.0;   // business hours
  if (h >= 6  && h < 9)  return 0.6;   // morning ramp
  if (h >= 17 && h < 22) return 0.4;   // evening wind-down
  return 0.1;                           // 22:xx — almost night
}

const LIMIT_BASE = 15;

export async function runAutoSyncCycle(): Promise<void> {
  if (isNightTime()) {
    logger.debug('[AutoSync] Night mode — skipping (23:00–06:00 VN time)');
    return;
  }

  const limit = Math.max(1, Math.floor(LIMIT_BASE * slowdownFactor()));
  const currentHour = vnHour();

  const due = await pool.query<{ company_id: string; encrypted_creds: string }>(
    `SELECT c.id AS company_id, b.encrypted_creds
     FROM gdt_bot_configs b
     JOIN companies c ON b.company_id = c.id
     WHERE b.is_active = true
       AND (b.next_auto_sync_at IS NULL OR b.next_auto_sync_at <= NOW())
       AND (b.blocked_until IS NULL OR b.blocked_until < NOW())
       AND b.consecutive_failures < 3
       AND (
         b.preferred_sync_hour_start IS NULL
         OR ($1::int BETWEEN b.preferred_sync_hour_start AND b.preferred_sync_hour_end)
       )
     ORDER BY b.next_auto_sync_at ASC NULLS FIRST
     LIMIT $2`,
    [currentHour, limit],
  );

  if (due.rows.length === 0) return;

  let queued = 0;
  for (const row of due.rows) {
    await autoQueue.add(
      'auto-sync',
      {
        jobId:                uuidv4(),
        encryptedCredentials: row.encrypted_creds,
        direction:            'both',
        fromDate:             null,
        toDate:               null,
        tenantId:             row.company_id,
        triggeredBy:          'auto_cron',
      },
      { priority: 5 },
    );
    queued++;
  }

  logger.info(`[AutoSync] Queued ${queued} companies (limit=${limit}, vnHour=${currentHour})`);
}
