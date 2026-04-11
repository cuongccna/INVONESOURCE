/**
 * syncQueueGuard.ts
 *
 * Prevents duplicate sync jobs from being enqueued for the same MST + period.
 *
 * Two-layer dedup:
 *   1. Redis (fast-path, in-memory)  → key: sync_lock:{mst}:{type}:{year}:{month}
 *   2. DB (authoritative)            → gdt_sync_queue_log WHERE status IN ('pending','running')
 *
 * Redis TTL = 30 min (matches the maximum expected sync duration).
 * On job completion/failure → releaseSyncLock() clears both layers.
 */

import Redis from 'ioredis';
import { pool } from '../db/pool';
import { env } from '../config/env';

// ─── Redis client (lazy singleton) ───────────────────────────────────────────

let _redis: Redis | null = null;

function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
    _redis.on('error', (err: Error) => {
      console.error('[SyncQueueGuard] Redis error:', err.message);
    });
  }
  return _redis;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

const LOCK_TTL_SECONDS = 30 * 60; // 30 minutes

function redisLockKey(
  mst: string,
  invoiceType: string,
  periodYear: number,
  periodMonth: number | null,
): string {
  return `sync_lock:${mst}:${invoiceType}:${periodYear}:${periodMonth ?? 'all'}`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncTriggeredBy = 'scheduler' | 'user' | 'retry';
export type SyncStatus      = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface AcquireResult {
  acquired: boolean;
  logId?: number;
  existingJobId?: string;
}

export interface SyncStats {
  found?:   number;
  updated?: number;
  skipped?: number;
  error?:   string;
}

// ─── 1. Try to acquire lock ───────────────────────────────────────────────────

/**
 * Acquire a sync lock for the given MST + period combination.
 *
 * Fast-path: check Redis key first (in-memory, ~1ms).
 * Slow-path: check DB for status IN ('pending','running').
 * If free: INSERT log row + SET Redis key with TTL.
 *
 * Returns { acquired: true, logId } on success.
 * Returns { acquired: false, existingJobId } when already locked.
 */
export async function tryAcquireSyncLock(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null,
  triggeredBy: SyncTriggeredBy,
): Promise<AcquireResult> {
  const lockKey = redisLockKey(mst, invoiceType, periodYear, periodMonth);
  const redis   = getRedis();

  // ── Fast-path: Redis ──
  const existing = await redis.get(lockKey);
  if (existing) {
    return { acquired: false, existingJobId: existing };
  }

  // ── Slow-path: DB check ──
  const dbCheck = await pool.query<{ id: number; job_id: string | null; status: string }>(
    `SELECT id, job_id, status
     FROM gdt_sync_queue_log
     WHERE mst          = $1
       AND invoice_type = $2
       AND period_year  = $3
       AND (period_month = $4 OR ($4 IS NULL AND period_month IS NULL))
       AND status IN ('pending', 'running')
     ORDER BY enqueued_at DESC
     LIMIT 1`,
    [mst, invoiceType, periodYear, periodMonth],
  );

  if (dbCheck.rowCount && dbCheck.rowCount > 0) {
    const row = dbCheck.rows[0];
    // Refresh Redis TTL from DB (in case Redis was flushed)
    const existingJobId = row.job_id ?? `log-${row.id}`;
    await redis.set(lockKey, existingJobId, 'EX', LOCK_TTL_SECONDS);
    return { acquired: false, existingJobId };
  }

  // ── Insert log row ──
  const insertRes = await pool.query<{ id: number }>(
    `INSERT INTO gdt_sync_queue_log
       (mst, invoice_type, period_year, period_month, status, triggered_by, enqueued_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
     RETURNING id`,
    [mst, invoiceType, periodYear, periodMonth, triggeredBy],
  );

  const logId = insertRes.rows[0].id;

  // Set Redis placeholder; will be updated to real jobId once BullMQ assigns it
  await redis.set(lockKey, `log-${logId}`, 'EX', LOCK_TTL_SECONDS);

  return { acquired: true, logId };
}

// ─── 2. Update job ID after BullMQ enqueue ───────────────────────────────────

/**
 * Store the BullMQ job ID into the log row so the Redis key + DB stay in sync.
 * Call this immediately after BullMQ returns a job ID.
 */
export async function setJobId(
  logId: number,
  mst: string,
  invoiceType: string,
  periodYear: number,
  periodMonth: number | null,
  jobId: string,
): Promise<void> {
  await pool.query(
    `UPDATE gdt_sync_queue_log SET job_id = $2 WHERE id = $1`,
    [logId, jobId],
  );
  const lock = getRedis();
  const lockKey = redisLockKey(mst, invoiceType, periodYear, periodMonth);
  await lock.set(lockKey, jobId, 'EX', LOCK_TTL_SECONDS);
}

// ─── 3. Update sync status ────────────────────────────────────────────────────

/**
 * Update the log row status at each pipeline stage.
 * Called by the BullMQ worker as it progresses through steps.
 */
export async function updateSyncStatus(
  logId: number,
  status: SyncStatus,
  stats?: SyncStats,
): Promise<void> {
  const setStarted   = status === 'running'  ? ', started_at = NOW()' : '';
  const setCompleted = ['done', 'failed', 'skipped'].includes(status) ? ', completed_at = NOW()' : '';

  await pool.query(
    `UPDATE gdt_sync_queue_log
     SET status           = $2
       , invoices_found   = COALESCE($3, invoices_found)
       , invoices_updated = COALESCE($4, invoices_updated)
       , invoices_skipped = COALESCE($5, invoices_skipped)
       , error_message    = COALESCE($6, error_message)
       ${setStarted}
       ${setCompleted}
     WHERE id = $1`,
    [
      logId,
      status,
      stats?.found   ?? null,
      stats?.updated ?? null,
      stats?.skipped ?? null,
      stats?.error   ?? null,
    ],
  );
}

// ─── 4. Release lock ─────────────────────────────────────────────────────────

/**
 * Release the sync lock on job completion or failure.
 * Deletes the Redis key and marks the DB log row with final status.
 */
export async function releaseSyncLock(
  logId: number,
  mst: string,
  invoiceType: string,
  periodYear: number,
  periodMonth: number | null,
  finalStatus: 'done' | 'failed' | 'skipped',
  stats?: SyncStats,
): Promise<void> {
  // Update DB
  await updateSyncStatus(logId, finalStatus, stats);

  // Delete Redis key
  const lockKey = redisLockKey(mst, invoiceType, periodYear, periodMonth);
  await getRedis().del(lockKey);
}

// ─── 5. Get active sync status for UI ────────────────────────────────────────

export interface ActiveSyncStatus {
  invoiceType: string;
  periodYear:  number;
  periodMonth: number | null;
  status:      string;
  enqueuedAt:  Date;
  triggeredBy: string;
  jobId:       string | null;
}

/**
 * Get all active (pending or running) sync jobs for a given MST.
 * Used by the UI to display "đang đồng bộ..." indicators.
 */
export async function getActiveSyncStatus(mst: string): Promise<ActiveSyncStatus[]> {
  const res = await pool.query<{
    invoice_type: string;
    period_year:  number;
    period_month: number | null;
    status:       string;
    enqueued_at:  Date;
    triggered_by: string;
    job_id:       string | null;
  }>(
    `SELECT invoice_type, period_year, period_month, status,
            enqueued_at, triggered_by, job_id
     FROM gdt_sync_queue_log
     WHERE mst = $1 AND status IN ('pending', 'running')
     ORDER BY enqueued_at DESC`,
    [mst],
  );

  return res.rows.map((r) => ({
    invoiceType: r.invoice_type,
    periodYear:  r.period_year,
    periodMonth: r.period_month,
    status:      r.status,
    enqueuedAt:  r.enqueued_at,
    triggeredBy: r.triggered_by,
    jobId:       r.job_id,
  }));
}

/**
 * Get all sync log entries (for monitoring / admin UI).
 */
export async function getSyncHistory(
  mst: string,
  limit = 50,
): Promise<Array<{
  id:              number;
  invoiceType:     string;
  periodYear:      number;
  periodMonth:     number | null;
  status:          string;
  triggeredBy:     string;
  enqueuedAt:      Date;
  startedAt:       Date | null;
  completedAt:     Date | null;
  invoicesFound:   number | null;
  invoicesUpdated: number | null;
  invoicesSkipped: number | null;
  errorMessage:    string | null;
  jobId:           string | null;
}>> {
  const res = await pool.query(
    `SELECT id, invoice_type, period_year, period_month, status, triggered_by,
            enqueued_at, started_at, completed_at,
            invoices_found, invoices_updated, invoices_skipped,
            error_message, job_id
     FROM gdt_sync_queue_log
     WHERE mst = $1
     ORDER BY enqueued_at DESC
     LIMIT $2`,
    [mst, limit],
  );

  return res.rows.map((r) => ({
    id:              r.id,
    invoiceType:     r.invoice_type,
    periodYear:      r.period_year,
    periodMonth:     r.period_month,
    status:          r.status,
    triggeredBy:     r.triggered_by,
    enqueuedAt:      r.enqueued_at,
    startedAt:       r.started_at,
    completedAt:     r.completed_at,
    invoicesFound:   r.invoices_found,
    invoicesUpdated: r.invoices_updated,
    invoicesSkipped: r.invoices_skipped,
    errorMessage:    r.error_message,
    jobId:           r.job_id,
  }));
}
