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
import { Worker, Job, UnrecoverableError } from 'bullmq';
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
const JITTER_EVERY = 10;
const JITTER_MIN   = 3500;
const JITTER_MAX   = 6500;

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

// Per-company lock: prevents two jobs for the same company running concurrently.
// One company's session is strictly sequential — avoids double-login and double traffic to GDT.
const activeCompanies = new Set<string>();

function jitteredDelay(): Promise<void> {
  const ms = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
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

interface SyncJobData {
  companyId: string;
  fromDate?: string; // YYYY-MM-DD, optional — job-specific override
  toDate?:   string; // YYYY-MM-DD, optional
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

  // Per-company mutex: if a job for this company is already running, skip this one.
  // UnrecoverableError stops BullMQ from retrying — the scheduler re-evaluates on the
  // next 30-min tick, so there is no value in rapid retries that trigger extra logins.
  if (activeCompanies.has(companyId)) {
    logger.warn('[SyncWorker] Company already syncing — skipping (scheduler will re-enqueue)', { jobId: job.id, companyId });
    throw new UnrecoverableError(`[SyncWorker] Concurrent sync for company ${companyId} — skipped`);
  }
  activeCompanies.add(companyId);
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

    // Check if blocked
    if (cfg.blocked_until && new Date(cfg.blocked_until) > new Date()) {
      logger.warn('[SyncWorker] Company blocked until', { companyId, blocked_until: cfg.blocked_until });
      throw new Error(`Bot blocked until ${cfg.blocked_until}`);
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
        // UnrecoverableError: no point retrying rapidly — user retriggers after cooldown expires.
        // For scheduled jobs the scheduler will re-enqueue on the next 30-min tick.
        throw new UnrecoverableError(
          `[SyncWorker] Login cooldown: last run ${elapsedMin}m ago, wait ${waitMin}m more`,
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
      const isProxyOrNetworkError =
        msg.includes('socket disconnected') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('TLS') ||
        msg.includes('SSL') ||
        msg.includes('proxy');
      // _failRun increments consecutive_failures + clears proxy_session_id in DB
      await _failRun(runId, companyId, msg, false, isProxyOrNetworkError);
      throw new Error(`[SyncWorker] Login failed: ${msg}`);
    }

    // ── 5. Fetch invoices via Direct API ─────────────────────────────────────────
    const runner = gdtApi;
    let outputCount = 0;
    let inputCount  = 0;

    try {
      // Date range: use job-specific override if provided, else current month start → today
      const toDate   = jobToDate   ? new Date(`${jobToDate}T23:59:59`)   : new Date();
      const defaultFrom = new Date(toDate.getFullYear(), toDate.getMonth(), 1); // đầu tháng hiện tại
      let fromDate = jobFromDate ? new Date(`${jobFromDate}T00:00:00`) : defaultFrom;

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
      for (let i = 0; i < outputInvoices.length; i++) {
        const inv = outputInvoices[i]!;
        const invoiceId = await _upsertInvoice(inv, companyId, 'output');
        outputCount++;
        if (xmlFetchCount < MAX_XML_FETCHES_PER_RUN) {
          xmlFetchCount += await _maybeInsertLineItems(runner, inv, invoiceId, companyId);
        }
        if (i > 0 && i % JITTER_EVERY === 0) await jitteredDelay();
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
      }

      if (proxyUrl) proxyManager.markHealthy(proxyUrl);

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

      logger.info('[SyncWorker] Done', { companyId, outputCount, inputCount, durationMs });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't call _failRun for the concurrent-defer error (no runId created yet in that path,
      // and it's not a real failure — BullMQ will retry cleanly)
      if (!msg.includes('Concurrent sync for company')) {
        await _failRun(runId, companyId, msg, false);
      }
      throw err;
    }
  } finally {
    // Always release the per-company lock, including pre-flight failures like cooldown/no-proxy.
    activeCompanies.delete(companyId);
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

  const res = await pool.query(
    `INSERT INTO invoices
     (id, company_id, invoice_number, serial_number, invoice_date, direction, status,
      seller_name, seller_tax_code, buyer_name, buyer_tax_code,
      subtotal, total_amount, vat_amount, vat_rate, gdt_validated, source, provider, created_at)
     VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8,COALESCE($9,''),$10,$11,$12,$13,$14,$15,true,'gdt_bot','gdt_bot',NOW())
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

worker.on('completed', job => {
  logger.info('[SyncWorker] Job completed', { jobId: job.id });
});

worker.on('failed', (job, err) => {
  logger.error('[SyncWorker] Job failed', { jobId: job?.id, error: err.message });
});

worker.on('error', err => {
  logger.error('[SyncWorker] Worker error', { error: err.message });
});
