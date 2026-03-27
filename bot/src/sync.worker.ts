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
import { pool } from './db';
import { decryptCredentials } from './encryption.service';
import { proxyManager } from './proxy-manager';
import { GdtAuthService } from './gdt-auth.service';
import { GdtBotRunner } from './GdtBotRunner';
import { logger } from './logger';

const REDIS_URL    = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const CONCURRENCY  = parseInt(process.env['WORKER_CONCURRENCY'] ?? '2', 10);
const JITTER_EVERY = 10;
const JITTER_MIN   = 3500;
const JITTER_MAX   = 6500;

function jitteredDelay(): Promise<void> {
  const ms = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
  return new Promise(r => setTimeout(r, ms));
}

async function processGdtSync(job: Job<{ companyId: string; hasOtp?: boolean }>): Promise<void> {
  const { companyId } = job.data;
  const runId     = uuidv4();
  const startedAt = Date.now();

  logger.info('[SyncWorker] Starting job', { jobId: job.id, companyId });

  // ── 1. Load config ──────────────────────────────────────────────────────────
  const cfgRes = await pool.query(
    `SELECT encrypted_credentials, has_otp, otp_method, tax_code, blocked_until
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
  };

  // Check if blocked
  if (cfg.blocked_until && new Date(cfg.blocked_until) > new Date()) {
    logger.warn('[SyncWorker] Company blocked until', { companyId, blocked_until: cfg.blocked_until });
    throw new Error(`Bot blocked until ${cfg.blocked_until}`);
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

  // ── 3. Check OTP from Redis ─────────────────────────────────────────────────
  let otpCode: string | undefined;
  if (job.data.hasOtp) {
    const { default: IORedis } = await import('ioredis');
    const redis = new IORedis(REDIS_URL);
    otpCode = (await redis.get(`gdt_otp:${companyId}`)) ?? undefined;
    if (otpCode) await redis.del(`gdt_otp:${companyId}`);
    await redis.quit();
  }

  // ── 4. Rotate proxy ─────────────────────────────────────────────────────────
  const proxyUrl = proxyManager.next();

  // ── 5. Login ─────────────────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO gdt_bot_runs (id, company_id, started_at, status) VALUES ($1, $2, NOW(), 'running')`,
    [runId, companyId]
  );

  const authService = new GdtAuthService();
  let session;
  try {
    session = await authService.login(creds, proxyUrl);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isInvalidCreds = msg.toLowerCase().includes('mật khẩu') || msg.toLowerCase().includes('sai thông tin');
    if (isInvalidCreds) {
      await _failRun(runId, companyId, msg, true);
      throw new UnrecoverableError(`[SyncWorker] Invalid credentials: ${msg}`);
    }
    if (proxyUrl) proxyManager.markFailed(proxyUrl);
    await _failRun(runId, companyId, msg, false);
    throw new Error(`[SyncWorker] Login failed: ${msg}`);
  }

  // OTP required — signal UI and stop
  if (session.requiresOtp) {
    await pool.query(
      `UPDATE gdt_bot_configs SET last_run_status = 'otp_required', last_run_at = NOW(), updated_at = NOW()
       WHERE company_id = $1`,
      [companyId]
    );
    await pool.query(
      `UPDATE gdt_bot_runs SET status = 'otp_required', finished_at = NOW() WHERE id = $1`,
      [runId]
    );
    logger.info('[SyncWorker] OTP required, waiting for user input', { companyId });
    return;
  }

  if (otpCode && session.requiresOtp) {
    session = await authService.submitOtp(session, otpCode);
  }

  // ── 6. Crawl invoices ────────────────────────────────────────────────────────
  const runner = new GdtBotRunner(session, companyId);
  let outputCount = 0;
  let inputCount  = 0;

  try {
    // Default: last 30 days
    const toDate   = new Date();
    const fromDate = new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Output invoices
    const outputInvoices = await runner.crawlInvoices('output', { fromDate, toDate });
    for (let i = 0; i < outputInvoices.length; i++) {
      await _upsertInvoice(outputInvoices[i]!, companyId, 'output');
      outputCount++;
      if (i > 0 && i % JITTER_EVERY === 0) await jitteredDelay();
    }

    // Input invoices
    const inputInvoices = await runner.crawlInvoices('input', { fromDate, toDate });
    for (let i = 0; i < inputInvoices.length; i++) {
      await _upsertInvoice(inputInvoices[i]!, companyId, 'input');
      inputCount++;
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
    await pool.query(
      `UPDATE gdt_bot_configs
       SET last_run_at = NOW(), last_run_status = 'success',
           last_run_output_count = $1, last_run_input_count = $2, last_error = NULL, updated_at = NOW()
       WHERE company_id = $3`,
      [outputCount, inputCount, companyId]
    );

    logger.info('[SyncWorker] Done', { companyId, outputCount, inputCount, durationMs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await _failRun(runId, companyId, msg, false);
    throw err;
  }
}

async function _upsertInvoice(
  inv: import('./parsers/GdtXmlParser').RawInvoice,
  companyId: string,
  direction: 'output' | 'input'
): Promise<void> {
  await pool.query(
    `INSERT INTO invoices
     (id, company_id, invoice_number, invoice_date, direction, status,
      seller_name, seller_tax_code, buyer_name, buyer_tax_code,
      total_amount, vat_amount, vat_rate, gdt_validated, source, provider, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,'gdt_bot','gdt_bot',NOW())
     ON CONFLICT (company_id, invoice_number, direction) DO UPDATE SET
       invoice_date    = EXCLUDED.invoice_date,
       status          = EXCLUDED.status,
       total_amount    = EXCLUDED.total_amount,
       vat_amount      = EXCLUDED.vat_amount,
       vat_rate        = EXCLUDED.vat_rate,
       gdt_validated   = true,
       updated_at      = NOW()`,
    [
      uuidv4(), companyId,
      inv.invoice_number, inv.invoice_date, direction,
      inv.status ?? 'valid',
      inv.seller_name, inv.seller_tax_code,
      inv.buyer_name, inv.buyer_tax_code,
      inv.total_amount, inv.vat_amount, inv.vat_rate,
    ]
  );
}

async function _failRun(
  runId: string,
  companyId: string,
  errorMsg: string,
  deactivate: boolean
): Promise<void> {
  await pool.query(
    `UPDATE gdt_bot_runs
     SET status = 'error', finished_at = NOW(), error_detail = $1
     WHERE id = $2`,
    [errorMsg.slice(0, 1000), runId]
  );
  const upd = deactivate
    ? `UPDATE gdt_bot_configs SET last_run_status = 'error', last_run_at = NOW(),
         last_error = $1, is_active = false, updated_at = NOW()
       WHERE company_id = $2`
    : `UPDATE gdt_bot_configs SET last_run_status = 'error', last_run_at = NOW(),
         last_error = $1, updated_at = NOW()
       WHERE company_id = $2`;
  await pool.query(upd, [errorMsg.slice(0, 500), companyId]);
}

// ── Create and export worker ──────────────────────────────────────────────────
export const worker = new Worker<{ companyId: string; hasOtp?: boolean }>(
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
