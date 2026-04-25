/**
 * BOT-REFACTOR-04: detail.worker.ts — Phase 2 Detail Fetch (Standalone PM2 Process)
 *
 * Polls invoice_detail_queue for pending/failed rows and fetches:
 *   1. GDT detail API (/query/invoices/detail or /sco-query/invoices/detail)
 *   2. Saves raw_detail JSON + all extended header columns (same as Phase 1 sync.worker)
 *   3. Inserts invoice_line_items rows
 *
 * Runs as a SEPARATE PM2 process — NOT imported by index.ts.
 * Concurrency: up to MAX_CONCURRENT_COMPANIES companies processed in parallel.
 * Per-company: up to BATCH_PER_COMPANY invoices at a time (sequential within company).
 *
 * Architecture:
 *   - Claim rows via UPDATE ... WHERE status = 'pending' AND attempts < max_attempts
 *   - Jitter 2–4.5s between GDT detail calls
 *   - Mark done / failed / skipped after processing
 *   - Exponential-ish backoff: row is only retried when attempts < max_attempts
 *
 * Authentication:
 *   - Reuses GdtSessionCache (shared Redis key with sync.worker)
 *   - Fetches a fresh JWT from GDT if cached token is expired
 *   - Shares GdtRawCacheService for HTTP-level caching
 */

import Redis                     from 'ioredis';
import { Queue }                 from 'bullmq';
import { v4 as uuidv4 }          from 'uuid';
import { pool }                  from './db';
import { decryptCredentials }    from './encryption.service';
import { proxyManager }          from './proxy-manager';
import { GdtDirectApiService, GdtAuthError } from './gdt-direct-api.service';
import { logger }                from './logger';
import { GdtSessionCache }       from './crawl-cache/GdtSessionCache';
import { GdtDetailCache }        from './crawl-cache/GdtDetailCache';
import { gdtRawCacheService }    from './crawl-cache/GdtRawCacheService';
import type { LineItem }         from './parsers/GdtXmlParser';

// ── Constants ─────────────────────────────────────────────────────────────────
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

/** Seconds between PostgreSQL polls when queue is empty. Internal only — never sent to GDT. */
const DB_POLL_INTERVAL_MS = 5_000;

/** Max invoices claimed per company per poll cycle. */
const BATCH_PER_COMPANY = 5;

/** Max parallel company workers per poll cycle. */
const MAX_CONCURRENT_COMPANIES = 20;

/** Jitter between GDT detail calls (ms). */
const GDT_JITTER_MIN_MS = 2_000;
const GDT_JITTER_MAX_MS = 4_500;

/** GDT JWT is valid for 30 min; refresh 5 min early = 25 min max age. */
const JWT_MAX_AGE_MS = 25 * 60_000;

/** Claim rows WHERE last_attempted_at < NOW() - STUCK_PROCESSING_MIN minutes (unstick). */
const STUCK_PROCESSING_MIN = 10;

// ── Singletons ────────────────────────────────────────────────────────────────
const _redis        = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
const _sessionCache = new GdtSessionCache(_redis);
const _detailCache  = new GdtDetailCache(_redis);
// Notification queue — tells backend (SyncNotificationWorker) to send push to user.
// Uses same Redis URL as sync.worker. Same queue name 'sync-notifications'.
const _notifQueue   = new Queue('sync-notifications', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});let _hasInvoiceRawDetailColumn: boolean | null = null;
let _skipInvoiceDetailSave = false;
let _loggedInvoiceRawDetailWarning = false;

// ── Row type from invoice_detail_queue ───────────────────────────────────────
interface DetailQueueRow {
  id:         string;
  invoice_id: string;
  company_id: string;
  nbmst:      string;   // seller_tax_code
  khhdon:     string;   // serial_number
  shdon:      string;   // invoice_number
  is_sco:     boolean;
  priority:   number;
  attempts:   number;
  max_attempts: number;
}

function isMissingColumnError(message: string): boolean {
  return /column\s+"[^"]+"\s+does not exist/i.test(message);
}

// ── Unrecoverable auth error ───────────────────────────────────────────────────────────────────────────────────
/**
 * Thrown when a GdtAuthError is caught inside getToken().
 * Signals processCompany() to stop immediately without any retry.
 */
class AuthUnrecoverableError extends Error {
  public readonly gdtErrorCode: number | string | null;
  constructor(message: string, gdtErrorCode: number | string | null = null) {
    super(message);
    this.name = 'AuthUnrecoverableError';
    this.gdtErrorCode = gdtErrorCode;
  }
}

/**
 * Permanently deactivates a company's bot:
 *   1. Sets gdt_bot_configs.is_active = false — prevents all future poll cycles.
 *   2. Exhausts all pending queue rows — prevents detail.worker from retrying.
 *   3. Sends push notification to company users via sync-notifications queue.
 *
 * Called immediately when GDT returns HTTP 400/401 non-captcha (GdtAuthError).
 * At this point the account may not yet be locked — stopping here prevents lockout.
 */
async function deactivateCompanyBot(
  companyId: string,
  reason: string,
  gdtErrorCode: number | string | null = null,
): Promise<void> {
  const errorLabel = gdtErrorCode != null ? ` [code=${gdtErrorCode}]` : '';
  const fullReason = `${reason}${errorLabel}`;

  try {
    await pool.query(
      `UPDATE gdt_bot_configs
       SET is_active = false, last_run_status = 'error', last_error = $2, updated_at = NOW()
       WHERE company_id = $1`,
      [companyId, fullReason.slice(0, 500)],
    );
    await pool.query(
      `UPDATE invoice_detail_queue
       SET status = 'failed', attempts = max_attempts, last_error = $2
       WHERE company_id = $1
         AND status IN ('pending', 'processing', 'failed')`,
      [companyId, `Bot deactivated — auth failed: ${fullReason}`.slice(0, 500)],
    );
    logger.error('[DetailWorker] CRITICAL: Bot deactivated — GDT auth failed (will NOT retry)', {
      companyId, reason, gdtErrorCode,
    });
  } catch (dbErr) {
    logger.error('[DetailWorker] Failed to deactivate company bot in DB', {
      companyId,
      err: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
  }

  // ── Notify user immediately via push notification (bell icon) ──────────────────────
  // The backend SyncNotificationWorker picks this up and sends web-push + DB record.
  try {
    await _notifQueue.add('bot-auth-failure', {
      companyId,
      errorMessage: fullReason,
      gdtErrorCode,
    }, { removeOnComplete: 100, removeOnFail: 50 });
    logger.info('[DetailWorker] Auth failure notification enqueued', { companyId, gdtErrorCode });
  } catch (notifErr) {
    logger.warn('[DetailWorker] Failed to enqueue auth failure notification (non-fatal)', {
      companyId,
      err: notifErr instanceof Error ? notifErr.message : String(notifErr),
    });
  }
}

function logInvoiceRawDetailWarningOnce(message: string): void {
  if (_loggedInvoiceRawDetailWarning) return;
  _loggedInvoiceRawDetailWarning = true;
  logger.warn('[DetailWorker] Invoice raw detail columns unavailable (non-fatal — run migration 038)', {
    err: message,
  });
}

async function hasInvoiceRawDetailColumn(): Promise<boolean> {
  if (_hasInvoiceRawDetailColumn !== null) return _hasInvoiceRawDetailColumn;

  try {
    const res = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'invoices'
           AND column_name = 'raw_detail'
       ) AS exists`,
    );
    _hasInvoiceRawDetailColumn = res.rows[0]?.exists === true;
    if (!_hasInvoiceRawDetailColumn) {
      logInvoiceRawDetailWarningOnce('column "raw_detail" does not exist');
    }
    return _hasInvoiceRawDetailColumn;
  } catch (err) {
    logger.warn('[DetailWorker] raw_detail schema probe failed (assuming migration exists)', {
      err: err instanceof Error ? err.message : String(err),
    });
    _hasInvoiceRawDetailColumn = true;
    return _hasInvoiceRawDetailColumn;
  }
}

// ── Helper: random delay ──────────────────────────────────────────────────────
function jitterMs(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
async function jitterDelay(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, jitterMs(GDT_JITTER_MIN_MS, GDT_JITTER_MAX_MS)));
}

// ── Bulk-insert line items (mirrors _bulkInsertLineItems in sync.worker.ts) ──
async function _bulkInsertLineItems(
  lineItems: LineItem[],
  invoiceId: string,
  companyId: string,
): Promise<void> {
  if (lineItems.length === 0) return;
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
}

// ── Claim a batch of rows for one company ─────────────────────────────────────
async function claimBatch(companyId: string): Promise<DetailQueueRow[]> {
  const res = await pool.query<DetailQueueRow>(
    `UPDATE invoice_detail_queue
     SET status = 'processing', attempts = attempts + 1, last_attempted_at = NOW()
     WHERE id IN (
       SELECT id FROM invoice_detail_queue
       WHERE company_id = $1
         AND (
           (status = 'pending')
           OR
           (status = 'failed' AND attempts < max_attempts)
           OR
           -- Unstick rows that were left in 'processing' for > STUCK_PROCESSING_MIN minutes
           (status = 'processing' AND last_attempted_at < NOW() - ($3 || ' minutes')::INTERVAL)
         )
       ORDER BY priority ASC, enqueued_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING
       id, invoice_id, company_id,
       nbmst, khhdon, shdon, is_sco,
       priority, attempts, max_attempts`,
    [companyId, BATCH_PER_COMPANY, STUCK_PROCESSING_MIN],
  );
  return res.rows;
}

// ── Mark a single row done / failed / skipped ─────────────────────────────────
async function markDone(rowId: string): Promise<void> {
  await pool.query(
    `UPDATE invoice_detail_queue
     SET status = 'done', done_at = NOW(), last_error = NULL
     WHERE id = $1`,
    [rowId],
  );
}
async function markSkipped(rowId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE invoice_detail_queue
     SET status = 'skipped', done_at = NOW(), last_error = $2
     WHERE id = $1`,
    [rowId, reason],
  );
}
async function markFailed(rowId: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
  const finalStatus = attempts >= maxAttempts ? 'failed' : 'failed';
  await pool.query(
    `UPDATE invoice_detail_queue
     SET status = $1, last_error = $2
     WHERE id = $3`,
    [finalStatus, error.slice(0, 500), rowId],
  );
}

// ── Get or refresh GDT token for a company ────────────────────────────────────
async function getToken(
  companyId:     string,
  proxySessionId: string,
  proxyUrl:      string | null,
  gdtUsername:   string,
  gdtPassword:   string,
): Promise<string | null> {
  // Check session cache first (shared with sync.worker via same Redis key)
  const cached = await _sessionCache.get(companyId, proxySessionId);
  if (cached) {
    // Parse issue time from JWT iat claim (without verifying signature — server-side only)
    try {
      const [, payload] = cached.split('.');
      if (payload) {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
        const iat = typeof parsed['iat'] === 'number' ? parsed['iat'] : 0;
        if (Date.now() - iat * 1000 < JWT_MAX_AGE_MS) {
          return cached;
        }
      }
    } catch {
      // If decode fails, treat as expired
    }
  }

  // Token expired or missing — re-authenticate
  logger.info('[DetailWorker] Re-authenticating with GDT', { companyId });
  const gdtApi = new GdtDirectApiService(proxyUrl ?? undefined, null, undefined, companyId, null, gdtRawCacheService);
  try {
    await gdtApi.login(gdtUsername, gdtPassword);
    const freshToken = gdtApi.getToken();
    if (freshToken) {
      await _sessionCache.set(companyId, proxySessionId, freshToken);
      return freshToken;
    }
  } catch (err) {
    // GdtAuthError = GDT explicitly rejected credentials (HTTP 400/401, non-captcha).
    // This is the ONLY reliable signal — no string matching needed.
    // Re-throw as AuthUnrecoverableError so processCompany() deactivates the bot.
    if (err instanceof GdtAuthError) {
      logger.error('[DetailWorker] GDT rejected credentials — STOP immediately (will not retry)', {
        companyId,
        gdtErrorCode: err.gdtErrorCode,
        httpStatus:   err.httpStatus,
        err:          err.message,
      });
      throw new AuthUnrecoverableError(err.message, err.gdtErrorCode);
    }

    // Transient errors (network, proxy, captcha exhausted) — skip this cycle, retry next poll.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[DetailWorker] GDT login failed (transient — will retry next cycle)', {
      companyId, err: msg,
    });
  }
  return null;
}

// ── Process one queue row (fetch detail + save) ───────────────────────────────
async function processRow(
  row:     DetailQueueRow,
  gdtApi:  GdtDirectApiService,
): Promise<'done' | 'skipped' | 'failed'> {
  const { invoice_id: invoiceId, nbmst, khhdon, shdon, is_sco: isSco } = row;
  const hasRawDetailColumn = await hasInvoiceRawDetailColumn();

  // Check if detail already fetched (race with another worker instance)
  const existingRes = await pool.query<{ has_detail: boolean; has_items: boolean; payment_method: string | null }>(
    `SELECT
       ${hasRawDetailColumn ? '(i.raw_detail IS NOT NULL)' : 'FALSE'}         AS has_detail,
       EXISTS(SELECT 1 FROM invoice_line_items WHERE invoice_id = i.id)       AS has_items,
       i.payment_method                                                       AS payment_method
     FROM invoices i
     WHERE i.id = $1
     LIMIT 1`,
    [invoiceId],
  );
  const existing = existingRes.rows[0];
  if (existing?.has_detail && existing?.has_items && existing?.payment_method) {
    return 'skipped';
  }

  // Check detail cache before hitting GDT
  let detail: Awaited<ReturnType<typeof gdtApi.fetchInvoiceDetail>>;
  const cached = await _detailCache.get(nbmst, khhdon, shdon);
  if (cached) {
    detail = cached as Awaited<ReturnType<typeof gdtApi.fetchInvoiceDetail>>;
    logger.debug('[DetailWorker] Detail cache HIT', { invoiceId });
  } else {
    detail = await gdtApi.fetchInvoiceDetail({ nbmst, khhdon, shdon, isSco });
    await _detailCache.set(nbmst, khhdon, shdon, detail as Record<string, unknown>);
  }

  // Parse and insert line items
  const lineItems = GdtDirectApiService.parseLineItemsFromDetail(detail);
  if (lineItems.length > 0 && !existing?.has_items) {
    await _bulkInsertLineItems(lineItems, invoiceId, row.company_id);
    logger.info('[DetailWorker] Line items inserted', { invoiceId, count: lineItems.length });
  }

  // Save raw detail + all extended header fields to invoices
  const d = detail as Record<string, unknown>;
  const paymentMethod = typeof detail.thtttoan === 'string' && detail.thtttoan.trim()
    ? detail.thtttoan.trim() : null;

  if (!_skipInvoiceDetailSave && hasRawDetailColumn) {
    try {
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
             THEN 'gdt_data' ELSE payment_method_source END
         WHERE id = $32`,
        [
          JSON.stringify(detail),                                                   // $1  raw_detail
          d['id']          as string ?? null,                                       // $2  gdt_invoice_id
          d['mhdon']       as string ?? null,                                       // $3  gdt_mhdon
          d['mtdtchieu']   as string ?? null,                                       // $4  gdt_mtdtchieu
          d['khmshdon']    as number ?? null,                                       // $5  gdt_khmshdon
          d['hdon']        as string ?? null,                                       // $6  gdt_hdon
          d['hthdon']      as number ?? null,                                       // $7  gdt_hthdon
          d['htttoan']     as number ?? null,                                       // $8  gdt_htttoan
          d['dvtte']       as string ?? null,                                       // $9  gdt_dvtte
          d['tgia']        as number ?? null,                                       // $10 gdt_tgia
          d['nky']         as string ?? null,                                       // $11 gdt_nky
          d['ttxly']       as number ?? null,                                       // $12 gdt_ttxly
          d['cqt']         as string ?? null,                                       // $13 gdt_cqt
          d['tvandnkntt']  as string ?? null,                                       // $14 gdt_tvandnkntt
          d['pban']        as string ?? null,                                       // $15 gdt_pban
          d['thlap']       as number ?? null,                                       // $16 gdt_thlap
          d['thdon']       as string ?? null,                                       // $17 gdt_thdon
          d['nbdchi']      as string ?? null,                                       // $18 seller_address
          d['nbstkhoan']   as string ?? null,                                       // $19 seller_bank_account
          d['nbtnhang']    as string ?? null,                                       // $20 seller_bank_name
          d['nbdctdtu']    as string ?? null,                                       // $21 seller_email
          d['nbsdthoai']   as string ?? null,                                       // $22 seller_phone
          d['nmdchi']      as string ?? null,                                       // $23 buyer_address
          d['nmstkhoan']   as string ?? null,                                       // $24 buyer_bank_account
          d['ttcktmai']    as number ?? null,                                       // $25 gdt_ttcktmai
          d['tgtphi']      as number ?? null,                                       // $26 gdt_tgtphi
          d['qrcode']      as string ?? null,                                       // $27 gdt_qrcode
          d['gchu']        as string ?? null,                                       // $28 gdt_gchu
          typeof d['nbcks']  === 'object'
            ? JSON.stringify(d['nbcks'])  : d['nbcks']  as string ?? null,         // $29 gdt_nbcks
          typeof d['cqtcks'] === 'object'
            ? JSON.stringify(d['cqtcks']) : d['cqtcks'] as string ?? null,         // $30 gdt_cqtcks
          paymentMethod,                                                            // $31 payment_method
          invoiceId,                                                                // $32 WHERE id
        ],
      );
    } catch (saveErr) {
      const message = saveErr instanceof Error ? saveErr.message : String(saveErr);
      if (isMissingColumnError(message)) {
        _skipInvoiceDetailSave = true;
        logInvoiceRawDetailWarningOnce(message);
      } else {
        logger.warn('[DetailWorker] raw_detail save failed (non-fatal — run migration 038)', {
          invoiceId,
          err: message,
        });
      }
    }
  }

  return 'done';
}

// ── Company-level config type ─────────────────────────────────────────────────
interface CompanyConfig {
  company_id:     string;
  proxy_url:      string | null;
  proxy_session_id: string;
  encrypted_credentials: string;
}

// ── Decode encrypted GDT credentials ─────────────────────────────────────────
async function getCompanyConfig(companyId: string): Promise<CompanyConfig | null> {
  const res = await pool.query<CompanyConfig>(
    `SELECT c.id AS company_id, g.proxy_url, g.proxy_session_id, g.encrypted_credentials
     FROM gdt_bot_configs g
     JOIN companies c ON c.id = g.company_id
     WHERE g.company_id = $1 AND g.is_active = true
     LIMIT 1`,
    [companyId],
  );
  return res.rows[0] ?? null;
}

// ── Process all pending rows for one company ──────────────────────────────────
async function processCompany(companyId: string): Promise<void> {
  const config = await getCompanyConfig(companyId);
  if (!config) {
    logger.warn('[DetailWorker] No active config for company — skipping', { companyId });
    return;
  }

  let creds: { username: string; password: string };
  try {
    const raw = await decryptCredentials(config.encrypted_credentials);
    creds = raw as { username: string; password: string };
  } catch (err) {
    logger.warn('[DetailWorker] Credential decrypt failed — skipping company', {
      companyId, err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const proxyUrl       = config.proxy_url ?? await proxyManager.nextForAutoSync(config.proxy_session_id);
  const proxySessionId = config.proxy_session_id;

  let token: string | null = null;
  try {
    token = await getToken(companyId, proxySessionId, proxyUrl, creds.username, creds.password);
  } catch (authErr) {
    if (authErr instanceof AuthUnrecoverableError) {
      // GDT rejected credentials (HTTP 400/401 non-captcha) — deactivate bot immediately.
      // Also notifies the user via push notification.
      await deactivateCompanyBot(companyId, authErr.message, authErr.gdtErrorCode);
      return;
    }
    throw authErr;
  }

  if (!token) {
    logger.warn('[DetailWorker] No valid token — skipping company this cycle', { companyId });
    return;
  }

  const gdtApi = new GdtDirectApiService(proxyUrl ?? undefined, null, undefined, companyId, null, gdtRawCacheService);
  gdtApi.setToken(token);

  const rows = await claimBatch(companyId);
  if (rows.length === 0) return;

  logger.info('[DetailWorker] Processing batch', { companyId, count: rows.length });

  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await jitterDelay();
    const row = rows[i]!;
    try {
      const outcome = await processRow(row, gdtApi);
      if (outcome === 'done') {
        await markDone(row.id);
        logger.debug('[DetailWorker] Row done', { invoiceId: row.invoice_id });
      } else if (outcome === 'skipped') {
        await markSkipped(row.id, 'already_complete');
      } else {
        await markFailed(row.id, 'process returned failed', row.attempts, row.max_attempts);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[DetailWorker] Row error', { invoiceId: row.invoice_id, err: msg });

      // 401 = token expired — invalidate and stop this company's batch
      if (msg.includes('401') || msg.toLowerCase().includes('token expired') || msg.toLowerCase().includes('unauthorized')) {
        await _sessionCache.invalidate(companyId, proxySessionId).catch(() => {});
        await markFailed(row.id, `token_expired: ${msg}`, row.attempts, row.max_attempts);
        logger.info('[DetailWorker] Token expired — stopping company batch', { companyId });
        break;
      }

      await markFailed(row.id, msg, row.attempts, row.max_attempts);
    }
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

/**
 * Get one pending company per USER, ordered by oldest pending invoice (FIFO).
 * This ensures:
 *   - User A's 3 companies are processed ONE AT A TIME (sequential), not in parallel.
 *   - Different users run concurrently (one company each).
 *   - A single company that is slow does NOT starve other users.
 */
async function getPendingCompanyIds(): Promise<string[]> {
  const res = await pool.query<{ company_id: string }>(
    `WITH pending AS (
       SELECT company_id, MIN(enqueued_at) AS oldest_pending
       FROM invoice_detail_queue
       WHERE (
         status = 'pending'
         OR (status = 'failed' AND attempts < max_attempts)
         OR (status = 'processing' AND last_attempted_at < NOW() - ($1 || ' minutes')::INTERVAL)
       )
       GROUP BY company_id
     )
     SELECT DISTINCT ON (uc.user_id) p.company_id
     FROM pending p
     JOIN user_companies uc ON uc.company_id = p.company_id
     ORDER BY uc.user_id, p.oldest_pending ASC
     LIMIT $2`,
    [STUCK_PROCESSING_MIN, MAX_CONCURRENT_COMPANIES],
  );
  return res.rows.map(r => r.company_id);
}

let _running = true;

async function pollLoop(): Promise<void> {
  logger.info('[DetailWorker] Poll loop started', {
    DB_POLL_INTERVAL_MS, BATCH_PER_COMPANY, MAX_CONCURRENT_COMPANIES,
  });

  while (_running) {
    try {
      const companyIds = await getPendingCompanyIds();

      if (companyIds.length > 0) {
        logger.info('[DetailWorker] Poll cycle', { companies: companyIds.length });
        // Process companies in parallel (each independently isolated)
        await Promise.allSettled(
          companyIds.map(companyId =>
            processCompany(companyId).catch(err =>
              logger.warn('[DetailWorker] processCompany error (non-fatal)', {
                companyId,
                err: err instanceof Error ? err.message : String(err),
              })
            )
          )
        );
      }
    } catch (err) {
      logger.error('[DetailWorker] Poll loop error', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Wait before next poll
    await new Promise<void>(resolve => setTimeout(resolve, DB_POLL_INTERVAL_MS));
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('[DetailWorker] SIGTERM received — stopping after current batch');
  _running = false;
});
process.on('SIGINT', () => {
  logger.info('[DetailWorker] SIGINT received — stopping after current batch');
  _running = false;
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  try {
    await _redis.connect();
    logger.info('[DetailWorker] Redis connected');
  } catch (err) {
    logger.warn('[DetailWorker] Redis connect warning (will retry automatically)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Start poll loop (non-blocking — runs until SIGTERM)
  void pollLoop();
}

void main();
