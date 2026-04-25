/**
 * BOT-SEC-05 — BullMQ Sync Worker
 *
 * Processes 'sync' jobs from the 'gdt-bot-sync' queue.
 * Each job: decrypt creds → rotate proxy → login GDT → crawl invoices → upsert to DB.
 *
 * Anti-block: jitteredDelay every 10 invoices (3.5–6.5s).
 * UnrecoverableError on invalid credentials (deactivates bot).
 * Exponential backoff: 1min → 2min → 4min.
 */
import { Worker, Queue, Job, UnrecoverableError } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';
import { pool } from './db';
import { decryptCredentials } from './encryption.service';
import { proxyManager } from './proxy-manager';
import { GdtDirectApiService } from './gdt-direct-api.service';
import type { GdtFetchProgressSnapshot } from './gdt-direct-api.service';
import { GdtXmlParser } from './parsers/GdtXmlParser';
import { logger } from './logger';
import type { LineItem } from './parsers/GdtXmlParser';
import { InvoiceDeduplicator } from './crawl-cache/InvoiceDeduplicator';
import { GdtSessionCache }     from './crawl-cache/GdtSessionCache';
import { SyncCheckpoint }      from './crawl-cache/SyncCheckpoint';
import { GdtDetailCache }      from './crawl-cache/GdtDetailCache';
import { MstLookupCache }      from './crawl-cache/MstLookupCache';
import { gdtRawCacheService }  from './crawl-cache/GdtRawCacheService';

const REDIS_URL    = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CONCURRENCY  = parseInt(process.env['WORKER_CONCURRENCY'] ?? '2', 10);

// ── BOT-ENT-03: GdtStructuralError ────────────────────────────────────────────
/**
 * Thrown when GDT page structure changes (selector not found, unexpected HTML).
 * Distinct from credential/network errors — triggers Global Circuit Breaker.
 * Should NOT increment company consecutive_failures (not tenant's fault).
 */
export class GdtStructuralError extends Error {
  constructor(message: string, public readonly selector?: string) {
    super(message);
    this.name = 'GdtStructuralError';
  }
}

// ── BOT-ENT-03: Global Circuit Breaker constants ─────────────────────────────
const CIRCUIT_BREAKER_ERRORS_KEY  = 'gdt:circuit_breaker:errors';
const CIRCUIT_BREAKER_STATUS_KEY  = 'gdt:circuit_breaker:status';
const CIRCUIT_BREAKER_TRIP_COUNT  = 20;   // trip after 20 structural errors in 1 hour
const CIRCUIT_BREAKER_TTL_SEC     = 3600; // 1-hour window

// Queue for notifying backend to send push notifications after sync
const _notifQueue = new Queue('sync-notifications', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});
// Self-reference queue for sequential job chaining (quarter sync: job 0 → job 1 → job 2)
// Routes to gdt-sync-auto so chained jobs get autoWorker concurrency + backoff.
const _botSyncQueue = new Queue('gdt-sync-auto', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

// ── Manual/Auto split queues (BOT-ENT-01) ────────────────────────────────────
export const manualQueue = new Queue('gdt-sync-manual', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
  defaultJobOptions: {
    attempts:          5,
    // Exponential backoff: 5min→10min→20min between retries.
    backoff:           { type: 'exponential', delay: 300_000 },
    removeOnComplete:  200,
    removeOnFail:      100,
  },
});

async function promoteNextDelayedManualJobForUser(userId: string, finishedJobId?: string): Promise<void> {
  const delayedJobs = await manualQueue.getJobs(['delayed']);
  const nextJob = delayedJobs
    .filter((job) => {
      if (finishedJobId && String(job.id ?? '') === finishedJobId) return false;
      return job.data.triggeredByUserId === userId;
    })
    .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))[0];

  if (!nextJob) return;

  try {
    await nextJob.promote();

    const nextRunId = nextJob.data.runId ?? (typeof nextJob.id === 'string' ? nextJob.id : null);
    const nextCompanyId = nextJob.data.companyId;
    if (nextRunId && nextCompanyId) {
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

    logger.info('[SyncWorker] Promoted delayed manual job for same user', {
      finishedJobId,
      nextJobId: nextJob.id,
      nextCompanyId,
      userId: userId.slice(0, 8) + '…',
    });
  } catch (err) {
    logger.warn('[SyncWorker] Failed to promote delayed manual job (non-fatal)', {
      finishedJobId,
      userId: userId.slice(0, 8) + '…',
      error: (err as Error).message,
    });
  }
}

export const autoQueue = new Queue('gdt-sync-auto', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
  defaultJobOptions: {
    attempts:          3,
    backoff:           { type: 'exponential', delay: 120_000 },
    removeOnComplete:  100,
    removeOnFail:      50,
  },
});
// Dead-letter queue — unrecoverable jobs land here for manual triage
const _dlqQueue = new Queue('gdt-sync-dlq', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});
const JITTER_EVERY = 10;
const JITTER_MIN   = 1200;
const JITTER_MAX   = 2500;
// Longer "read pause" — simulates user stopping to examine an invoice
const READ_PAUSE_EVERY_MIN = 25;
const READ_PAUSE_EVERY_MAX = 40;
const READ_PAUSE_MIN = 3_000;
const READ_PAUSE_MAX = 10_000;

const FREE_TIER_MONTHLY_QUOTA = 100;

// ── VĐ4: Dynamic job timeout based on estimated invoice volume ────────────────
const VOLUME_ESTIMATE_KEY_PREFIX = 'gdt:volume:';
const VOLUME_ESTIMATE_TTL_SEC    = 7 * 24 * 3600; // 7 days

/**
 * Persist last-known invoice count after a successful sync.
 * Used by the next enqueueSync call to set an appropriate BullMQ job timeout.
 */
async function storeVolumeEstimate(
  redis: import('ioredis').default,
  companyId: string,
  outCount: number,
  inCount: number,
): Promise<void> {
  try {
    await redis.set(
      `${VOLUME_ESTIMATE_KEY_PREFIX}${companyId}`,
      JSON.stringify({ outCount, inCount, storedAt: Date.now() }),
      'EX', VOLUME_ESTIMATE_TTL_SEC,
    );
  } catch { /* non-fatal */ }
}

/**
 * VĐ4: Calculate BullMQ job timeout from estimated invoice volume.
 * Based on real-world benchmarks:
 *   - List fetch:   ~1s / page (50 invoices)
 *   - Detail /query/:     ~9s / invoice
 *   - Detail /sco-query/: ~12s / invoice (worst case — assume sco)
 *   - Login + captcha:    ~16s fixed
 * Returns between 3 minutes (minimum) and 30 minutes (cap).
 */
function calculateJobTimeout(estimate: { outCount: number; inCount: number }): number {
  const { getPeakTimeoutMultiplier } = require('./gdt-direct-api.service');
  const m: number = getPeakTimeoutMultiplier();
  const total      = Math.max(0, estimate.outCount) + Math.max(0, estimate.inCount);
  const LOGIN_TIME = 16_000;
  const LIST_TIME  = Math.ceil(total / 50) * 1_000;
  // Peak: detail time per invoice increases from 12s to 30s (GDT responses much slower)
  const detailPerInvoice = m > 1 ? 30_000 : 12_000;
  const DETAIL_TIME = total * detailPerInvoice;
  const BUFFER      = 60_000;
  const ms = LOGIN_TIME + LIST_TIME + DETAIL_TIME + BUFFER;
  // Peak: cap increases from 30min to 90min
  const maxCap = m > 1 ? 90 * 60_000 : 30 * 60_000;
  const result = Math.min(Math.max(ms, 3 * 60_000), maxCap);
  logger.info('[SyncWorker] Dynamic timeout calculated', {
    total,
    timeoutMin: Math.round(result / 60_000),
    peakMultiplier: m,
  });
  return result;
}

/** Returns the OWNER user_id for a company, or null if none found. */
async function _getCompanyOwner(companyId: string): Promise<string | null> {
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM user_companies WHERE company_id = $1 AND role = 'OWNER' LIMIT 1`,
    [companyId],
  );
  return res.rows[0]?.user_id ?? null;
}

/**
 * Check whether the company owner has remaining quota.
 * Throws UnrecoverableError if quota is exhausted — no point retrying.
 */
async function _checkQuota(companyId: string): Promise<void> {
  const userId = await _getCompanyOwner(companyId);
  if (!userId) return;  // No owner found — allow sync, don't block on config issue

  const subRes = await pool.query<{ status: string; quota_used: number; quota_total: number }>(
    `SELECT status, quota_used, quota_total FROM user_subscriptions WHERE user_id = $1`,
    [userId],
  );

  if (!subRes.rows.length) {
    // Free tier — check monthly aggregate
    const usedRes = await pool.query<{ used: string }>(
      `SELECT COALESCE(SUM(invoices_added), 0)::text AS used
       FROM quota_usage_log
       WHERE user_id = $1 AND DATE_TRUNC('month', logged_at) = DATE_TRUNC('month', NOW())`,
      [userId],
    );
    const used = parseInt(usedRes.rows[0]?.used ?? '0', 10);
    if (used >= FREE_TIER_MONTHLY_QUOTA) {
      throw new UnrecoverableError(
        `[SyncWorker] Free tier quota exhausted (${used}/${FREE_TIER_MONTHLY_QUOTA} this month) ` +
        `for company ${companyId}. Upgrade to a paid plan.`,
      );
    }
    return;
  }

  const sub = subRes.rows[0]!;
  if (sub.status === 'suspended' || sub.status === 'expired' || sub.status === 'cancelled') {
    throw new UnrecoverableError(
      `[SyncWorker] Subscription ${sub.status} for company ${companyId} — sync blocked. Contact admin.`,
    );
  }
  if (sub.quota_used >= sub.quota_total) {
    throw new UnrecoverableError(
      `[SyncWorker] Quota exhausted (${sub.quota_used}/${sub.quota_total}) for company ${companyId}.`,
    );
  }
}

/** Consume quota after a successful sync. Non-fatal — sync result is NOT rolled back on error here. */
async function _consumeQuota(companyId: string, invoiceCount: number): Promise<void> {
  if (invoiceCount <= 0) return;
  const userId = await _getCompanyOwner(companyId);
  if (!userId) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO quota_usage_log (id, user_id, company_id, invoices_added, source, logged_at)
       VALUES ($1, $2, $3, $4, 'gdt_bot', NOW())`,
      [uuidv4(), userId, companyId, invoiceCount],
    );
    // Only update if subscription exists (free tier users have no subscription row)
    await client.query(
      `UPDATE user_subscriptions SET quota_used = quota_used + $1, updated_at = NOW()
       WHERE user_id = $2`,
      [invoiceCount, userId],
    );
    await client.query('COMMIT');
    logger.info('[SyncWorker] Quota consumed', { companyId, userId, invoiceCount });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.warn('[SyncWorker] Quota consumption failed (non-fatal)', { companyId, err });
  } finally {
    client.release();
  }
}

// Per-company lock via Redis SET NX EX — atomic, survives process restarts.
// No TOCTOU race: if SET NX succeeds, we have exclusive access.
import Redis from 'ioredis';
const _lockRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
// FIX-PERF-01: Crawl-cache singletons (reuse _lockRedis connection)
const _dedup        = new InvoiceDeduplicator(_lockRedis);
const _sessionCache = new GdtSessionCache(_lockRedis);
// FIX-2: Pagination checkpoint singleton — resumes on crash, no restart from page 0
const _checkpoint   = new SyncCheckpoint(_lockRedis);
// BOT-CACHE-01: Detail API response cache — prevents redundant GDT calls on re-sync
const _detailCache  = new GdtDetailCache(_lockRedis);
// BOT-CACHE-03B: MST lookup cache — prevents N+1 GDT tax-code lookups
export const _mstCache = new MstLookupCache(_lockRedis);
const BOT_LOCK_PREFIX   = 'bot:sync:lock:';
// Peak period: increase lock TTL from 45min to 120min to prevent lock expiry during long syncs
function getBotLockTtl(): number {
  const { getPeakTimeoutMultiplier } = require('./gdt-direct-api.service');
  const m: number = getPeakTimeoutMultiplier();
  return m > 1 ? 120 * 60 : 45 * 60; // seconds
}
const BOT_CANCEL_PREFIX = 'bot:sync:cancel:';

// Fenced-lock Lua script: only DELETE if value matches our token.
// Prevents cross-job unlock race when manualWorker timeout fires and a new job
// re-acquires the lock before the background processGdtSync finishes.
const LOCK_RELEASE_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;

// Module-level map: job.id → lockToken.
// Populated by processGdtSync after lock acquired; read by manualWorker timeout handler.
const _activeLockTokens = new Map<string, string>();

/**
 * Acquire per-company Redis lock.
 * Returns the lock token (UUID) on success, or null if already locked.
 * Store the token and pass to releaseCompanyLock() so no other job can release it.
 */
async function acquireCompanyLock(companyId: string): Promise<string | null> {
  const token  = uuidv4();
  const result = await _lockRedis.set(`${BOT_LOCK_PREFIX}${companyId}`, token, 'EX', getBotLockTtl(), 'NX');
  return result === 'OK' ? token : null;
}

/**
 * Release per-company Redis lock — ONLY if the stored value matches `token`.
 * Safe to call even after a timeout handler has already deleted the lock: Lua returns 0 (no-op).
 */
async function releaseCompanyLock(companyId: string, token: string): Promise<void> {
  await _lockRedis.eval(LOCK_RELEASE_LUA, 1, `${BOT_LOCK_PREFIX}${companyId}`, token);
}

/** Flush ALL bot locks on startup — if the process restarted, no locks are legitimately held. */
export async function flushStaleLocks(): Promise<void> {
  const botKeys = await _lockRedis.keys(`${BOT_LOCK_PREFIX}*`);
  const syncKeys = await _lockRedis.keys('sync:lock:*');
  const allKeys = [...botKeys, ...syncKeys];
  if (allKeys.length > 0) {
    await _lockRedis.del(...allKeys);
    logger.info('[SyncWorker] Flushed stale locks on startup', { count: allKeys.length, keys: allKeys });
  }
}

/**
 * Returns true if the user requested cancellation for this company.
 * Deletes the cancel key atomically on first detection so it fires only once.
 */
async function checkCancellationRequested(companyId: string): Promise<boolean> {
  const deleted = await _lockRedis.del(`${BOT_CANCEL_PREFIX}${companyId}`);
  return deleted > 0;
}

function jitteredDelay(): Promise<void> {
  const ms = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Returns a log-safe proxy address: strips credentials, shows only host:port.
 * e.g. "http://user:pass@1.2.3.4:8080" → "1.2.3.4:8080"
 */
function _maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`;
  } catch {
    return url.replace(/\/\/.*@/, '//').slice(0, 40);
  }
}

/** Occasional longer pause to simulate reading/examining an invoice */
let _nextReadPause = READ_PAUSE_EVERY_MIN + Math.floor(Math.random() * (READ_PAUSE_EVERY_MAX - READ_PAUSE_EVERY_MIN));
function shouldReadPause(index: number): boolean {
  if (index > 0 && index % _nextReadPause === 0) {
    _nextReadPause = READ_PAUSE_EVERY_MIN + Math.floor(Math.random() * (READ_PAUSE_EVERY_MAX - READ_PAUSE_EVERY_MIN));
    return true;
  }
  return false;
}
function readPause(): Promise<void> {
  const ms = READ_PAUSE_MIN + Math.random() * (READ_PAUSE_MAX - READ_PAUSE_MIN);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Human-like "think time" before key actions (login, first fetch, etc.).
 * Mimics the seconds a real accountant takes to navigate between pages.
 * min/max in milliseconds.
 */
function thinkTime(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

interface SyncJobGroupItem {
  fromDate: string;
  toDate:   string;
  label:    string;
}
interface SyncJobData {
  companyId: string;
  runId?: string;
  fromDate?: string; // YYYY-MM-DD, optional — job-specific override
  toDate?:   string; // YYYY-MM-DD, optional
  label?:    string; // display label (e.g. 'Tháng 1')
  // VĐ4: Dynamic job deadline stored in job data (BullMQ v3 has no per-job timeout option)
  dynamicTimeoutMs?: number;
  // Sequential chaining fields (quarter sync)
  groupId?:   string;
  jobIndex?:  number; // 0-based index in the group
  jobTotal?:  number; // total jobs in the group
  allJobs?:   SyncJobGroupItem[]; // all jobs, so each job can enqueue the next
  isChained?: boolean; // true = this job was enqueued by the previous month in a quarter sync
  // BUG2 FIX: userId of the person who triggered manual sync (not necessarily OWNER)
  // Must be set for all manual jobs so proxy is acquired for the correct user.
  triggeredByUserId?: string;
  // BOT-LICENSE-01: resolved plan id from LicenseService (passed by backend/routes/bot.ts)
  userPlan?: string;
  // Origin of the trigger — 'user_manual' | 'user_quick_sync' | 'auto_scheduler' | 'quarter_group'
  triggeredBy?: string;
}

const xmlParser = new GdtXmlParser();

// ── Phase 5: Smart enqueue with mutual exclusion ──────────────────────────────

const BOT_PENDING_PREFIX  = 'bot:pending:';
const BOT_PRIORITY_PREFIX = 'bot:priority:';

// ── Phase 6: Token bucket rate limiter ───────────────────────────────────────

interface RateLimitState {
  tokens:     number;
  lastRefill: number;
  plan:       string;
}
interface RateLimitResult {
  allowed:         boolean;
  tokensRemaining?: number;
  retryAfterMs?:   number;
  message?:        string;
  suggestion?:     string;
}

const RATE_LIMIT_PLANS: Record<string, { tokensPerHour: number; burstMax: number }> = {
  free:       { tokensPerHour: 3,  burstMax: 3  },
  pro:        { tokensPerHour: 10, burstMax: 5  },
  enterprise: { tokensPerHour: 30, burstMax: 10 },
};
const RATE_LIMIT_DEFAULT_PLAN = 'free';

/**
 * Phase 6: Token bucket rate limiter — prevents manual sync abuse per user.
 * Redis key: ratelimit:manual:{userId}   TTL: 86400s
 * Admin override key: ratelimit:override:{userId}  — set by admin API to bypass limits
 */
export async function checkManualRateLimit(
  userId: string,
  plan:   string,
): Promise<RateLimitResult> {
  void userId;
  void plan;
  return { allowed: true, tokensRemaining: -1 };
}

type EnqueueResult =
  | { status: 'enqueued';      jobId: string }
  | { status: 'promoted';      message: string }
  | { status: 'notified';      message: string }
  | { status: 'skipped';       message: string }
  | { status: 'deduplicated';  message: string };

/**
 * Phase 5: Smart enqueue with mutual exclusion.
 * - Manual + running job     → set priority flag, current job will yield checkpoint at next check
 * - Auto + running job       → skip (already running)
 * - Manual + waiting in queue → promote to manualQueue with higher priority
 * - Auto + waiting in queue  → deduplicate (skip)
 * - No conflict              → enqueue normally, register pending key
 *
 * Phase 6: Applies token bucket rate limit for manual enqueues.
 * Pass userId + userPlan to enable rate limiting; omit to skip the check.
 */
export async function enqueueSync(
  companyId: string,
  type: 'manual' | 'auto',
  jobData: SyncJobData,
  userId?:   string,
  userPlan?: string,
): Promise<EnqueueResult> {
  try {
    // Phase 6: Rate limit check for manual syncs
    if (type === 'manual' && userId) {
      const rl = await checkManualRateLimit(userId, userPlan ?? RATE_LIMIT_DEFAULT_PLAN);
      if (!rl.allowed) {
        return {
          status:  'skipped',
          message: rl.message ?? 'Rate limit exceeded',
        };
      }
    }
    // 1. Check if a job is currently RUNNING (lock held)
    const isLocked = await _lockRedis.exists(`${BOT_LOCK_PREFIX}${companyId}`);
    if (isLocked) {
      if (type === 'manual') {
        await _lockRedis.set(`${BOT_PRIORITY_PREFIX}${companyId}`, 'manual', 'EX', 300);
        return { status: 'notified', message: 'Đang sync, sẽ ưu tiên trong vài giây' };
      }
      return { status: 'skipped', message: 'Job đang chạy, bỏ qua lần này' };
    }

    // 2. Check if a job is PENDING in queue
    const pendingJobId = await _lockRedis.get(`${BOT_PENDING_PREFIX}${companyId}`);
    if (pendingJobId) {
      if (type === 'manual') {
        // Promote existing auto-job to manual queue (higher concurrency + priority)
        const addedJob = await manualQueue.add('sync', jobData, { priority: 1 });
        await _lockRedis.set(`${BOT_PENDING_PREFIX}${companyId}`, addedJob.id ?? pendingJobId, 'EX', 3600);
        return { status: 'promoted', message: 'Đã ưu tiên lên đầu hàng' };
      }
      return { status: 'deduplicated', message: 'Job đã trong hàng chờ' };
    }

    // 3. No conflict — enqueue normally
    const queue = type === 'manual' ? manualQueue : autoQueue;
    // VĐ4: Embed dynamic timeout in job data (BullMQ v3 has no per-job timeout field)
    const enrichedJobData: SyncJobData = { ...jobData };
    try {
      const raw = await _lockRedis.get(`${VOLUME_ESTIMATE_KEY_PREFIX}${companyId}`).catch(() => null);
      if (raw) {
        const est = JSON.parse(raw) as { outCount: number; inCount: number };
        enrichedJobData.dynamicTimeoutMs = calculateJobTimeout(est);
      }
    } catch { /* non-fatal */ }
    const jobOptions = type === 'manual' ? { priority: 1 } : {};
    const addedJob = await queue.add('sync', enrichedJobData, jobOptions);
    const jobId = addedJob.id ?? uuidv4();
    await _lockRedis.set(`${BOT_PENDING_PREFIX}${companyId}`, jobId, 'EX', 3600);
    return { status: 'enqueued', jobId };
  } catch (err) {
    logger.warn('[SyncWorker] enqueueSync error (non-fatal, falling back to direct enqueue)', {
      companyId, type, error: (err as Error).message,
    });
    const queue = type === 'manual' ? manualQueue : autoQueue;
    const addedJob = await queue.add('sync', jobData, type === 'manual' ? { priority: 1 } : {});
    return { status: 'enqueued', jobId: addedJob.id ?? uuidv4() };
  }
}

async function processGdtSync(job: Job<SyncJobData>): Promise<void> {
  const { companyId, fromDate: jobFromDate, toDate: jobToDate } = job.data;
  const runId     = job.data.runId ?? uuidv4();
  const startedAt = Date.now();

  // VĐ4: Enforce dynamic deadline from job data (set by enqueueSync based on volume estimate)
  const jobDeadlineMs = job.data.dynamicTimeoutMs
    ? startedAt + job.data.dynamicTimeoutMs
    : startedAt + 30 * 60_000; // hard cap: 30 minutes
  function checkDeadline(): void {
    if (Date.now() > jobDeadlineMs) {
      const ranMin = Math.round((Date.now() - startedAt) / 60_000);
      throw new Error(`DEADLINE_EXCEEDED: Job exceeded dynamic timeout after ${ranMin}m`);
    }
  }

  const queueType = job.queueName === 'gdt-sync-manual' ? 'MANUAL' : 'AUTO';
  logger.info('[SyncWorker] Starting job', {
    jobId: job.id,
    companyId,
    queueType,
    triggeredBy:       job.data.triggeredBy       ?? 'auto',
    triggeredByUserId: job.data.triggeredByUserId
      ? job.data.triggeredByUserId.slice(0, 8) + '…'
      : '—',
    timeoutMin: Math.round((jobDeadlineMs - startedAt) / 60_000),
  });

  // Detect whether this job came from the user-triggered manual queue.
  // Manual jobs get: no off-hours delay, reduced thinkTime, proxy probe, strict timeout.
  const isManual  = job.queueName === 'gdt-sync-manual';
  // Chained jobs are sequential months in a quarter sync (enqueued by the previous month).
  // They reuse the cached GDT token (no new login), so the 15-min login cooldown does not apply.
  const isChained = job.data.isChained ?? false;

  // BOT-LICENSE-01: Enforce rate limit for manual jobs using the plan resolved at enqueue time.
  // This check runs BEFORE acquiring the company lock so the lock is not wasted.
  if (isManual && job.data.triggeredByUserId) {
    const rl = await checkManualRateLimit(
      job.data.triggeredByUserId,
      job.data.userPlan ?? RATE_LIMIT_DEFAULT_PLAN,
    );
    if (!rl.allowed) {
      logger.warn('[SyncWorker] Manual rate limit exceeded — dropping job', {
        jobId:    job.id,
        userId:   job.data.triggeredByUserId.slice(0, 8) + '…',
        userPlan: job.data.userPlan,
        message:  rl.message,
      });
      // UnrecoverableError: do not retry — limit will reset on its own
      throw new UnrecoverableError(`RATE_LIMIT: ${rl.message ?? 'Rate limit exceeded'}`);
    }
  }

  // ── 0. Time-of-day awareness (BEFORE lock — don't hold lock while sleeping) ──
  // Prefer running during Vietnam business hours (8am-8pm GMT+7).
  // Skip delay for: development, first-run jobs triggered manually by user setup, manual queue.
  const isDev = process.env['NODE_ENV'] !== 'production';
  const isFirstRun = (job.id ?? '').startsWith('gdt-bot-first-');
  if (!isDev && !isFirstRun && !isManual) {
    const vnNow  = new Date(Date.now() + 7 * 3600_000);
    const vnHour = vnNow.getUTCHours();
    const vnMin  = vnNow.getUTCMinutes();
    // Only block during 2:00–4:00 AM Vietnam time.
    // Sleep until 4:00 AM + up to 5 min jitter so jobs don't all pile up at once.
    if (vnHour >= 2 && vnHour < 4) {
      const msUntil4am = ((4 - vnHour) * 60 - vnMin) * 60_000;
      const delayMs    = msUntil4am + Math.floor(Math.random() * 5 * 60_000);
      logger.info('[SyncWorker] Off-hours delay (VN time)', { vnHour, vnMin, delayMs });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Per-company mutex via Redis SET NX — atomic, no TOCTOU race.
  // Throw regular Error → BullMQ retries with the job's configured backoff.
  // (moveToDelayed requires Redis 6.2+; our Redis 5.0.14 doesn't support it.)
  // This throw is BEFORE the inner try/catch, so _failRun() is NOT called.
  // Fenced lock: returns token on success, null if already locked.
  const lockToken = await acquireCompanyLock(companyId);
  if (!lockToken) {
    logger.warn('[SyncWorker] Company already syncing — will retry via backoff', { jobId: job.id, companyId });
    throw new Error(`LOCK_CONFLICT: company ${companyId} already syncing`);
  }
  // Register token so manualWorker timeout handler can do a fenced release.
  if (job.id) _activeLockTokens.set(job.id, lockToken);

  // FIX-3: Lock heartbeat — renews the 45-minute TTL every 10 minutes.
  // Prevents lock expiry during 100k+ invoice runs (2–30h) which would allow
  // a second job to acquire the lock and cause concurrent DB writes.
  const lockHeartbeat = setInterval(async () => {
    try {
      await _lockRedis.expire(`${BOT_LOCK_PREFIX}${companyId}`, getBotLockTtl());
    } catch (e) {
      logger.warn('[SyncWorker] Lock heartbeat thất bại (non-fatal)', { companyId, err: (e as Error).message });
    }
  }, 10 * 60 * 1000); // every 10 min
  try {

    // ── 1. Load config ──────────────────────────────────────────────────────────
    const cfgRes = await pool.query(
      `SELECT encrypted_credentials, has_otp, otp_method, tax_code,
              blocked_until, proxy_session_id, consecutive_failures, last_run_at,
              sync_frequency_hours
       FROM gdt_bot_configs WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    if (cfgRes.rows.length === 0) {
      throw new UnrecoverableError(`[SyncWorker] No active config for company ${companyId}`);
    }
    const cfg = cfgRes.rows[0] as {
      encrypted_credentials: string;
      has_otp: boolean;
      otp_method: string;
      tax_code: string;
      blocked_until: string | null;
      proxy_session_id: string | null;
      consecutive_failures: number;
      last_run_at: string | null;
      sync_frequency_hours: number;
    };

    // Manual sync: clear the auto-block so the user can force a re-run.
    // The block was set by _failRun after consecutive failures (captcha/proxy errors).
    // A manual action means the user knows what they're doing — honour the request.
    if (isManual && cfg.blocked_until && new Date(cfg.blocked_until) > new Date()) {
      logger.info('[SyncWorker] Manual sync — clearing auto-block', { companyId, was_blocked_until: cfg.blocked_until });
      await pool.query(
        `UPDATE gdt_bot_configs
         SET blocked_until = NULL, consecutive_failures = 0, updated_at = NOW()
         WHERE company_id = $1`,
        [companyId]
      );
      cfg.blocked_until = null;
      cfg.consecutive_failures = 0;
    }

    // Check if blocked — skip _failRun (not a real failure, just a cooldown)
    if (cfg.blocked_until && new Date(cfg.blocked_until) > new Date()) {
      logger.warn('[SyncWorker] Company blocked until', { companyId, blocked_until: cfg.blocked_until });
      throw new Error(`COOLDOWN_SKIP: Bot blocked until ${cfg.blocked_until}`);
    }

    // ── 1b. Quota gate ─────────────────────────────────────────────────────────
    // Throws UnrecoverableError if owner's quota is exhausted or subscription suspended.
    await _checkQuota(companyId);

    // Anti-detection: enforce minimum 5 minutes between logins per company.
    // Prevents rapid successive logins to GDT (e.g. from manual retrigger or BullMQ backoff cascade).
    // Manual sync jobs bypass this cooldown — the user explicitly requested immediate sync.
    // Chained jobs (quarter sync month 2/3) also bypass — they reuse the cached session token,
    // so no new GDT login happens and there is no spam risk.
    const MIN_LOGIN_INTERVAL_MS = 5 * 60 * 1000;
    if (!isManual && !isChained && cfg.last_run_at) {
      const elapsedMs = Date.now() - new Date(cfg.last_run_at).getTime();
      if (elapsedMs < MIN_LOGIN_INTERVAL_MS) {
        const elapsedMin = Math.floor(elapsedMs / 60_000);
        const waitMin    = Math.ceil((MIN_LOGIN_INTERVAL_MS - elapsedMs) / 60_000);
        logger.warn('[SyncWorker] Login cooldown active — too soon since last run', {
          companyId, elapsedMin, waitMin,
        });
        // Regular Error (not UnrecoverableError) so BullMQ retries quarter jobs.
        // With exponential backoff (1m, 2m, 4m, 8m, 16m), the 15-min cooldown
        // will have expired by the 4th retry. COOLDOWN_SKIP prefix → catch skips _failRun.
        throw new Error(
          `COOLDOWN_SKIP: Login cooldown: last run ${elapsedMin}m ago, wait ${waitMin}m more`,
        );
      }
    }

    // ── 2. Decrypt credentials ──────────────────────────────────────────────────
    let creds: { username: string; password: string };
    try {
      creds = decryptCredentials(cfg.encrypted_credentials);
    } catch (err) {
      // Credential decryption failure — deactivate permanently
      await pool.query(
        `UPDATE gdt_bot_configs SET is_active = false, last_error = $1, updated_at = NOW() WHERE company_id = $2`,
        ['Lỗi giải mã thông tin đăng nhập — vui lòng cấu hình lại', companyId]
      );
      throw new UnrecoverableError('[SyncWorker] Failed to decrypt credentials — deactivating bot');
    }

    // ── 3. Sticky proxy per company ────────────────────────────────────────────
    // Proxy selection:
    //   Manual sync → static pool, per-user sticky from DB
    //   Auto sync   → DB static pool, hash-keyed by proxy_session_id
    let proxySessionId = cfg.proxy_session_id;
    if (!proxySessionId) {
      proxySessionId = randomBytes(8).toString('hex'); // 16-char hex, e.g. 'a3f9b2c1d4e5f678'
      await pool.query(
        `UPDATE gdt_bot_configs SET proxy_session_id = $1, updated_at = NOW() WHERE company_id = $2`,
        [proxySessionId, companyId]
      );
      logger.info('[SyncWorker] New proxy session assigned', { companyId, proxySessionId });
    }

    let proxyUrl: string | null;
    let socks5ProxyUrl: string | null;

    if (isManual) {
      // Manual sync: ONLY static residential proxy pool, keyed to the triggering user.
      // triggeredByUserId must be set at enqueue time (backend/routes/bot.ts).
      // Fall back to OWNER only if job was enqueued by legacy code without userId.
      const triggerUserId = job.data.triggeredByUserId ?? await _getCompanyOwner(companyId);
      if (triggerUserId) {
        proxyUrl = await proxyManager.nextForManualSync(triggerUserId);
        const maskedIp = proxyUrl ? _maskProxyUrl(proxyUrl) : 'none';
        logger.info('[SyncWorker] Proxy selected — MANUAL (static IP)', {
          companyId,
          taxCode:      cfg.tax_code,
          proxyIp:      maskedIp,
          userId:       triggerUserId.slice(0, 8) + '…',
          isManual:     true,
        });
      } else {
        logger.warn('[SyncWorker] Manual sync: no triggerUserId and no OWNER found', { companyId });
        proxyUrl = null;
      }
      // SOCKS5 not available for static proxies (HTTP CONNECT only) — set null explicitly
      socks5ProxyUrl = null;
    } else {
      // Auto sync: DB-backed static proxy pool, keyed by session suffix
      proxyUrl       = await proxyManager.nextForAutoSync(proxySessionId);
      socks5ProxyUrl = proxyManager.nextSocks5ForCompany(proxySessionId);
      const maskedIp = proxyUrl ? _maskProxyUrl(proxyUrl) : 'none';
      logger.info('[SyncWorker] Proxy selected — AUTO (Static)', {
        companyId,
        taxCode:      cfg.tax_code,
        proxyIp:      maskedIp,
        sessionId:    proxySessionId?.slice(0, 8) ?? '—',
        isManual:     false,
      });
    }

    // Safety guard: never login to GDT without proxy protection.
    // Running without a proxy exposes the real server IP — GDT can correlate multiple
    // company logins to one IP and flag the account.
    // ALLOW_DIRECT_CONNECTION=true bypasses this guard for local development only.
    // NEVER enable in production — real server IP would be exposed to GDT.
    if (!proxyUrl) {
      const allowDirect = process.env['ALLOW_DIRECT_CONNECTION'] === 'true';
      if (!allowDirect) {
        logger.error('[SyncWorker] No static proxy available — aborting sync. Assign an active proxy in Admin > Proxy or set ALLOW_DIRECT_CONNECTION=true for dev only.', { companyId });
        throw new UnrecoverableError('[SyncWorker] No static proxy available — sync aborted for safety');
      }
      logger.warn(
        '[SyncWorker] No proxy — running with DIRECT connection (ALLOW_DIRECT_CONNECTION=true). ' +
        'DO NOT use in production!',
        { companyId },
      );
    }

    // ── 3b. Pre-sync proxy health check ────────────────────────────────────────
    // TCP probe before consuming a DB run row or doing any work.
    // Catches dead proxies (wrong port, server down, IP banned) before login fails mid-sync.
    // Only runs when a proxyUrl is assigned. Auto-syncs also probe but with a longer timeout.
    if (proxyUrl) {
      const probeTimeoutMs = isManual ? 4_000 : 8_000;
      await job.updateProgress({ percent: 0, statusMessage: 'Đang kiểm tra proxy...' });
      const proxyOk = await proxyManager.probe(proxyUrl, probeTimeoutMs);
      if (!proxyOk) {
        proxyManager.markFailed(proxyUrl);
        logger.warn('[SyncWorker] Proxy health check FAILED', {
          companyId,
          taxCode:  cfg.tax_code,
          proxyIp:  _maskProxyUrl(proxyUrl),
          mode:     isManual ? 'MANUAL/static' : 'AUTO/static',
        });
        // Clear the DB proxy_session_id so next run gets a fresh session ID → fresh IP.
        await pool.query(
          `UPDATE gdt_bot_configs SET proxy_session_id = NULL, updated_at = NOW() WHERE company_id = $1`,
          [companyId],
        );
        throw new Error(`PROXY_DEAD: Proxy TCP probe failed (${proxyUrl.slice(0, 32)}…) — will retry`);
      }
      logger.info('[SyncWorker] Proxy TCP probe OK', {
        companyId,
        taxCode:  cfg.tax_code,
        proxyIp:  _maskProxyUrl(proxyUrl),
        mode:     isManual ? 'MANUAL/static' : 'AUTO/static',
      });
    }

    // ── 4. Login via GDT Direct API ──────────────────────────────────────────────
    const existingRunRes = await pool.query(
      `UPDATE gdt_bot_runs
       SET started_at = NOW(),
           finished_at = NULL,
           status = 'running',
           error_detail = NULL,
           output_count = 0,
           input_count = 0,
           duration_ms = NULL
       WHERE id = $1`,
      [runId],
    );
    if ((existingRunRes.rowCount ?? 0) === 0) {
      await pool.query(
        `INSERT INTO gdt_bot_runs (id, company_id, started_at, status) VALUES ($1, $2, NOW(), 'running')`,
        [runId, companyId]
      );
    }
    // Mark config as running + clear previous error so the UI immediately reflects the new attempt.
    // Without this, gdt_bot_configs.last_run_status stays 'error' (from previous run) until
    // the new run completes — causing the UI to show stale error banners during active jobs.
    await pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_status = 'running', last_error = NULL, updated_at = NOW()
       WHERE company_id = $1`,
      [companyId]
    );

    // Human-like warmup: 3–15s random pause before opening session.
    // Simulates an accountant opening a browser and navigating to the portal.
    // Manual syncs use a shorter pause (0.5–2s) to stay within the 3-minute target.
    await job.updateProgress({ percent: 5, statusMessage: 'Đang đăng nhập GDT...' } as Record<string, unknown>);
    await thinkTime(isManual ? 300 : 1_000, isManual ? 1_000 : 5_000);

    const gdtApi = new GdtDirectApiService(proxyUrl, socks5ProxyUrl, undefined, companyId, _checkpoint, gdtRawCacheService);
    // VĐ1: Wire proxy manager for mid-request proxy swap on TCP drops
    if (proxyUrl && proxySessionId) {
      gdtApi.setProxyManager(proxyManager, proxySessionId);
    }

    // FIX-PERF-01: Check session cache — skip captcha+login if we have a valid token.
    // Manual sync MUST NOT reuse a cached token from auto-sync.
    // GDT binds sessions to IP — reusing a token across different proxy IPs causes 401.
    let cachedToken: string | null = null;
    if (!isManual) {
      try {
        cachedToken = await _sessionCache.get(companyId, proxySessionId ?? '');
      } catch (cacheErr) {
        logger.warn('[SyncWorker] Session cache read failed (non-fatal)', { companyId });
      }
    }
    if (cachedToken) {
      gdtApi.setToken(cachedToken);
      logger.info('[SyncWorker] Reusing cached GDT session token — skipping login', { companyId });
    } else {
      try {
        await gdtApi.login(creds.username, creds.password, isManual);
        try {
          const freshToken = gdtApi.getToken();
          if (freshToken) await _sessionCache.set(companyId, proxySessionId ?? '', freshToken);
        } catch { /* non-fatal — cache write failure never blocks sync */ }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const msgLc = msg.toLowerCase();
        // Captcha failures (from gdt-direct-api after exhausting MAX_RETRIES) are transient —
        // do NOT deactivate the account. GDT returns wrong-captcha for 400/401, so
        // 'auth failed' can appear in the message even for captcha issues.
        const isCaptchaFailure = msgLc.includes('captcha') || msgLc.includes('mã xác nhận');
        const isInvalidCreds = !isCaptchaFailure && (
          msgLc.includes('auth failed') ||
          msgLc.includes('mật khẩu') ||
          msgLc.includes('sai thông tin')
        );
        if (isInvalidCreds) {
          await _sessionCache.invalidate(companyId, proxySessionId ?? '').catch(() => {});
          await _failRun(runId, companyId, msg, true);
          throw new UnrecoverableError(`[SyncWorker] Invalid credentials: ${msg}`);
        }
      // Non-credential failure (proxy blocked, GDT rate-limit, network error).
        // Mark current proxy as failed and clear the sticky session —
        // next run will pick a fresh session ID = fresh IP for this company only.
        if (proxyUrl) proxyManager.markFailed(proxyUrl);
        // Detect if the error is a pre-GDT network/proxy/TLS failure.
        // In that case GDT never received any login attempt — no need for the
        // 15-minute cooldown. BullMQ backoff + consecutive_failures block handles protection.
        // Use lowercase (msgLc) for case-insensitive matching.
        // 'Proxy CONNECT failed' has capital P — msg.includes('proxy') missed it.
        // 'stream has been aborted' also wasn't detected.
        const isProxyOrNetworkError =
          msgLc.includes('socket disconnected') ||
          msgLc.includes('econnreset') ||
          msgLc.includes('etimedout') ||
          msgLc.includes('econnrefused') ||
          msgLc.includes('tls') ||
          msgLc.includes('ssl') ||
          msgLc.includes('proxy') ||
          msgLc.includes('stream') ||
          msgLc.includes('aborted') ||
          msgLc.includes('407') ||
          msgLc.includes('connect failed');
        // _failRun increments consecutive_failures + clears proxy_session_id in DB
        await _failRun(runId, companyId, msg, false, isProxyOrNetworkError);
        throw new Error(`[SyncWorker] Login failed: ${msg}`);
      }
    }

    // ── 5. Fetch invoices via Direct API ─────────────────────────────────────────
    const runner = gdtApi;
    let outputCount     = 0;
    let inputCount      = 0;
    let skippedCount    = 0; // FIX-PERF-01
    // Only NEWLY inserted invoices count against quota — updates are free.
    // outputCount/inputCount track total fetched (display), newInvoiceCount tracks billing.
    let newInvoiceCount = 0;
    let outEst          = -1;
    let inEst           = -1;
    let lastFetchProgressAt = 0;
    let lastFetchPercent = 5;
    let lastFetchStatus  = 'Đang đăng nhập GDT...';

    const emitFetchProgress = async (snapshot: GdtFetchProgressSnapshot): Promise<void> => {
      const isOutput = snapshot.endpoint === 'sold';
      const estimate = isOutput ? outEst : inEst;
      const [minPercent, maxPercent] = isOutput
        ? (snapshot.stage === 'sco' ? [32, 55] : [12, 32])
        : (snapshot.stage === 'sco' ? [82, 96] : [55, 82]);

      const ratios: number[] = [];
      if (snapshot.reportedTotal && snapshot.reportedTotal > 0) {
        ratios.push(snapshot.fetched / snapshot.reportedTotal);
      }
      if (estimate > 0) {
        ratios.push(snapshot.fetched / estimate);
      }
      if (snapshot.totalPages && snapshot.totalPages > 0) {
        ratios.push(snapshot.currentPage / snapshot.totalPages);
      }

      let relativeProgress = ratios.length > 0
        ? Math.max(...ratios)
        : (snapshot.currentPage > 1 ? Math.min(0.5, snapshot.currentPage / 5) : (snapshot.fetched > 0 ? 0.12 : 0.04));

      if (snapshot.chunkTotal && snapshot.chunkTotal > 0) {
        relativeProgress = ((snapshot.chunkIndex ?? 1) - 1 + Math.min(1, Math.max(relativeProgress, snapshot.fetched > 0 ? 0.08 : 0.03)))
          / snapshot.chunkTotal;
      }

      const percent = Math.max(
        lastFetchPercent,
        Math.round(minPercent + Math.min(1, relativeProgress) * (maxPercent - minPercent)),
      );

      const chunkSuffix = snapshot.chunkTotal && snapshot.chunkTotal > 1
        ? ` · đợt ${snapshot.chunkIndex ?? 1}/${snapshot.chunkTotal}`
        : '';
      const stageSuffix = snapshot.stage === 'sco' ? ' (SCO)' : '';
      const filterSuffix = !isOutput && snapshot.filter
        ? ` ${snapshot.filter.replace('ttxly==', 'TTXL ')}`
        : '';
      const statusMessage = isOutput
        ? `Đang tải HĐ đầu ra${stageSuffix}${chunkSuffix}...`
        : `Đang tải HĐ đầu vào${stageSuffix}${filterSuffix}${chunkSuffix}...`;

      const fetchedForUi = isOutput
        ? Math.max(outputCount, snapshot.fetched) + inputCount
        : outputCount + Math.max(inputCount, snapshot.fetched);

      const now = Date.now();
      const shouldPush =
        percent > lastFetchPercent ||
        statusMessage !== lastFetchStatus ||
        now - lastFetchProgressAt >= 1200 ||
        snapshot.currentPage === 1;

      if (!shouldPush) return;

      lastFetchPercent = percent;
      lastFetchStatus = statusMessage;
      lastFetchProgressAt = now;

      await job.updateProgress({
        percent,
        invoicesFetched: fetchedForUi,
        currentPage: snapshot.currentPage,
        totalPages: snapshot.totalPages,
        statusMessage,
      } as Record<string, unknown>);
    };

    gdtApi.setFetchProgressReporter(emitFetchProgress);

    try {
      // Date range priority:
      // 1. Explicit jobFromDate/jobToDate (manual sync, quarter sync) — use as-is
      // 2. No explicit dates (GdtBotScheduler jobs): compute at EXECUTION time from last_run_at
      //    → avoids stale dates when jobs sit in queue for hours (e.g. off-hours delay)
      // 3. First run ever: start of current month
      const toDate = jobToDate ? new Date(`${jobToDate}T23:59:59`) : new Date();

      let fromDate: Date;
      if (jobFromDate) {
        fromDate = new Date(`${jobFromDate}T00:00:00`);
      } else if (cfg.last_run_at) {
        // Anchor to last successful run with 5-min overlap to cover boundary invoices.
        // Computed at run-time so the range is always fresh, regardless of when the job was enqueued.
        const lastRunMs = new Date(cfg.last_run_at).getTime() - 5 * 60_000;
        // Never exceed GDT 31-day limit
        const maxBackMs = toDate.getTime() - 31 * 24 * 60 * 60_000;
        fromDate = new Date(Math.max(lastRunMs, maxBackMs));
      } else {
        // First run ever (no last_run_at): search last 31 days so a newly-onboarded
        // company captures all recent invoices, not just the current calendar month.
        // (GDT 31-day hard limit is respected — the clamp below enforces it regardless.)
        fromDate = new Date(toDate.getTime() - 31 * 24 * 60 * 60_000);
      }

      // Enforce GDT max 31-day rule: nếu range vượt quá, co lại từ toDate về đủ 31 ngày.
      // Normalize về 00:00:00 đầu ngày để tránh kiệu T23:59:59 bị kế thừa từ toDate.
      // Helper: format Date as local YYYY-MM-DD (avoids UTC shift from toISOString)
      const fmtLocal = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
      if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
        const clampedDate = new Date(toDate.getTime() - MAX_RANGE_MS);
        // Normalize using local getters so the date string matches Vietnam timezone
        const clampedStr = fmtLocal(clampedDate);
        logger.warn('[SyncWorker] Date range exceeds 31 days — clamping fromDate', {
          original: fmtLocal(fromDate),
          clamped:  clampedStr,
        });
        fromDate = new Date(`${clampedStr}T00:00:00`);
      }

      logger.info('[SyncWorker] Date range', {
        from: fmtLocal(fromDate),
        to:   fmtLocal(toDate),
        source: jobFromDate ? 'job' : 'default',
      });

      const yyyymm = `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, '0')}`;

      // ── Phase 3: Pre-flight volume estimate ────────────────────────────────
      // Fetch X-Total-Count from GDT with size=1 (no data downloaded) to warn
      // the user if the sync will take a very long time.
      // Runs in parallel (Promise.all) — both calls are lightweight (size=1 each).
      [outEst, inEst] = await Promise.all([
        runner.prefetchCount('sold', fromDate, toDate).catch(() => -1),
        runner.prefetchCount('purchase', fromDate, toDate).catch(() => -1),
      ]);
      // VĐ4: Persist volume estimate so next enqueueSync can set accurate job timeout
      if (outEst >= 0 || inEst >= 0) {
        await storeVolumeEstimate(
          _lockRedis,
          companyId,
          outEst >= 0 ? outEst : 0,
          inEst  >= 0 ? inEst  : 0,
        );
      }
      if (outEst >= 0 || inEst >= 0) {
        const estimatedMs = GdtDirectApiService.estimateSyncDurationMs(
          outEst >= 0 ? outEst : 0,
          inEst  >= 0 ? inEst  : 0,
        );
        const estimatedMin = Math.round(estimatedMs / 60_000);
        const isLargeVolume = (outEst + inEst) > 10_000 || estimatedMin > 120;
        logger.info('[SyncWorker] Ước tính khối lượng đồng bộ', {
          outEst, inEst, estimatedMin, isLargeVolume,
        });
        if (isLargeVolume) {
          await job.updateProgress({
            percent: 8,
            statusMessage: `⚠️ Khối lượng lớn: ~${outEst + inEst} hóa đơn, ước tính ${estimatedMin} phút`,
            estimatedMinutes: estimatedMin,
            outputEstimate:   outEst,
            inputEstimate:    inEst,
            warning: 'LARGE_VOLUME',
          } as Record<string, unknown>);
        }
      }

      await job.updateProgress({
        percent: Math.max(lastFetchPercent, 12),
        invoicesFetched: 0,
        currentPage: 1,
        totalPages: outEst > 0 ? Math.max(1, Math.ceil(outEst / 50)) : null,
        statusMessage: 'Đang tải HĐ đầu ra từ GDT...',
      } as Record<string, unknown>);
      lastFetchPercent = Math.max(lastFetchPercent, 12);
      lastFetchStatus = 'Đang tải HĐ đầu ra từ GDT...';

      // Phase 8: Stream output invoices page-by-page (HĐ đầu ra)
      // Each page (~50 invoices) is deduped + upserted as it arrives — lower memory,
      // earlier progress updates, and streaming naturally fits our UNNEST batch size.
      //
      // NOTE: GDT's pre-flight count (outEst/inEst) is NOT reliable — it can return 0
      // while the actual paginated fetch still returns invoices. Do NOT skip fetching
      // based on the estimate alone. The estimate is used only for progress/warning UI.
      const BATCH_SIZE = 50;
      const outDedupSetKey = `gdt:dedup:${companyId}:${yyyymm}:output`;
      let outPageIdx = 0;

      for await (const pageBatch of runner.fetchOutputInvoicesStream(fromDate, toDate)) {
        // Dedup check: pipeline SISMEMBER for this page batch
        const batchOutKeys = pageBatch.map(inv =>
          _dedup.invoiceKey(
            inv.invoice_number ?? '',
            inv.serial_number ?? '',
            inv.invoice_date ?? '',
            inv.seller_tax_code ?? '',
          ));
        const outDedupPipe = _lockRedis.pipeline();
        for (const dk of batchOutKeys) outDedupPipe.sismember(outDedupSetKey, dk);
        const outDedupResults = await outDedupPipe.exec().catch(() => null);

        const toUpsertOut: Array<{ inv: typeof pageBatch[0]; dk: string }> = [];
        for (let i = 0; i < pageBatch.length; i++) {
          if ((outDedupResults?.[i]?.[1] as number) === 1) { skippedCount++; continue; }
          toUpsertOut.push({ inv: pageBatch[i]!, dk: batchOutKeys[i]! });
        }

        if (toUpsertOut.length > 0) {
          // Batch upsert (UNNEST — 1 DB round-trip for up to 50 invoices)
          for (let b = 0; b < toUpsertOut.length; b += BATCH_SIZE) {
            const slice = toUpsertOut.slice(b, b + BATCH_SIZE);
            const { map: idMap, newCount: outNew } = await _batchUpsertInvoices(slice.map(x => x.inv), companyId, 'output');
            outputCount     += slice.length;
            newInvoiceCount += outNew;

            // Batch dedup markSeen
            await _lockRedis.pipeline()
              .sadd(outDedupSetKey, ...slice.map(x => x.dk))
              .expire(outDedupSetKey, 7200)
              .exec().catch(() => {});

            // Phase 2: enqueue detail fetch for all invoices in this slice.
            // detail.worker (separate PM2 process) picks them up and fetches
            // raw_detail + line_items asynchronously via the same GDT session.
            // Promise.allSettled: one enqueue failure never blocks the others.
            await Promise.allSettled(
              slice.map(({ inv }) => {
                const invoiceId = idMap.get(_invMapKey(inv)) ?? null;
                if (!invoiceId) return Promise.resolve();
                // Priority 1 = manual (user waiting), 5 = auto background
                return _enqueueForDetail(inv, invoiceId, companyId, isManual ? 1 : 5);
              })
            );
          }
        }

        outPageIdx++;

        // Cancellation + YIELD_TO_MANUAL + deadline check per page batch
        checkDeadline(); // VĐ4: abort if dynamic timeout exceeded
        if (await checkCancellationRequested(companyId)) {
          logger.info('[SyncWorker] Hủy đồng bộ giữa chừng (HĐ đầu ra)', { companyId, outPageIdx });
          throw new UnrecoverableError('CANCEL_SKIP: sync cancelled by user');
        }
        if (!isManual) {
          const priorityOverride = await _lockRedis.get(`${BOT_PRIORITY_PREFIX}${companyId}`).catch(() => null);
          if (priorityOverride === 'manual') {
            await _lockRedis.del(`${BOT_PRIORITY_PREFIX}${companyId}`).catch(() => {});
            logger.info('[SyncWorker] YIELD_TO_MANUAL — auto job nhường chỗ cho manual (đầu ra)', { companyId, outPageIdx });
            throw new UnrecoverableError(`YIELD_TO_MANUAL: Auto job yielding at output page ${outPageIdx}`);
          }
        }

        // Progress = total fetched / total expected (all types: output + input)
        const totalEst = (outEst >= 0 ? outEst : 0) + (inEst >= 0 ? inEst : 0);
        const totalFetched = outputCount + inputCount;
        const pct = totalEst > 0
          ? Math.min(98, Math.round((totalFetched / totalEst) * 100))
          : Math.min(49, Math.round((outputCount / Math.max(outputCount, 1)) * 49));
        await job.updateProgress({
          percent: pct,
          invoicesFetched: totalFetched,
          totalInvoicesExpected: totalEst > 0 ? totalEst : null,
          outputCount,
          inputCount,
          statusMessage: `Đang tải HĐ đầu ra: ${outputCount.toLocaleString('vi-VN')} hóa đơn...`,
          batchSize: toUpsertOut.length,
        } as Record<string, unknown>);
      }

      // Human-like pause between output and input fetch
      if (outputCount > 0) await thinkTime(600, 2_000);

      // Phase 8: Stream input invoices page-by-page (HĐ đầu vào)
      const inDedupSetKey = `gdt:dedup:${companyId}:${yyyymm}:input`;
      let inPageIdx = 0;

      for await (const pageBatch of runner.fetchInputInvoicesStream(fromDate, toDate)) {
        const batchInKeys = pageBatch.map(inv =>
          _dedup.invoiceKey(
            inv.invoice_number ?? '',
            inv.serial_number ?? '',
            inv.invoice_date ?? '',
            inv.seller_tax_code ?? '',
          ));
        const inDedupPipe = _lockRedis.pipeline();
        for (const dk of batchInKeys) inDedupPipe.sismember(inDedupSetKey, dk);
        const inDedupResults = await inDedupPipe.exec().catch(() => null);

        const toUpsertIn: Array<{ inv: typeof pageBatch[0]; dk: string }> = [];
        for (let i = 0; i < pageBatch.length; i++) {
          if ((inDedupResults?.[i]?.[1] as number) === 1) { skippedCount++; continue; }
          toUpsertIn.push({ inv: pageBatch[i]!, dk: batchInKeys[i]! });
        }

        if (toUpsertIn.length > 0) {
          for (let b = 0; b < toUpsertIn.length; b += BATCH_SIZE) {
            const slice = toUpsertIn.slice(b, b + BATCH_SIZE);
            const { map: idMap, newCount: inNew } = await _batchUpsertInvoices(slice.map(x => x.inv), companyId, 'input');
            inputCount      += slice.length;
            newInvoiceCount += inNew;

            await _lockRedis.pipeline()
              .sadd(inDedupSetKey, ...slice.map(x => x.dk))
              .expire(inDedupSetKey, 7200)
              .exec().catch(() => {});

            // Phase 2: enqueue detail fetch (same as output loop)
            await Promise.allSettled(
              slice.map(({ inv }) => {
                const invoiceId = idMap.get(_invMapKey(inv)) ?? null;
                if (!invoiceId) return Promise.resolve();
                return _enqueueForDetail(inv, invoiceId, companyId, isManual ? 1 : 5);
              })
            );
          }
        }

        inPageIdx++;

        // VĐ4: Deadline + cancellation check per input page
        checkDeadline();
        if (await checkCancellationRequested(companyId)) {
          logger.info('[SyncWorker] Hủy đồng bộ giữa chừng (HĐ đầu vào)', { companyId, inPageIdx });
          throw new UnrecoverableError('CANCEL_SKIP: sync cancelled by user');
        }
        if (!isManual) {
          const priorityOverride = await _lockRedis.get(`${BOT_PRIORITY_PREFIX}${companyId}`).catch(() => null);
          if (priorityOverride === 'manual') {
            await _lockRedis.del(`${BOT_PRIORITY_PREFIX}${companyId}`).catch(() => {});
            logger.info('[SyncWorker] YIELD_TO_MANUAL — auto job nhường chỗ cho manual (đầu vào)', { companyId, inPageIdx });
            throw new UnrecoverableError(`YIELD_TO_MANUAL: Auto job yielding at input page ${inPageIdx}`);
          }
        }

        const totalEstIn = (outEst >= 0 ? outEst : 0) + (inEst >= 0 ? inEst : 0);
        const totalFetchedIn = outputCount + inputCount;
        const pctIn = totalEstIn > 0
          ? Math.min(98, Math.round((totalFetchedIn / totalEstIn) * 100))
          : 50 + Math.min(48, Math.round((inputCount / Math.max(inputCount, 1)) * 48));
        await job.updateProgress({
          percent: pctIn,
          invoicesFetched: totalFetchedIn,
          totalInvoicesExpected: totalEstIn > 0 ? totalEstIn : null,
          outputCount,
          inputCount,
          statusMessage: `Đang tải HĐ đầu vào: ${inputCount.toLocaleString('vi-VN')} hóa đơn...`,
          batchSize: toUpsertIn.length,
        } as Record<string, unknown>);
      }

      if (proxyUrl) proxyManager.markHealthy(proxyUrl);

      // Đếm số HĐ đã enqueue detail trong 2h gần nhất cho company này
      const detailQueuedRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM invoice_detail_queue
         WHERE company_id = $1 AND enqueued_at > NOW() - INTERVAL '2 hours'`,
        [companyId],
      ).catch(() => ({ rows: [{ count: '0' }] }));
      const detailQueued = parseInt(detailQueuedRes.rows[0]?.count ?? '0', 10);

      // Final progress update — Phase 1 complete, Phase 2 starting in background
      const totalFetchedFinal = outputCount + inputCount;
      const totalEstFinal = (outEst >= 0 ? outEst : 0) + (inEst >= 0 ? inEst : 0);
      await job.updateProgress({
        percent: 100,
        invoicesFetched: totalFetchedFinal,
        totalInvoicesExpected: totalEstFinal > 0 ? totalEstFinal : totalFetchedFinal,
        outputCount,
        inputCount,
        detailQueued,
        statusMessage: `Đã tải ${totalFetchedFinal.toLocaleString('vi-VN')} hóa đơn (📤 ${outputCount.toLocaleString('vi-VN')} đầu ra, 📥 ${inputCount.toLocaleString('vi-VN')} đầu vào). Đang xử lý chi tiết ${detailQueued} HĐ trong nền...`,
      } as Record<string, unknown>);

      const durationMs = Date.now() - startedAt;
      await pool.query(
        `UPDATE gdt_bot_runs
         SET status = 'success', finished_at = NOW(), output_count = $1, input_count = $2,
             duration_ms = $3, invoices_skipped = $5
         WHERE id = $4`,
        [outputCount, inputCount, durationMs, runId, skippedCount]
      );
      // Reset consecutive_failures on success — unblocks the company automatically
      await pool.query(
        `UPDATE gdt_bot_configs
         SET last_run_at = NOW(), last_run_status = 'success',
             last_run_output_count = $1, last_run_input_count = $2, last_error = NULL,
             consecutive_failures = 0, blocked_until = NULL, updated_at = NOW()
         WHERE company_id = $3`,
        [outputCount, inputCount, companyId]
      );

      // ── Quota consumption ───────────────────────────────────────────────────────
      const totalSynced = outputCount + inputCount;
      // Charge only NEWLY inserted invoices — updates of existing invoices are free.
      // This prevents quota inflation from date-range overlaps that re-fetch known invoices.
      await _consumeQuota(companyId, newInvoiceCount);

      // ── Schedule next auto-sync with jitter (BOT-ENT-01) ────────────────────────
      // Tôn trọng sync_frequency_hours mà end-user đã cài đặt.
      // Jitter ±12–30 phút (random trong range này, sign ngẫu nhiên) để tránh
      // nhiều công ty hit GDT cùng lúc và mô phỏng hành vi con người.
      // Ví dụ: 1h → next = 30–90 phút | 6h → next = 5h30–6h30 | 24h → next = 23h30–24h30
      const freqHours = cfg.sync_frequency_hours > 0 ? cfg.sync_frequency_hours : 6;
      await pool.query(
        `UPDATE gdt_bot_configs
         SET next_auto_sync_at = NOW()
           + ($1 || ' hours')::INTERVAL
           + ((FLOOR(RANDOM() * 19) + 12)
              * (CASE WHEN RANDOM() < 0.5 THEN 1 ELSE -1 END)
              || ' minutes')::INTERVAL
         WHERE company_id = $2`,
        [freqHours, companyId],
      );

      logger.info('[SyncWorker] Done', { companyId, outputCount, inputCount, durationMs, detailQueued, note: 'Phase 2 detail fetch running in background via detail worker' });

      // ── Push notification via backend queue ─────────────────────────────────────
      if (totalSynced > 0) {
        try {
          await _notifQueue.add('sync-complete', {
            companyId,
            provider: 'GDT Bot',
            count: totalSynced,
            // Truyền khoảng thời gian để backend tự xác định quý cần recalc
            fromDate: jobFromDate,
            toDate: jobToDate,
          });
        } catch (notifErr) {
          logger.warn('[SyncWorker] Failed to enqueue notification (non-fatal)', { companyId, err: notifErr });
        }
      }

      // ── Sequential chaining: enqueue next job in the group ──────────────────────
      // Quarter sync: job 0 (Jan) → job 1 (Feb) → job 2 (Mar), each started after
      // the previous completes. This avoids LOCK_CONFLICT from parallel execution.
      const jobIndex = job.data.jobIndex ?? 0;
      const jobTotal = job.data.jobTotal ?? 1;
      if (job.data.allJobs && jobIndex + 1 < jobTotal) {
        const nextIndex = jobIndex + 1;
        const nextJobData = job.data.allJobs[nextIndex];
        if (nextJobData) {
          const nextJobId = `${job.data.groupId}-${nextIndex}`;
          // Random 3–7 min delay between months — human-like gap, avoids 15-min cooldown trigger.
          const chainDelayMs = (3 * 60_000) + Math.floor(Math.random() * (4 * 60_000));
          try {
            await _botSyncQueue.add('sync', {
              companyId,
              fromDate:  nextJobData.fromDate,
              toDate:    nextJobData.toDate,
              label:     nextJobData.label,
              groupId:   job.data.groupId,
              jobIndex:  nextIndex,
              jobTotal,
              allJobs:   job.data.allJobs,
              isChained: true,
            }, {
              jobId:    nextJobId,
              delay:    chainDelayMs, // 3–7 min random gap between months
              attempts: 6,
              backoff:  { type: 'exponential', delay: 60_000 },
              removeOnComplete: { count: 100 },
              removeOnFail:     { count: 50 },
            });
            logger.info('[SyncWorker] Chained next job in group', { nextJobId, nextIndex, jobTotal });
          } catch (chainErr) {
            logger.error('[SyncWorker] Failed to chain next job (non-fatal)', { companyId, err: chainErr });
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // COOLDOWN_SKIP / CANCEL_SKIP / YIELD_TO_MANUAL: not real failures — don't touch consecutive_failures.
      const isSkip = msg.startsWith('COOLDOWN_SKIP:') || msg.startsWith('CANCEL_SKIP:') || msg.startsWith('YIELD_TO_MANUAL:');
      // Infrastructure / DB errors (Postgres error code = 5-digit string like '42P10')
      // are bugs in our code or missing migrations — NOT GDT captcha/auth issues.
      // They must NOT increment consecutive_failures (which would trigger anti-bot blocking).
      const pgCode  = (err as Record<string, unknown>)['code'];
      const isInfra = typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode);
      if (isInfra) {
        logger.error('[SyncWorker] DB/infrastructure error — skipping consecutive_failures increment', {
          companyId, pgCode, msg,
        });
      }
      if (!isSkip && !isInfra) {
        await _failRun(runId, companyId, msg, false);
      } else if (isSkip) {
        const isCancelled = msg.startsWith('CANCEL_SKIP:');
        await pool.query(
          `UPDATE gdt_bot_runs
           SET status = $1,
               finished_at = NOW(),
               error_detail = $2
           WHERE id = $3`,
          [isCancelled ? 'cancelled' : 'skipped', msg.slice(0, 1000), runId],
        ).catch(() => undefined);
        if (isCancelled) {
          await pool.query(
            `UPDATE gdt_bot_configs
             SET last_run_status = 'cancelled',
                 last_error = NULL,
                 updated_at = NOW()
             WHERE company_id = $1`,
            [companyId],
          ).catch(() => undefined);
        }
      } else if (isInfra) {
        // Still update gdt_bot_runs status so the run is marked as error in the UI.
        await pool.query(
          `UPDATE gdt_bot_runs SET status = 'error', finished_at = NOW(), error_detail = $1 WHERE id = $2`,
          [msg.slice(0, 1000), runId]
        ).catch(() => {});
      }
      throw err;
    }
    } finally {
    clearInterval(lockHeartbeat);   // FIX-3: dừng heartbeat TRƯỚC khi giải phóng lock
    // Release both locks:
    // 1. Bot worker lock (bot:sync:lock:) — fenced release prevents cross-job unlock race
    // 2. HTTP route lock (sync:lock:) — prevents double-click from UI
    await releaseCompanyLock(companyId, lockToken);
    _activeLockTokens.delete(job.id ?? '');
    await _lockRedis.del(`sync:lock:${companyId}`);
  }
}

// ── FIX-5 Helpers ─────────────────────────────────────────────────────────────

/** Compute GROUP 47 serial classification — extracted from _upsertInvoice for reuse.
 *
 * TT78/2021 rule: invoiceType at position 4 (index 3) takes priority over C/K prefix.
 *   'M' → group 8 (máy tính tiền) — regardless of C or K prefix.
 *   'C' + non-M → group 5 (có mã CQT, hóa đơn thường)
 *   'K' + non-M → group 6 (không mã CQT)
 * C26MED = CQT-coded MTT → group 8, NOT group 5.
 */
function _classifySerial(serialNumber: string | null | undefined): {
  invoiceGroup: number | null;
  serialHasCqt: boolean | null;
  hasLineItems: boolean;
} {
  const serial = (serialNumber ?? '').toUpperCase().trim();
  if (serial.length < 4) return { invoiceGroup: null, serialHasCqt: null, hasLineItems: false };
  const firstChar = serial[0];
  if (firstChar !== 'C' && firstChar !== 'K') return { invoiceGroup: null, serialHasCqt: null, hasLineItems: false };
  const hasCqt = firstChar === 'C';
  // Position 4 (index 3) = invoice type. 'M' = máy tính tiền → always group 8.
  if (serial[3] === 'M') return { invoiceGroup: 8, serialHasCqt: hasCqt, hasLineItems: hasCqt };
  if (hasCqt)            return { invoiceGroup: 5, serialHasCqt: true,   hasLineItems: true  };
  return                        { invoiceGroup: 6, serialHasCqt: false,  hasLineItems: false };
}

/** Stable lookup key for the batch upsert return map. */
function _invMapKey(inv: import('./parsers/GdtXmlParser').RawInvoice): string {
  return `${inv.invoice_number ?? ''}|${inv.serial_number ?? ''}|${inv.seller_tax_code ?? ''}|${inv.invoice_date ?? ''}`;
}

/**
 * FIX-5: Batch upsert up to 50 invoices in a single round-trip via PostgreSQL UNNEST.
 * Replaces N×1 INSERT…ON CONFLICT calls (was the bottleneck for 100k+ invoice runs).
 * Returns a Map of _invMapKey(inv) → db UUID (needed for line-item fetching).
 */
async function _batchUpsertInvoices(
  invoices: import('./parsers/GdtXmlParser').RawInvoice[],
  companyId: string,
  direction: 'output' | 'input',
): Promise<{ map: Map<string, string>; newCount: number }> {
  if (invoices.length === 0) return { map: new Map(), newCount: 0 };

  const ids:            string[]           = [];
  const invNums:        (string | null)[]  = [];
  const serials:        (string | null)[]  = [];
  const dates:          (string | null)[]  = [];
  const statuses:       string[]           = [];
  const sellerNames:    (string | null)[]  = [];
  const sellerTaxes:    string[]           = [];
  const buyerNames:     (string | null)[]  = [];
  const buyerTaxes:     (string | null)[]  = [];
  const subtotals:      number[]           = [];
  const totals:         (number | null)[]  = [];
  const vatAmounts:     (number | null)[]  = [];
  const vatRates:       (string | null)[]  = [];
  const taxCategories:  (string | null)[]  = [];
  const invoiceGroups:  (number | null)[]  = [];
  const serialHasCqts:  (boolean | null)[] = [];
  const hasLineItemsArr: boolean[]         = [];
  const isScos:         boolean[]          = [];
  const tcHdons:        (number | null)[]  = [];
  const khhdClQuans:    (string | null)[]  = [];
  const soHdClQuans:    (string | null)[]  = [];
  const originalInvDates: (string | null)[] = [];

  for (const inv of invoices) {
    const { invoiceGroup, serialHasCqt, hasLineItems } = _classifySerial(inv.serial_number);
    ids.push(uuidv4());
    invNums.push(inv.invoice_number ?? null);
    serials.push(inv.serial_number ?? null);
    dates.push(inv.invoice_date ?? null);
    // Keep GDT's own status for the invoice itself. tc_hdon indicates the TYPE (replacement/
    // adjustment), not the invoice's validity. The ORIGINAL invoice's status ('replaced_original',
    // 'adjusted') comes from GDT's ttxly mapping in gdt-config.ts statusMap.
    statuses.push(inv.status ?? 'valid');
    sellerNames.push(inv.seller_name ?? null);
    sellerTaxes.push(inv.seller_tax_code ?? '');
    buyerNames.push(inv.buyer_name ?? null);
    buyerTaxes.push(inv.buyer_tax_code ?? null);
    subtotals.push((inv.total_amount ?? 0) - (inv.vat_amount ?? 0));
    totals.push(inv.total_amount ?? null);
    vatAmounts.push(inv.vat_amount ?? null);
    vatRates.push(inv.vat_rate ?? null);
    taxCategories.push(inv.tax_category ?? null);
    invoiceGroups.push(invoiceGroup);
    serialHasCqts.push(serialHasCqt);
    hasLineItemsArr.push(hasLineItems);
    // Derive is_sco from serial classification if group is 8 (MTT), even when fetched
    // via /query endpoint (e.g. C26MED has C-prefix but is an SCO/MTT invoice).
    isScos.push((inv.is_sco ?? false) || invoiceGroup === 8);
    tcHdons.push(inv.tc_hdon ?? null);
    khhdClQuans.push(inv.khhd_cl_quan ?? null);
    soHdClQuans.push(inv.so_hd_cl_quan ?? null);
    originalInvDates.push(inv.original_invoice_date ?? null);
  }

  const dirArr  = Array(invoices.length).fill(direction) as string[];
  const compArr = Array(invoices.length).fill(companyId) as string[];

  const insertPrefixSql =
    `INSERT INTO invoices
     (id, company_id, invoice_number, serial_number, invoice_date, direction, status,
      seller_name, seller_tax_code, buyer_name, buyer_tax_code,
      subtotal, total_amount, vat_amount, vat_rate, tax_category, gdt_validated, source, provider,
      invoice_group, serial_has_cqt, has_line_items, is_sco,
      tc_hdon, khhd_cl_quan, so_hd_cl_quan, original_invoice_date,
      invoice_relation_type, related_invoice_number, created_at)
     SELECT
       t.id, t.company_id, t.invoice_number, t.serial_number,
       COALESCE(t.invoice_date::date, CURRENT_DATE), t.direction, t.status,
       t.seller_name, COALESCE(t.seller_tax_code, ''), t.buyer_name, t.buyer_tax_code,
       t.subtotal, t.total_amount, t.vat_amount, t.vat_rate, t.tax_category,
       true, 'gdt_bot', 'gdt_bot',
       t.invoice_group, t.serial_has_cqt, t.has_line_items, t.is_sco,
       t.tc_hdon, t.khhd_cl_quan, t.so_hd_cl_quan, t.original_invoice_date,
       CASE WHEN t.tc_hdon = 1 THEN 'replacement'
            WHEN t.tc_hdon = 2 THEN 'adjustment'
            ELSE NULL END,
       CASE WHEN t.tc_hdon IN (1,2) THEN t.so_hd_cl_quan ELSE NULL END,
       NOW()
     FROM UNNEST(
       $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::invoice_direction[], $7::invoice_status[],
       $8::text[], $9::text[], $10::text[], $11::text[],
       $12::numeric[], $13::numeric[], $14::numeric[], $15::numeric[], $16::text[],
       $17::int[], $18::boolean[], $19::boolean[], $20::boolean[],
       $21::smallint[], $22::text[], $23::text[], $24::date[]
     ) AS t(
       id, company_id, invoice_number, serial_number, invoice_date, direction, status,
       seller_name, seller_tax_code, buyer_name, buyer_tax_code,
       subtotal, total_amount, vat_amount, vat_rate, tax_category,
       invoice_group, serial_has_cqt, has_line_items, is_sco,
       tc_hdon, khhd_cl_quan, so_hd_cl_quan, original_invoice_date
     )`;

  const updateAndReturnSql =
    ` DO UPDATE SET
       direction             = EXCLUDED.direction,
       status                = EXCLUDED.status,
       invoice_date          = EXCLUDED.invoice_date,
       serial_number         = COALESCE(EXCLUDED.serial_number, invoices.serial_number),
       seller_name           = EXCLUDED.seller_name,
       buyer_name            = EXCLUDED.buyer_name,
       buyer_tax_code        = EXCLUDED.buyer_tax_code,
       subtotal              = EXCLUDED.subtotal,
       total_amount          = EXCLUDED.total_amount,
       vat_amount            = EXCLUDED.vat_amount,
       vat_rate              = EXCLUDED.vat_rate,
       tax_category          = COALESCE(EXCLUDED.tax_category, invoices.tax_category),
       gdt_validated         = true,
       invoice_group         = COALESCE(EXCLUDED.invoice_group,  invoices.invoice_group),
       serial_has_cqt        = COALESCE(EXCLUDED.serial_has_cqt, invoices.serial_has_cqt),
       has_line_items        = COALESCE(EXCLUDED.has_line_items, invoices.has_line_items),
       is_sco                = EXCLUDED.is_sco,
       tc_hdon               = COALESCE(EXCLUDED.tc_hdon,        invoices.tc_hdon),
       khhd_cl_quan          = COALESCE(EXCLUDED.khhd_cl_quan,   invoices.khhd_cl_quan),
       so_hd_cl_quan         = COALESCE(EXCLUDED.so_hd_cl_quan,  invoices.so_hd_cl_quan),
       original_invoice_date = COALESCE(EXCLUDED.original_invoice_date, invoices.original_invoice_date),
       invoice_relation_type = COALESCE(EXCLUDED.invoice_relation_type, invoices.invoice_relation_type),
       related_invoice_number = COALESCE(EXCLUDED.related_invoice_number, invoices.related_invoice_number),
       updated_at            = NOW()
     RETURNING id,
       invoice_number,
       COALESCE(serial_number,    '') AS serial_number,
       COALESCE(seller_tax_code,  '') AS seller_tax_code,
       COALESCE(invoice_date::text, '') AS invoice_date,
       (xmax = 0) AS is_new`;

  const values = [
    ids, compArr, invNums, serials, dates, dirArr, statuses,
    sellerNames, sellerTaxes, buyerNames, buyerTaxes,
    subtotals, totals, vatAmounts, vatRates, taxCategories,
    invoiceGroups, serialHasCqts, hasLineItemsArr, isScos,
    tcHdons, khhdClQuans, soHdClQuans, originalInvDates,
  ];

  const conflictTargets = [
    {
      name: 'coalesce_seller_date',
      sql: ` ON CONFLICT (company_id, provider, invoice_number, COALESCE(seller_tax_code, ''), invoice_date)`,
    },
    {
      name: 'plain_seller_date',
      sql: ` ON CONFLICT (company_id, provider, invoice_number, seller_tax_code, invoice_date)`,
    },
    {
      name: 'coalesce_seller_serial',
      sql: ` ON CONFLICT (company_id, provider, invoice_number, COALESCE(seller_tax_code, ''), COALESCE(serial_number, ''))`,
    },
    {
      name: 'plain_seller_serial',
      sql: ` ON CONFLICT (company_id, provider, invoice_number, seller_tax_code, serial_number)`,
    },
  ] as const;

  let res: { rows: unknown[] } | null = null;
  let last42P10: unknown = null;
  for (const target of conflictTargets) {
    try {
      res = await pool.query(`${insertPrefixSql}${target.sql}${updateAndReturnSql}`, values);
      if (target.name !== 'coalesce_seller_date') {
        logger.warn('[SyncWorker] Using compatibility conflict target for invoices upsert', {
          companyId,
          conflictTarget: target.name,
        });
      }
      break;
    } catch (err) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode !== '42P10') throw err;
      last42P10 = err;
    }
  }
  if (!res) {
    throw last42P10 instanceof Error
      ? last42P10
      : new Error('No compatible unique/exclusion constraint found for invoices upsert');
  }

  const resultMap = new Map<string, string>();
  let newCount = 0;
  for (const row of res.rows as Array<{
    id: string;
    invoice_number: string;
    serial_number: string;
    seller_tax_code: string;
    invoice_date: string;
    is_new: boolean;
  }>) {
    resultMap.set(
      `${row.invoice_number}|${row.serial_number}|${row.seller_tax_code}|${row.invoice_date}`,
      row.id,
    );
    if (row.is_new) newCount++;
  }

  // Mark original invoices as replaced/adjusted for any replacement/adjustment invoices in this batch.
  // Uses UNNEST for a single UPDATE round-trip instead of N queries.
  const replacements = invoices.filter(
    inv => (inv.tc_hdon === 1 || inv.tc_hdon === 2) && inv.khhd_cl_quan && inv.so_hd_cl_quan
  );
  if (replacements.length > 0) {
    const newStatuses:  string[]           = [];
    const cids:         string[]           = [];
    const khhdArr:      string[]           = [];
    const soHdArr:      string[]           = [];
    for (const inv of replacements) {
      // Mark the ORIGINAL invoice as 'replaced_original' (not 'replaced' — that belongs to the new invoice)
      newStatuses.push(inv.tc_hdon === 1 ? 'replaced_original' : 'adjusted');
      cids.push(companyId);
      khhdArr.push(inv.khhd_cl_quan!);
      soHdArr.push(inv.so_hd_cl_quan!);
    }
    await pool.query(
      `UPDATE invoices
       SET status = t.new_status, updated_at = NOW()
       FROM UNNEST($1::invoice_status[], $2::uuid[], $3::text[], $4::text[]) AS t(new_status, cid, khhd, so_hd)
       WHERE invoices.company_id    = t.cid
         AND invoices.serial_number = t.khhd
         AND invoices.invoice_number = t.so_hd
         AND invoices.status NOT IN ('cancelled', 'replaced_original')`,
      [newStatuses, cids, khhdArr, soHdArr]
    ).catch(err => logger.warn('[SyncWorker] mark-original batch failed', { err }));
  }

  return { map: resultMap, newCount };
}

/** Upsert invoice header. Returns the actual DB row UUID (via RETURNING id). */
async function _upsertInvoice(
  inv: import('./parsers/GdtXmlParser').RawInvoice,
  companyId: string,
  direction: 'output' | 'input'
): Promise<string> {
  // subtotal (chưa VAT) = total - vat. GDT portal list API does not expose pre-tax amount
  // so we derive it here. For KCT/zero-VAT invoices this equals total_amount.
  const computedSubtotal = ((inv.total_amount ?? 0) - (inv.vat_amount ?? 0));

  // GROUP 47: Classify invoice by serial number (TT78/2021)
  const serial = (inv.serial_number ?? '').toUpperCase().trim();
  let invoiceGroup: number | null = null;
  let serialHasCqt: boolean | null = null;
  let hasLineItems = false;
  if (serial.length >= 4) {
    const firstChar = serial[0];
    serialHasCqt = firstChar === 'C';
    if (firstChar === 'C') {
      invoiceGroup = 5;
      hasLineItems = true;
    } else if (firstChar === 'K') {
      invoiceGroup = serial[3] === 'M' ? 8 : 6;
      hasLineItems = false;
    }
  }

  const res = await pool.query(
    `INSERT INTO invoices
     (id, company_id, invoice_number, serial_number, invoice_date, direction, status,
      seller_name, seller_tax_code, buyer_name, buyer_tax_code,
      subtotal, total_amount, vat_amount, vat_rate, gdt_validated, source, provider,
      invoice_group, serial_has_cqt, has_line_items, is_sco,
      tc_hdon, khhd_cl_quan, so_hd_cl_quan, created_at)
     VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8,COALESCE($9,''),$10,$11,$12,$13,$14,$15,true,'gdt_bot','gdt_bot',
      $16,$17,$18,$19,$20,$21,$22,NOW())
     ON CONFLICT (company_id, provider, invoice_number, COALESCE(seller_tax_code, ''), COALESCE(serial_number, '')) DO UPDATE SET
       direction       = EXCLUDED.direction,
       status          = EXCLUDED.status,
       invoice_date    = EXCLUDED.invoice_date,
       serial_number   = COALESCE(EXCLUDED.serial_number, invoices.serial_number),
       seller_name     = EXCLUDED.seller_name,
       buyer_name      = EXCLUDED.buyer_name,
       buyer_tax_code  = EXCLUDED.buyer_tax_code,
       subtotal        = EXCLUDED.subtotal,
       total_amount    = EXCLUDED.total_amount,
       vat_amount      = EXCLUDED.vat_amount,
       vat_rate        = EXCLUDED.vat_rate,
       gdt_validated   = true,
       invoice_group   = COALESCE(EXCLUDED.invoice_group, invoices.invoice_group),
       serial_has_cqt  = COALESCE(EXCLUDED.serial_has_cqt, invoices.serial_has_cqt),
       has_line_items  = COALESCE(EXCLUDED.has_line_items, invoices.has_line_items),
       is_sco          = EXCLUDED.is_sco,
       tc_hdon         = COALESCE(EXCLUDED.tc_hdon,       invoices.tc_hdon),
       khhd_cl_quan    = COALESCE(EXCLUDED.khhd_cl_quan,  invoices.khhd_cl_quan),
       so_hd_cl_quan   = COALESCE(EXCLUDED.so_hd_cl_quan, invoices.so_hd_cl_quan),
       updated_at      = NOW()
     RETURNING id`,
    [
      uuidv4(), companyId,
      inv.invoice_number, inv.serial_number ?? null,
      inv.invoice_date, direction,
      inv.status ?? 'valid',
      inv.seller_name, inv.seller_tax_code,
      inv.buyer_name, inv.buyer_tax_code,
      computedSubtotal, inv.total_amount, inv.vat_amount, inv.vat_rate,
      invoiceGroup, serialHasCqt, hasLineItems, inv.is_sco,
      inv.tc_hdon ?? null, inv.khhd_cl_quan ?? null, inv.so_hd_cl_quan ?? null,
    ]
  );
  const invoiceDbId = res.rows[0].id as string;

  // Mark original invoice as replaced/adjusted when this one references it
  // tc_hdon=1 (replacement): original becomes 'replaced_original' (NOT 'replaced' — that is the new invoice)
  // tc_hdon=2 (adjustment): original becomes 'adjusted'
  if ((inv.tc_hdon === 1 || inv.tc_hdon === 2) && inv.khhd_cl_quan && inv.so_hd_cl_quan) {
    const newStatus = inv.tc_hdon === 1 ? 'replaced_original' : 'adjusted';
    await pool.query(
      `UPDATE invoices SET status = $1, updated_at = NOW()
       WHERE company_id    = $2
         AND serial_number  = $3
         AND invoice_number = $4
         AND status NOT IN ('cancelled', 'replaced_original')`,
      [newStatus, companyId, inv.khhd_cl_quan, inv.so_hd_cl_quan]
    ).catch(err => logger.warn('[SyncWorker] mark-original single failed', { err }));
  }

  return invoiceDbId;
}

/**
 * BOT-REFACTOR-03: Enqueue an invoice into invoice_detail_queue for Phase 2 detail fetch.
 *
 * ALL serial types (C and K) are enqueued — both have /detail JSON API (HTTP 200).
 *   C-series (ttxly=5): detail + XML available
 *   K-series (ttxly=6/8): detail JSON only (no XML file)
 *
 * is_sco determines the endpoint used in Phase 2:
 *   true  → /sco-query/invoices/detail (MTTTT/SCO invoices)
 *   false → /query/invoices/detail     (HĐĐT + K-series)
 *
 * ON CONFLICT(invoice_id): idempotent — safe to call multiple times.
 * Non-fatal: never throws, never blocks the list sync.
 */
async function _enqueueForDetail(
  inv:       import('./parsers/GdtXmlParser').RawInvoice,
  invoiceId: string,
  companyId: string,
  priority:  1 | 5 | 10 = 5,
): Promise<void> {
  // Need all 3 params to call GDT detail API
  if (!inv.invoice_number || !inv.serial_number || !inv.seller_tax_code) return;

  try {
    await pool.query(
      `INSERT INTO invoice_detail_queue
         (invoice_id, company_id, nbmst, khhdon, shdon, is_sco, status, priority, enqueued_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())
       ON CONFLICT (invoice_id) DO UPDATE
         SET
           -- Keep done/skipped as-is; reset others to pending so detail is retried
           status   = CASE
             WHEN invoice_detail_queue.status IN ('done','skipped')
             THEN invoice_detail_queue.status
             ELSE 'pending'
           END,
           -- Lower priority number (higher urgency) wins
           priority = LEAST(invoice_detail_queue.priority, EXCLUDED.priority)`,
      [
        invoiceId,
        companyId,
        inv.seller_tax_code,   // nbmst
        inv.serial_number,     // khhdon (C26TAS, K26TAX, C26MTK, ...)
        inv.invoice_number,    // shdon
        inv.is_sco ?? false,   // true = MTTTT/SCO, false = HĐĐT or K-series
        priority,
      ],
    );
  } catch (err) {
    // Non-fatal: queue failure must not block list sync
    logger.warn('[SyncWorker] _enqueueForDetail failed (non-fatal)', {
      invoiceId, serial: inv.serial_number,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fetch XML for a single invoice and insert line items if not yet stored.
 * Returns 1 if an XML fetch was made, 0 otherwise (already have items / no params).
 * Never throws — failures are logged and swallowed so the main sync continues.
 */
async function _maybeInsertLineItems(
  gdtApi: GdtDirectApiService,
  inv: import('./parsers/GdtXmlParser').RawInvoice,
  invoiceId: string,
  companyId: string,
): Promise<number> {
  // Need invoice_number + serial_number + seller_tax_code to call detail API
  if (!inv.invoice_number || !inv.serial_number || !inv.seller_tax_code) {
    logger.info('[SyncWorker] Detail skip — missing params', {
      invoiceId,
      invoice_number:  inv.invoice_number,
      serial_number:   inv.serial_number,
      seller_tax_code: inv.seller_tax_code,
    });
    return 0;
  }

  // Check if line items already exist AND whether payment_method still needs to be fetched
  const existing = await pool.query(
    `SELECT
       (SELECT 1 FROM invoice_line_items WHERE invoice_id = $1 LIMIT 1) AS has_items,
       (SELECT payment_method FROM invoices WHERE id = $1)              AS payment_method`,
    [invoiceId],
  );
  const hasLineItems     = existing.rows[0]?.has_items === 1;
  const needsPaymentMethod = !existing.rows[0]?.payment_method;

  // Skip entirely if line items exist AND payment_method is already set
  if (hasLineItems && !needsPaymentMethod) return 0;

  // Rate-limit: small delay before detail fetch
  await thinkTime(2500, 4500);

  // Detail API (JSON) — only strategy (XML fallback removed to reduce GDT load)
  try {
    // BOT-CACHE-01: Check Redis detail cache before hitting GDT API
    let detail: Awaited<ReturnType<typeof gdtApi.fetchInvoiceDetail>>;
    const cachedDetail = await _detailCache.get(
      inv.seller_tax_code, inv.serial_number, inv.invoice_number,
    );
    if (cachedDetail) {
      detail = cachedDetail as Awaited<ReturnType<typeof gdtApi.fetchInvoiceDetail>>;
      logger.info('[SyncWorker] Detail cache HIT — skipping GDT call', { invoiceId });
    } else {
      detail = await gdtApi.fetchInvoiceDetail({
        nbmst:    inv.seller_tax_code,
        khhdon:   inv.serial_number,
        shdon:    inv.invoice_number,
        khmshdon: 1,
        isSco:    inv.is_sco,
      });
      // Populate cache for future hits (non-fatal internally)
      await _detailCache.set(
        inv.seller_tax_code, inv.serial_number, inv.invoice_number,
        detail as Record<string, unknown>,
      );
    }
    const lineItems = GdtDirectApiService.parseLineItemsFromDetail(detail);
    if (lineItems.length > 0 && !hasLineItems) {
      // Only insert line items if they don't already exist
      await _bulkInsertLineItems(lineItems, invoiceId, companyId);
      logger.info('[SyncWorker] Line items inserted (detail API)', { invoiceId, count: lineItems.length });
    } else if (lineItems.length === 0 && !hasLineItems) {
      // Detail returned 200 but hdhhdvu empty — invoice may have no line items (e.g. summary invoice)
      logger.info('[SyncWorker] Detail API: no line items in hdhhdvu', { invoiceId });
    }

    // ── Save raw detail + all extended header fields ──────────────────────────
    // Non-fatal: if new columns don't exist yet (migration pending), log and continue.
    try {
      const d = detail as Record<string, unknown>;
      const paymentMethod = typeof detail.thtttoan === 'string' && detail.thtttoan.trim()
        ? detail.thtttoan.trim() : null;
      await pool.query(
        `UPDATE invoices SET
           raw_detail          = $1::jsonb,
           raw_detail_at       = NOW(),
           gdt_invoice_id      = $2,
           gdt_mhdon           = $3,
           gdt_mtdtchieu       = $4,
           gdt_khmshdon        = $5,
           gdt_hdon            = $6,
           gdt_hthdon          = $7,
           gdt_htttoan         = $8,
           gdt_dvtte           = $9,
           gdt_tgia            = $10,
           gdt_nky             = $11,
           gdt_ttxly           = $12,
           gdt_cqt             = $13,
           gdt_tvandnkntt      = $14,
           gdt_pban            = $15,
           gdt_thlap           = $16,
           gdt_thdon           = $17,
           seller_address      = $18,
           seller_bank_account = $19,
           seller_bank_name    = $20,
           seller_email        = $21,
           seller_phone        = $22,
           buyer_address       = $23,
           buyer_bank_account  = $24,
           gdt_ttcktmai        = $25,
           gdt_tgtphi          = $26,
           gdt_qrcode          = $27,
           gdt_gchu            = $28,
           gdt_nbcks           = $29,
           gdt_cqtcks          = $30,
           payment_method      = CASE
             WHEN (payment_method IS NULL OR payment_method_source NOT IN ('manual','gdt_data'))
             THEN $31 ELSE payment_method END,
           payment_method_source = CASE
             WHEN (payment_method IS NULL OR payment_method_source NOT IN ('manual','gdt_data'))
               AND $31 IS NOT NULL
             THEN 'gdt_detail' ELSE payment_method_source END
         WHERE id = $32`,
        [
          JSON.stringify(detail),                           // $1  raw_detail
          d['id']          as string ?? null,               // $2  gdt_invoice_id
          d['mhdon']       as string ?? null,               // $3  gdt_mhdon
          d['mtdtchieu']   as string ?? null,               // $4  gdt_mtdtchieu
          d['khmshdon']    as number ?? null,               // $5  gdt_khmshdon
          d['hdon']        as string ?? null,               // $6  gdt_hdon
          d['hthdon']      as number ?? null,               // $7  gdt_hthdon
          d['htttoan']     as number ?? null,               // $8  gdt_htttoan
          d['dvtte']       as string ?? null,               // $9  gdt_dvtte
          d['tgia']        as number ?? null,               // $10 gdt_tgia
          d['nky']         as string ?? null,               // $11 gdt_nky
          d['ttxly']       as number ?? null,               // $12 gdt_ttxly
          d['cqt']         as string ?? null,               // $13 gdt_cqt
          d['tvandnkntt']  as string ?? null,               // $14 gdt_tvandnkntt
          d['pban']        as string ?? null,               // $15 gdt_pban
          d['thlap']       as number ?? null,               // $16 gdt_thlap
          d['thdon']       as string ?? null,               // $17 gdt_thdon
          d['nbdchi']      as string ?? null,               // $18 seller_address
          d['nbstkhoan']   as string ?? null,               // $19 seller_bank_account
          d['nbtnhang']    as string ?? null,               // $20 seller_bank_name
          d['nbdctdtu']    as string ?? null,               // $21 seller_email
          d['nbsdthoai']   as string ?? null,               // $22 seller_phone
          d['nmdchi']      as string ?? null,               // $23 buyer_address
          d['nmstkhoan']   as string ?? null,               // $24 buyer_bank_account
          d['ttcktmai']    as number ?? null,               // $25 gdt_ttcktmai
          d['tgtphi']      as number ?? null,               // $26 gdt_tgtphi
          d['qrcode']      as string ?? null,               // $27 gdt_qrcode
          d['gchu']        as string ?? null,               // $28 gdt_gchu
          typeof d['nbcks']  === 'object'
            ? JSON.stringify(d['nbcks'])  : d['nbcks']  as string ?? null, // $29 gdt_nbcks
          typeof d['cqtcks'] === 'object'
            ? JSON.stringify(d['cqtcks']) : d['cqtcks'] as string ?? null, // $30 gdt_cqtcks
          paymentMethod,                                    // $31 payment_method
          invoiceId,                                        // $32 WHERE id
        ],
      );
      logger.info('[SyncWorker] Raw detail + header fields saved', { invoiceId });
    } catch (saveErr: unknown) {
      // Column may not exist yet if migration is pending — non-fatal, sync continues.
      logger.warn('[SyncWorker] raw_detail save failed (non-fatal — run migration 038)', {
        invoiceId,
        err: saveErr instanceof Error ? saveErr.message : String(saveErr),
      });
    }

    return 1;
  } catch (detailErr: unknown) {
    const msg = detailErr instanceof Error ? detailErr.message : String(detailErr);
    // 401 = token expired, propagate
    if (msg.includes('token expired')) throw detailErr;
    logger.warn('[SyncWorker] Detail API failed (non-fatal, skipping line items)', { invoiceId, isSco: inv.is_sco, msg });
  }
  return 1;
}

/** Bulk-insert line items for one invoice (delete stale rows first). */
async function _bulkInsertLineItems(
  lineItems: LineItem[],
  invoiceId: string,
  companyId: string,
): Promise<void> {
  await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  const values19 = lineItems.map((_, i) => {
    const b = i * 19;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},$${b+15},$${b+16},$${b+17},$${b+18},$${b+19})`;
  }).join(',');
  const params: unknown[] = [];
  for (const item of lineItems) {
    params.push(
      uuidv4(), invoiceId, companyId,
      item.line_number, item.item_code, item.item_name,
      item.unit, item.quantity, item.unit_price,
      item.subtotal, item.vat_rate, item.vat_amount, item.total,
      // New fields (migration 039)
      item.discount_amount  ?? null,
      item.discount_rate    ?? null,
      item.line_type        ?? null,
      item.vat_rate_label   ?? null,
      item.gdt_line_id      ?? null,
      item.gdt_invoice_id   ?? null,
    );
  }
  await pool.query(
    `INSERT INTO invoice_line_items
     (id, invoice_id, company_id, line_number, item_code, item_name,
      unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total,
      discount_amount, discount_rate, line_type, vat_rate_label, gdt_line_id, gdt_invoice_id)
     VALUES ${values19}`,
    params,
  );
  // Fix: update has_line_items after successfully inserting line items
  await pool.query(
    `UPDATE invoices SET has_line_items = true WHERE id = $1 AND has_line_items = false`,
    [invoiceId],
  );
}

/**
 * skipCooldownUpdate = true  →  don't update last_run_at.
 * Use this for network/TLS/proxy errors where GDT never received a login request.
 * The 15-minute cooldown is designed to prevent hammering GDT with logins,
 * so it should not activate when the connection never reached GDT at all.
 */
async function _failRun(
  runId: string,
  companyId: string,
  errorMsg: string,
  deactivate: boolean,
  skipCooldownUpdate = false
): Promise<void> {
  await pool.query(
    `UPDATE gdt_bot_runs
     SET status = 'error', finished_at = NOW(), error_detail = $1
     WHERE id = $2`,
    [errorMsg.slice(0, 1000), runId]
  );

  if (deactivate) {
    // Wrong credentials / decrypt failure → deactivate permanently, don't count failures
    await pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_status = 'error', last_run_at = NOW(),
           last_error = $1, is_active = false, updated_at = NOW()
       WHERE company_id = $2`,
      [errorMsg.slice(0, 500), companyId]
    );
    // Push to DLQ for manual triage
    await _dlqQueue.add('failed-job', {
      companyId,
      runId,
      errorMsg,
      errorType: 'credential_failure',
      failedAt:  new Date().toISOString(),
    }).catch(e => logger.warn('[SyncWorker] DLQ push failed (non-fatal)', { e }));
    return;
  }

  // Transient failure (proxy fail, GDT block, network error, wrong captcha exhausted).
  // ① Increment consecutive_failures
  // ② Clear proxy_session_id → next run picks a fresh IP for this company
  // ③ Auto-block thresholds (stops captcha waste):
  //    3 failures → block 2h  (likely IP/GDT rate-limit)
  //    6 failures → block 24h (persistent issue, needs manual check)
  // ④ skipCooldownUpdate=true → keep last_run_at unchanged (proxy/TLS error, GDT not reached)
  const res = await pool.query(
    `UPDATE gdt_bot_configs
     SET last_run_status    = 'error',
         last_run_at        = CASE WHEN $2 THEN last_run_at ELSE NOW() END,
         last_error         = $1,
         consecutive_failures = consecutive_failures + 1,
         proxy_session_id   = NULL,
         blocked_until      = CASE
           WHEN consecutive_failures + 1 >= 6 THEN NOW() + INTERVAL '24 hours'
           WHEN consecutive_failures + 1 >= 3 THEN NOW() + INTERVAL '2 hours'
           ELSE blocked_until
         END,
         updated_at         = NOW()
     WHERE company_id = $3
     RETURNING consecutive_failures, blocked_until`,
    [errorMsg.slice(0, 500), skipCooldownUpdate, companyId]
  );

  const row = res.rows[0] as { consecutive_failures: number; blocked_until: string | null } | undefined;
  if (row && row.consecutive_failures >= 3) {
    logger.warn('[SyncWorker] Auto-blocked after consecutive failures — captcha paused', {
      companyId,
      consecutive_failures: row.consecutive_failures,
      blocked_until: row.blocked_until,
    });
  }
}

// ── BOT-ENT-03: Global Circuit Breaker handler ───────────────────────────────
/**
 * Called from both manualWorker and autoWorker `failed` events.
 * - GdtStructuralError: increments global circuit breaker counter; trips (pauses all workers)
 *   at threshold. Does NOT update company consecutive_failures.
 * - Regular errors: update company consecutive_failures via _failRun (already done in processGdtSync).
 */
async function handleJobFailure(job: Job<SyncJobData> | undefined, error: Error): Promise<void> {
  if (!(error instanceof GdtStructuralError)) return; // regular errors handled inside processGdtSync

  const count = await _lockRedis.incr(CIRCUIT_BREAKER_ERRORS_KEY);
  await _lockRedis.expire(CIRCUIT_BREAKER_ERRORS_KEY, CIRCUIT_BREAKER_TTL_SEC);

  logger.error(
    `[CircuitBreaker] GdtStructuralError count: ${count}/${CIRCUIT_BREAKER_TRIP_COUNT}`,
    { error: error.message, selector: error.selector, jobId: job?.id },
  );

  if (count >= CIRCUIT_BREAKER_TRIP_COUNT) {
    await manualWorker.pause();
    await autoWorker.pause();

    await _lockRedis.set(CIRCUIT_BREAKER_STATUS_KEY, JSON.stringify({
      tripped:    true,
      trippedAt:  new Date().toISOString(),
      errorCount: count,
      lastError:  error.message,
      selector:   error.selector ?? null,
    }));

    logger.error(
      '[CIRCUIT BREAKER TRIPPED] GDT system structure changed — ALL workers paused.',
      { errorCount: count, threshold: CIRCUIT_BREAKER_TRIP_COUNT },
    );

    // Notify via sync-notifications queue (backend picks up + sends push to admin)
    await _notifQueue.add('admin-alert', {
      level:   'CRITICAL',
      title:   'GDT Bot Circuit Breaker Tripped',
      message: `${count} lỗi cấu trúc trong 1 giờ. Tất cả worker đã tạm dừng. GDT có thể đã thay đổi cấu trúc trang. Cần kiểm tra thủ công.`,
      data:    { errorCount: count, selector: error.selector, jobId: job?.id },
    }).catch(() => undefined); // non-fatal
  }
}

// ── BOT-ENT-06: Metrics recorder ─────────────────────────────────────────────
/**
 * Records hourly bucket counters in Redis for the admin metrics dashboard.
 * Expires after 7 days. Entirely non-fatal — never throws.
 */
async function recordMetrics(
  job: Job<SyncJobData>,
  result: 'success' | 'failed',
  durationMs: number,
): Promise<void> {
  try {
    const hourKey = `bot:metrics:${new Date().toISOString().slice(0, 13)}`; // e.g. 2026-04-02T14
    const pipeline = _lockRedis.pipeline();

    pipeline.hincrby(hourKey, 'total',  1);
    pipeline.hincrby(hourKey, result,   1);
    pipeline.expire(hourKey, 7 * 24 * 3600);

    // Track duration (rolling last 100)
    pipeline.lpush('bot:metrics:durations', durationMs);
    pipeline.ltrim('bot:metrics:durations', 0, 99);

    // Captcha attempts from job returnvalue
    const rv = (job.returnvalue ?? {}) as Record<string, number>;
    if (rv['captchaAttempts']) {
      pipeline.hincrby(hourKey, 'captcha_attempts', rv['captchaAttempts']);
      pipeline.hincrby(hourKey, 'captcha_fails',    rv['captchaFails'] ?? 0);
    }

    await pipeline.exec();
  } catch (e) {
    logger.warn('[SyncWorker] recordMetrics failed (non-fatal)', { error: (e as Error).message });
  }
}

// ── Create and export worker ──────────────────────────────────────────────────
export const worker = new Worker<SyncJobData>(
  'gdt-bot-sync',
  processGdtSync,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: CONCURRENCY,
    limiter:     { max: 3, duration: 60_000 }, // max 3 jobs/min
  }
);

// ── Manual worker (concurrency 10 — user-triggered syncs) ────────────────────
// Wraps processGdtSync with a 25-minute hard timeout (leaves 5 min headroom under 30 min job limit).
// Previous 6-minute limit caused MANUAL_SYNC_TIMEOUT for companies with >60 invoices
// (each invoice takes ~4-9s for detail API + jitter → 285 invoices = ~20 min).
const MANUAL_SYNC_TIMEOUT_MS = 25 * 60_000; // 25 min

export const manualWorker = new Worker<SyncJobData>(
  'gdt-sync-manual',
  async (job) => {
    return await Promise.race([
      processGdtSync(job),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => {
            // Fenced release: only delete lock if OUR token matches the stored value.
            // Prevents cross-job unlock: if a new job already re-acquired the lock
            // while this background processGdtSync was still running, we don't delete
            // the new job's lock (Lua returns 0 silently when token doesn't match).
            const companyId = job.data.companyId;
            if (companyId) {
              const token = _activeLockTokens.get(job.id ?? '');
              if (token) {
                _lockRedis.eval(LOCK_RELEASE_LUA, 1, `${BOT_LOCK_PREFIX}${companyId}`, token).catch(() => {});
                _activeLockTokens.delete(job.id ?? '');
              } else {
                // Fallback: no token recorded yet (lock wasn't acquired before timeout)
                _lockRedis.del(`${BOT_LOCK_PREFIX}${companyId}`).catch(() => {});
              }
              // Invalidate cached GDT session token: the JWT used during the timed-out
              // run may be partially consumed / rate-limited by GDT, so next retry
              // must re-login fresh rather than reusing the stale token.
              _sessionCache.invalidateAllForCompany(companyId).catch(() => {});
            }
            reject(new Error('MANUAL_SYNC_TIMEOUT: Sync exceeded 25-minute limit — will retry'));
          },
          MANUAL_SYNC_TIMEOUT_MS,
        ),
      ),
    ]);
  },
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 10,
    limiter:     { max: 10, duration: 60_000 },
  }
);

manualWorker.on('completed', (job) => {
  const userId = job.data.triggeredByUserId;
  if (!userId) return;

  void promoteNextDelayedManualJobForUser(userId, String(job.id ?? ''));
});

manualWorker.on('failed', (job, err) => {
  if (!job?.data.triggeredByUserId) return;

  void (async () => {
    const state = await job.getState().catch(() => null);
    if (state !== 'failed') return;

    await promoteNextDelayedManualJobForUser(job.data.triggeredByUserId!, String(job.id ?? ''));
  })().catch((promoteErr) => {
    logger.warn('[SyncWorker] Failed to advance delayed manual queue after failure', {
      jobId: job.id,
      error: (promoteErr as Error).message,
      originalError: err.message,
    });
  });
});

// ── Auto worker (concurrency 5 — background scheduled syncs) ─────────────────
export const autoWorker = new Worker<SyncJobData>(
  'gdt-sync-auto',
  processGdtSync,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 5,
    limiter:     { max: 5, duration: 60_000 },
  }
);

worker.on('completed', (job) => {
  logger.info('[SyncWorker] Job completed', { jobId: job.id });
  const dur = (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now());
  void recordMetrics(job, 'success', dur);
  // Phase 5: Clear pending key so enqueueSync knows next job can be enqueued
  void _lockRedis.del(`${BOT_PENDING_PREFIX}${job.data.companyId}`).catch(() => {});
});

worker.on('failed', (job, err) => {
  logger.error('[SyncWorker] Job failed', { jobId: job?.id, error: err.message });
  if (job) void recordMetrics(job, 'failed', Date.now() - (job.processedOn ?? Date.now()));
  void handleJobFailure(job, err);
  // Phase 5: Clear pending key on failure so the next enqueue is not blocked
  if (job) void _lockRedis.del(`${BOT_PENDING_PREFIX}${job.data.companyId}`).catch(() => {});
});

worker.on('error', err => {
  logger.error('[SyncWorker] Worker error', { error: err.message });
});

for (const [name, w] of [['manualWorker', manualWorker], ['autoWorker', autoWorker]] as const) {
  w.on('completed', (job) => {
    logger.info(`[SyncWorker/${name}] Job completed`, { jobId: job.id });
    const dur = (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now());
    void recordMetrics(job, 'success', dur);
    // Phase 5: Clear pending key so enqueueSync knows the slot is free
    void _lockRedis.del(`${BOT_PENDING_PREFIX}${job.data.companyId}`).catch(() => {});
  });
  w.on('failed', (job, err) => {
    logger.error(`[SyncWorker/${name}] Job failed`, { jobId: job?.id, error: err.message });
    if (job) void recordMetrics(job, 'failed', Date.now() - (job.processedOn ?? Date.now()));
    void handleJobFailure(job, err);
    // Phase 5: Clear pending key on failure
    if (job) void _lockRedis.del(`${BOT_PENDING_PREFIX}${job.data.companyId}`).catch(() => {});
  });
  w.on('error', err => logger.error(`[SyncWorker/${name}] Worker error`, { error: err.message }));
}
