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
import { GdtXmlParser } from './parsers/GdtXmlParser';
import { logger } from './logger';
import type { LineItem } from './parsers/GdtXmlParser';

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
const _botSyncQueue = new Queue('gdt-bot-sync', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

// ── Manual/Auto split queues (BOT-ENT-01) ────────────────────────────────────
export const manualQueue = new Queue('gdt-sync-manual', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
  defaultJobOptions: {
    attempts:          5,
    backoff:           { type: 'exponential', delay: 60_000 },
    removeOnComplete:  200,
    removeOnFail:      100,
  },
});
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
const JITTER_MIN   = 3500;
const JITTER_MAX   = 6500;
// Longer "read pause" — simulates user stopping to examine an invoice
const READ_PAUSE_EVERY_MIN = 25;
const READ_PAUSE_EVERY_MAX = 40;
const READ_PAUSE_MIN = 10_000;
const READ_PAUSE_MAX = 30_000;

const FREE_TIER_MONTHLY_QUOTA = 100;

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
const BOT_LOCK_PREFIX   = 'bot:sync:lock:';
const BOT_LOCK_TTL      = 45 * 60; // 45 min — upper bound for any single sync run
const BOT_CANCEL_PREFIX = 'bot:sync:cancel:';

async function acquireCompanyLock(companyId: string): Promise<boolean> {
  const result = await _lockRedis.set(`${BOT_LOCK_PREFIX}${companyId}`, Date.now().toString(), 'EX', BOT_LOCK_TTL, 'NX');
  return result === 'OK';
}
async function releaseCompanyLock(companyId: string): Promise<void> {
  await _lockRedis.del(`${BOT_LOCK_PREFIX}${companyId}`);
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
  fromDate?: string; // YYYY-MM-DD, optional — job-specific override
  toDate?:   string; // YYYY-MM-DD, optional
  label?:    string; // display label (e.g. 'Tháng 1')
  // Sequential chaining fields (quarter sync)
  groupId?:  string;
  jobIndex?: number; // 0-based index in the group
  jobTotal?: number; // total jobs in the group
  allJobs?:  SyncJobGroupItem[]; // all jobs, so each job can enqueue the next
}

const xmlParser = new GdtXmlParser();

// Max XML (line items) fetches per sync run — keeps runs bounded in time
const MAX_XML_FETCHES_PER_RUN = 50;
// Delay between consecutive XML fetches to respect GDT rate limit (~1 req/3s)
const XML_FETCH_DELAY_MIN = 2500;
const XML_FETCH_DELAY_MAX = 4500;

async function processGdtSync(job: Job<SyncJobData>): Promise<void> {
  const { companyId, fromDate: jobFromDate, toDate: jobToDate } = job.data;
  const runId     = uuidv4();
  const startedAt = Date.now();

  logger.info('[SyncWorker] Starting job', { jobId: job.id, companyId });

  // ── 0. Time-of-day awareness (BEFORE lock — don't hold lock while sleeping) ──
  // Prefer running during Vietnam business hours (8am-8pm GMT+7).
  // Skip delay for: development, first-run jobs triggered manually by user setup.
  const isDev = process.env['NODE_ENV'] !== 'production';
  const isFirstRun = (job.id ?? '').startsWith('gdt-bot-first-');
  if (!isDev && !isFirstRun) {
    const vnHour = new Date(Date.now() + 7 * 3600_000).getUTCHours();
    if (vnHour < 7 || vnHour >= 20) {
      const delayMs = 5 * 60_000 + Math.floor(Math.random() * 25 * 60_000); // 5-30 min
      logger.info('[SyncWorker] Off-hours delay (VN time)', { vnHour, delayMs });
      await new Promise(r => setTimeout(r, delayMs));
    } else if (vnHour === 7 || vnHour === 19) {
      const delayMs = 60_000 + Math.floor(Math.random() * 4 * 60_000); // 1-5 min
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Per-company mutex via Redis SET NX — atomic, no TOCTOU race.
  // Throw regular Error → BullMQ retries with the job's configured backoff.
  // (moveToDelayed requires Redis 6.2+; our Redis 5.0.14 doesn't support it.)
  // This throw is BEFORE the inner try/catch, so _failRun() is NOT called.
  const lockAcquired = await acquireCompanyLock(companyId);
  if (!lockAcquired) {
    logger.warn('[SyncWorker] Company already syncing — will retry via backoff', { jobId: job.id, companyId });
    throw new Error(`LOCK_CONFLICT: company ${companyId} already syncing`);
  }
  try {

    // ── 1. Load config ──────────────────────────────────────────────────────────
    const cfgRes = await pool.query(
      `SELECT encrypted_credentials, has_otp, otp_method, tax_code,
              blocked_until, proxy_session_id, consecutive_failures, last_run_at
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
    };

    // Check if blocked — skip _failRun (not a real failure, just a cooldown)
    if (cfg.blocked_until && new Date(cfg.blocked_until) > new Date()) {
      logger.warn('[SyncWorker] Company blocked until', { companyId, blocked_until: cfg.blocked_until });
      throw new Error(`COOLDOWN_SKIP: Bot blocked until ${cfg.blocked_until}`);
    }

    // ── 1b. Quota gate ─────────────────────────────────────────────────────────
    // Throws UnrecoverableError if owner's quota is exhausted or subscription suspended.
    await _checkQuota(companyId);

    // Anti-detection: enforce minimum 15 minutes between logins per company.
    // Prevents rapid successive logins to GDT (e.g. from manual retrigger or BullMQ backoff cascade).
    const MIN_LOGIN_INTERVAL_MS = 15 * 60 * 1000;
    if (cfg.last_run_at) {
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
    // Each company gets its own session ID → TMProxy gateway assigns a dedicated IP.
    // GDT will see a different residential IP for each company (no cross-account pattern).
    let proxySessionId = cfg.proxy_session_id;
    if (!proxySessionId) {
      proxySessionId = randomBytes(8).toString('hex'); // 16-char hex, e.g. 'a3f9b2c1d4e5f678'
      await pool.query(
        `UPDATE gdt_bot_configs SET proxy_session_id = $1, updated_at = NOW() WHERE company_id = $2`,
        [proxySessionId, companyId]
      );
      logger.info('[SyncWorker] New proxy session assigned', { companyId, proxySessionId });
    }
    const proxyUrl       = proxyManager.nextForCompany(proxySessionId);
    const socks5ProxyUrl = proxyManager.nextSocks5ForCompany(proxySessionId);

    // Safety guard: never login to GDT without proxy protection.
    // Running without a proxy exposes the real server IP — GDT can correlate multiple
    // company logins to one IP and flag the account.
    // If TMProxy is out of credit (code 27), abort until the user tops up the plan.
    //
    // ALLOW_DIRECT_CONNECTION=true bypasses this guard for local development only.
    // NEVER enable in production — real server IP would be exposed to GDT.
    if (!proxyUrl) {
      const allowDirect = process.env['ALLOW_DIRECT_CONNECTION'] === 'true';
      if (!allowDirect) {
        logger.error('[SyncWorker] No proxy available — aborting sync to protect against GDT detection. ' +
          'Possible causes: (1) TMProxy code=27 — key valid but session expired/never started ' +
          '(bot will auto-request new IP on next restart); ' +
          '(2) TMPROXY_API_KEY balance expired; (3) no PROXY_LIST set. ' +
          'Dev workaround: set ALLOW_DIRECT_CONNECTION=true (NEVER in production)', { companyId });
        throw new UnrecoverableError('[SyncWorker] No proxy available — sync aborted for safety');
      }
      logger.warn(
        '[SyncWorker] No proxy — running with DIRECT connection (ALLOW_DIRECT_CONNECTION=true). ' +
        'DO NOT use in production!',
        { companyId },
      );
    }

    // ── 4. Login via GDT Direct API ──────────────────────────────────────────────
    await pool.query(
      `INSERT INTO gdt_bot_runs (id, company_id, started_at, status) VALUES ($1, $2, NOW(), 'running')`,
      [runId, companyId]
    );

    // Human-like warmup: 3–15s random pause before opening session.
    // Simulates an accountant opening a browser and navigating to the portal.
    await thinkTime(3_000, 15_000);

    const gdtApi = new GdtDirectApiService(proxyUrl, socks5ProxyUrl);
    try {
      await gdtApi.login(creds.username, creds.password);
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

    // ── 5. Fetch invoices via Direct API ─────────────────────────────────────────
    const runner = gdtApi;
    let outputCount = 0;
    let inputCount  = 0;

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
        // First run: start of current month
        fromDate = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
      }

      // Enforce GDT max 31-day rule: nếu range vượt quá, co lại từ toDate về đủ 31 ngày.
      // Normalize về 00:00:00 đầu ngày để tránh kiệu T23:59:59 bị kế thừa từ toDate.
      const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
      if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_MS) {
        const clampedDate = new Date(toDate.getTime() - MAX_RANGE_MS);
        // Normalize: lấy YYYY-MM-DD rồi parse lại để đảm bảo giờ = 00:00:00
        const clampedStr = clampedDate.toISOString().slice(0, 10);
        logger.warn('[SyncWorker] Date range exceeds 31 days — clamping fromDate', {
          original: fromDate.toISOString().slice(0, 10),
          clamped:  clampedStr,
        });
        fromDate = new Date(`${clampedStr}T00:00:00`);
      }

      logger.info('[SyncWorker] Date range', {
        from: fromDate.toISOString().slice(0, 10),
        to:   toDate.toISOString().slice(0, 10),
        source: jobFromDate ? 'job' : 'default',
      });

      let xmlFetchCount = 0;

      // Output invoices
      const outputInvoices = await runner.fetchOutputInvoices(fromDate, toDate);

      // Check cancellation after login (before any heavy work)
      if (await checkCancellationRequested(companyId)) {
        throw new Error('CANCEL_SKIP: sync cancelled by user');
      }

      for (let i = 0; i < outputInvoices.length; i++) {
        const inv = outputInvoices[i]!;
        const invoiceId = await _upsertInvoice(inv, companyId, 'output');
        outputCount++;
        if (xmlFetchCount < MAX_XML_FETCHES_PER_RUN) {
          xmlFetchCount += await _maybeInsertLineItems(runner, inv, invoiceId, companyId);
        }
        if (i > 0 && i % JITTER_EVERY === 0) await jitteredDelay();
        if (shouldReadPause(i)) {
          logger.info('[SyncWorker] Read pause (human-like)', { companyId, index: i });
          await readPause();
        }
        // Cancellation check every JITTER_EVERY invoices (same cadence as jitter delay)
        if (i > 0 && i % JITTER_EVERY === 0) {
          if (await checkCancellationRequested(companyId)) {
            logger.info('[SyncWorker] Cancellation requested mid-output-fetch', { companyId, processedSoFar: i });
            throw new Error('CANCEL_SKIP: sync cancelled by user');
          }
        }
        // Progress update
        if (i % 5 === 0 || i === outputInvoices.length - 1) {
          const pct = Math.round(((i + 1) / (outputInvoices.length * 2)) * 50);
          await job.updateProgress({
            percent: pct,
            invoicesFetched: outputCount + inputCount,
            statusMessage: `Đang xử lý HĐ đầu ra ${i + 1}/${outputInvoices.length}...`,
            currentPage: i + 1,
            totalPages: outputInvoices.length,
          } as Record<string, unknown>);
        }
      }

      // Human-like pause between output and input fetch (2–8s)
      // Mimics user switching tabs or waiting for a page to load.
      if (outputInvoices.length > 0) await thinkTime(2_000, 8_000);
      const inputInvoices = await runner.fetchInputInvoices(fromDate, toDate);
      for (let i = 0; i < inputInvoices.length; i++) {
        const inv = inputInvoices[i]!;
        const invoiceId = await _upsertInvoice(inv, companyId, 'input');
        inputCount++;
        if (xmlFetchCount < MAX_XML_FETCHES_PER_RUN) {
          xmlFetchCount += await _maybeInsertLineItems(runner, inv, invoiceId, companyId);
        }
        if (i > 0 && i % JITTER_EVERY === 0) await jitteredDelay();
        if (shouldReadPause(i)) {
          logger.info('[SyncWorker] Read pause (human-like)', { companyId, index: i });
          await readPause();
        }
        // Cancellation check every JITTER_EVERY invoices
        if (i > 0 && i % JITTER_EVERY === 0) {
          if (await checkCancellationRequested(companyId)) {
            logger.info('[SyncWorker] Cancellation requested mid-input-fetch', { companyId, processedSoFar: i });
            throw new Error('CANCEL_SKIP: sync cancelled by user');
          }
        }
        // Progress update
        if (i % 5 === 0 || i === inputInvoices.length - 1) {
          const pct = 50 + Math.round(((i + 1) / inputInvoices.length) * 50);
          await job.updateProgress({
            percent: pct,
            invoicesFetched: outputCount + inputCount,
            statusMessage: `Đang xử lý HĐ đầu vào ${i + 1}/${inputInvoices.length}...`,
            currentPage: i + 1,
            totalPages: inputInvoices.length,
          } as Record<string, unknown>);
        }
      }

      if (proxyUrl) proxyManager.markHealthy(proxyUrl);

      // Final progress update
      await job.updateProgress({
        percent: 100,
        invoicesFetched: outputCount + inputCount,
        statusMessage: `Hoàn thành — ${outputCount} HĐ đầu ra, ${inputCount} HĐ đầu vào`,
      } as Record<string, unknown>);

      const durationMs = Date.now() - startedAt;
      await pool.query(
        `UPDATE gdt_bot_runs
         SET status = 'success', finished_at = NOW(), output_count = $1, input_count = $2, duration_ms = $3
         WHERE id = $4`,
        [outputCount, inputCount, durationMs, runId]
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
      await _consumeQuota(companyId, totalSynced);

      // ── Schedule next auto-sync with jitter (BOT-ENT-01) ────────────────────────
      // Non-fatal: wrap in try/catch — column may not exist until migration 026 is applied.
      // Invoices are already saved; a missing schedule update must NEVER fail the job.
      try {
        await pool.query(
          `UPDATE gdt_bot_configs
           SET next_auto_sync_at = NOW() + INTERVAL '5 hours'
             + (FLOOR(RANDOM() * 180) || ' minutes')::INTERVAL
           WHERE company_id = $1`,
          [companyId],
        );
      } catch (schedErr) {
        logger.warn('[SyncWorker] next_auto_sync_at update skipped (migration 026 not applied?)', {
          companyId,
          err: schedErr instanceof Error ? schedErr.message : String(schedErr),
        });
      }

      logger.info('[SyncWorker] Done', { companyId, outputCount, inputCount, durationMs });

      // ── Push notification via backend queue ─────────────────────────────────────
      if (totalSynced > 0) {
        try {
          await _notifQueue.add('sync-complete', {
            companyId,
            provider: 'GDT Bot',
            count: totalSynced,
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
          try {
            await _botSyncQueue.add('sync', {
              companyId,
              fromDate: nextJobData.fromDate,
              toDate:   nextJobData.toDate,
              label:    nextJobData.label,
              groupId:  job.data.groupId,
              jobIndex: nextIndex,
              jobTotal,
              allJobs:  job.data.allJobs,
            }, {
              jobId:    nextJobId,
              delay:    5_000, // 5s gap before next month starts
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
      // COOLDOWN_SKIP / CANCEL_SKIP: not real failures — don't touch consecutive_failures.
      const isSkip = msg.startsWith('COOLDOWN_SKIP:') || msg.startsWith('CANCEL_SKIP:');
      if (!isSkip) {
        await _failRun(runId, companyId, msg, false);
      }
      throw err;
    }
  } finally {
    // Release both locks:
    // 1. Bot worker lock (bot:sync:lock:) — prevents concurrent bot jobs
    // 2. HTTP route lock (sync:lock:) — prevents double-click from UI
    await releaseCompanyLock(companyId);
    await _lockRedis.del(`sync:lock:${companyId}`);
  }
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
      invoice_group, serial_has_cqt, has_line_items, created_at)
     VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8,COALESCE($9,''),$10,$11,$12,$13,$14,$15,true,'gdt_bot','gdt_bot',
      $16,$17,$18,NOW())
     ON CONFLICT (company_id, provider, invoice_number, COALESCE(seller_tax_code, ''), invoice_date) DO UPDATE SET
       direction       = EXCLUDED.direction,
       status          = EXCLUDED.status,
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
      invoiceGroup, serialHasCqt, hasLineItems,
    ]
  );
  return res.rows[0].id as string;
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
  // Invoices without GDT code (ttxly==6, ttxly==8) have no XML on GDT server.
  // Attempting export-xml for them always returns HTTP 500 — skip immediately.
  if (!inv.xml_available) {
    return 0;
  }

  // Need serial_number + seller_tax_code to call exportInvoiceXml
  if (!inv.invoice_number || !inv.serial_number || !inv.seller_tax_code) {
    logger.info('[SyncWorker] XML skip — missing params', {
      invoiceId,
      invoice_number:  inv.invoice_number,
      serial_number:   inv.serial_number,
      seller_tax_code: inv.seller_tax_code,
    });
    return 0;
  }

  // Skip if line items already exist in DB
  const existing = await pool.query(
    'SELECT 1 FROM invoice_line_items WHERE invoice_id = $1 LIMIT 1',
    [invoiceId]
  );
  if (existing.rows.length > 0) return 0;

  // Rate-limit: wait 2.5–4.5s before every XML fetch
  await thinkTime(XML_FETCH_DELAY_MIN, XML_FETCH_DELAY_MAX);

  try {
    // Retry once on 429 (rate-limited) with a 10s back-off
    let xmlBuf: Buffer;
    try {
      xmlBuf = await gdtApi.exportInvoiceXml({
        nbmst:    inv.seller_tax_code,
        khhdon:   inv.serial_number,
        shdon:    inv.invoice_number,
        khmshdon: 1,
      });
    } catch (firstErr: unknown) {
      const is429 = firstErr instanceof Error && firstErr.message.includes('429');
      if (!is429) throw firstErr;
      logger.warn('[SyncWorker] XML fetch 429 — waiting 12s then retrying once', { invoiceId });
      await thinkTime(12_000, 15_000);
      xmlBuf = await gdtApi.exportInvoiceXml({
        nbmst:    inv.seller_tax_code,
        khhdon:   inv.serial_number,
        shdon:    inv.invoice_number,
        khmshdon: 1,
      });
    }

    const lineItems: LineItem[] = xmlParser.parseLineItems(xmlBuf);
    if (lineItems.length === 0) return 1;

    // Delete stale items then bulk insert
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
    const values = lineItems.map((item, i) => {
      const base = i * 11;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`;
    }).join(',');
    const params: unknown[] = [];
    for (const item of lineItems) {
      params.push(
        uuidv4(), invoiceId, companyId,
        item.line_number, item.item_code, item.item_name,
        item.unit, item.quantity, item.unit_price,
        item.subtotal, item.vat_rate, item.vat_amount, item.total
      );
    }
    // Rebuild values with 13 placeholders per item
    const values13 = lineItems.map((_, i) => {
      const b = i * 13;
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13})`;
    }).join(',');
    await pool.query(
      `INSERT INTO invoice_line_items
       (id, invoice_id, company_id, line_number, item_code, item_name,
        unit, quantity, unit_price, subtotal, vat_rate, vat_amount, total)
       VALUES ${values13}`,
      params
    );
    logger.info('[SyncWorker] Line items inserted', { invoiceId, count: lineItems.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[SyncWorker] Line items fetch failed (non-fatal)', { invoiceId, msg });
  }
  return 1;
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
export const manualWorker = new Worker<SyncJobData>(
  'gdt-sync-manual',
  processGdtSync,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 10,
    limiter:     { max: 10, duration: 60_000 },
  }
);

// ── Auto worker (concurrency 2 — background scheduled syncs) ─────────────────
export const autoWorker = new Worker<SyncJobData>(
  'gdt-sync-auto',
  processGdtSync,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 2,
    limiter:     { max: 2, duration: 60_000 },
  }
);

worker.on('completed', job => {
  logger.info('[SyncWorker] Job completed', { jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error('[SyncWorker] Job failed', { jobId: job?.id, error: err.message });
});

worker.on('error', err => {
  logger.error('[SyncWorker] Worker error', { error: err.message });
});

for (const [name, w] of [['manualWorker', manualWorker], ['autoWorker', autoWorker]] as const) {
  w.on('completed', (job) => {
    logger.info(`[SyncWorker/${name}] Job completed`, { jobId: job.id });
    const dur = (job.finishedOn ?? Date.now()) - (job.processedOn ?? Date.now());
    void recordMetrics(job, 'success', dur);
  });
  w.on('failed', (job, err) => {
    logger.error(`[SyncWorker/${name}] Job failed`, { jobId: job?.id, error: err.message });
    if (job) void recordMetrics(job, 'failed', Date.now() - (job.processedOn ?? Date.now()));
    void handleJobFailure(job, err);
  });
  w.on('error', err => logger.error(`[SyncWorker/${name}] Worker error`, { error: err.message }));
}
