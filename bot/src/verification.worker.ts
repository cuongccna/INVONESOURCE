/**
 * Verification Worker — tra cứu trạng thái MST đối tác từ cổng Cục Thuế
 *
 * Process riêng (PM2: invone-verify-worker) — tách khỏi bot crawl để lỗi tra cứu
 * MST không bao giờ ảnh hưởng luồng đồng bộ hoá đơn.
 *
 * Nguồn việc:
 *   1. BullMQ queue 'company-verification' — backend enqueue khi user mở danh sách
 *      hoá đơn / bấm "Cập nhật trạng thái" (ưu tiên cao).
 *   2. Vòng quét định kỳ — tự tìm MST đối tác đã hết hạn cache và tra lại
 *      (giữ dữ liệu luôn mới mà không cần user thao tác).
 *
 * Rate limit: 1 request / 3 giây (BullMQ limiter) + jitter trong crawler.
 * Mỗi lần tra tốn 1 captcha 2Captcha (~0.5–1 VNĐ) nên cache TTL theo trạng thái.
 */
import 'dotenv/config';
import { Worker, Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { TracuunntCrawler, CompanyLookupResult, MstStatus } from './tracuunnt-crawler';
import { pool } from './db';
import { logger } from './logger';

const REDIS_URL  = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const QUEUE_NAME = 'company-verification';

/** Chu kỳ tự quét MST hết hạn (ms) */
const SWEEP_INTERVAL_MS = Number(process.env['VERIFY_SWEEP_INTERVAL_MS'] ?? 15 * 60_000);
/** Số MST tối đa mỗi vòng quét — 1 req/3s ⇒ 40 MST ≈ 2 phút */
const SWEEP_BATCH       = Number(process.env['VERIFY_SWEEP_BATCH'] ?? 40);

/**
 * TTL cache theo trạng thái — "xấu" thì tra lại sớm, "đã chết" thì tra thưa.
 * Trạng thái đối tác là căn cứ khấu trừ VAT nên active vẫn phải làm mới hàng tuần.
 */
const TTL_BY_STATUS: Record<MstStatus, string> = {
  active:              '7 days',
  suspended:           '3 days',
  inactive_at_address: '3 days',
  pending_dissolution: '3 days',
  moved:               '3 days',
  dissolved:           '30 days',
  not_found:           '7 days',
  error:               '1 hour',
  pending:             '1 hour',
};

export interface VerifySingleJob {
  type:         'verify-single';
  taxCode:      string;
  companyId:    string;
  forceRefresh?: boolean;
}

export interface VerifyCompanyJob {
  type:      'verify-company';
  companyId: string;
  userId?:   string;
}

type VerificationJob = VerifySingleJob | VerifyCompanyJob;

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const verificationQueue = new Queue<VerificationJob>(QUEUE_NAME, {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 30_000 },
    removeOnComplete: 200,
    removeOnFail:     100,
  },
});

// ─── Lưu kết quả ──────────────────────────────────────────────────────────────

async function persist(result: CompanyLookupResult): Promise<void> {
  const ttl = TTL_BY_STATUS[result.mst_status] ?? '1 hour';
  const isError = result.mst_status === 'error';

  await pool.query(
    `INSERT INTO company_verification_cache
       (tax_code, company_name, legal_rep, address, mst_status, mst_status_raw,
        tax_authority, branches, source, raw_data, last_error, last_error_at,
        check_ms, attempts, verified_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,
             CASE WHEN $11::text IS NULL THEN NULL ELSE NOW() END,
             $12, 1, NOW(), NOW() + $13::interval)
     ON CONFLICT (tax_code) DO UPDATE SET
       company_name    = COALESCE(EXCLUDED.company_name, company_verification_cache.company_name),
       legal_rep       = COALESCE(EXCLUDED.legal_rep,    company_verification_cache.legal_rep),
       address         = COALESCE(EXCLUDED.address,      company_verification_cache.address),
       tax_authority   = COALESCE(EXCLUDED.tax_authority, company_verification_cache.tax_authority),
       branches        = COALESCE(EXCLUDED.branches,     company_verification_cache.branches),
       -- Lỗi kỹ thuật KHÔNG được ghi đè trạng thái hợp lệ đã biết trước đó
       mst_status      = CASE WHEN EXCLUDED.mst_status = 'error'
                                AND company_verification_cache.mst_status NOT IN ('error','pending')
                              THEN company_verification_cache.mst_status
                              ELSE EXCLUDED.mst_status END,
       mst_status_raw  = COALESCE(EXCLUDED.mst_status_raw, company_verification_cache.mst_status_raw),
       source          = EXCLUDED.source,
       raw_data        = COALESCE(EXCLUDED.raw_data, company_verification_cache.raw_data),
       last_error      = EXCLUDED.last_error,
       last_error_at   = EXCLUDED.last_error_at,
       check_ms        = EXCLUDED.check_ms,
       attempts        = CASE WHEN EXCLUDED.mst_status = 'error'
                              THEN company_verification_cache.attempts + 1 ELSE 0 END,
       verified_at     = CASE WHEN EXCLUDED.mst_status = 'error'
                              THEN company_verification_cache.verified_at ELSE NOW() END,
       expires_at      = EXCLUDED.expires_at`,
    [
      result.taxCode,
      result.company_name  ?? null,
      result.legal_rep     ?? null,
      result.address       ?? null,
      result.mst_status,
      result.mst_status_raw ?? null,
      result.tax_authority ?? null,
      result.branches && result.branches.length > 0 ? JSON.stringify(result.branches) : null,
      result.source,
      result.raw_data ? JSON.stringify(result.raw_data) : null,
      isError ? `${result.error_code ?? 'ERROR'}: ${result.error_message ?? ''}`.slice(0, 500) : null,
      result.check_ms ?? null,
      ttl,
    ],
  );

  await pool.query(
    `INSERT INTO verification_queue (tax_code, status, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (tax_code) DO UPDATE
        SET status = EXCLUDED.status,
            attempts = verification_queue.attempts + 1,
            updated_at = NOW()`,
    [result.taxCode, isError ? 'error' : 'done'],
  );
}

// ─── Xử lý job ────────────────────────────────────────────────────────────────

async function verifySingle(taxCode: string, sessionId = uuidv4()): Promise<CompanyLookupResult> {
  const crawler = new TracuunntCrawler(sessionId);
  const result  = await crawler.lookup(taxCode);
  await persist(result);
  logger.info('[VerificationWorker] Đã tra', {
    taxCode, status: result.mst_status, source: result.source, ms: result.check_ms,
  });
  return result;
}

/** Tra toàn bộ MST nhà cung cấp của một công ty (chỉ những MST đã hết hạn cache) */
async function verifyAllPartners(companyId: string): Promise<void> {
  const res = await pool.query<{ tax_code: string }>(
    `SELECT DISTINCT i.seller_tax_code AS tax_code
       FROM active_invoices i
       LEFT JOIN company_verification_cache c ON c.tax_code = i.seller_tax_code
      WHERE i.company_id = $1
        AND i.direction = 'input'
        AND i.seller_tax_code IS NOT NULL
        AND i.seller_tax_code <> 'B2C'
        AND (c.tax_code IS NULL OR c.expires_at < NOW())
      ORDER BY 1
      LIMIT 200`,
    [companyId],
  );

  const sessionId = uuidv4();
  for (const row of res.rows) {
    await verifySingle(row.tax_code, sessionId);
  }
  logger.info('[VerificationWorker] Xong batch theo công ty', {
    companyId, count: res.rows.length,
  });
}

async function processVerification(job: Job<VerificationJob>): Promise<void> {
  if (job.data.type === 'verify-single') {
    await verifySingle(job.data.taxCode);
  } else if (job.data.type === 'verify-company') {
    await verifyAllPartners(job.data.companyId);
  }
}

// ─── Vòng quét định kỳ: giữ dữ liệu luôn mới ─────────────────────────────────

let sweeping = false;

async function sweepStale(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    // Chỉ tra MST thực sự xuất hiện trên hoá đơn (không tra vu vơ → tiết kiệm captcha).
    // Ưu tiên: chưa từng tra → trạng thái xấu → hết hạn lâu nhất.
    const { rows } = await pool.query<{ tax_code: string }>(
      `WITH partners AS (
         SELECT DISTINCT CASE WHEN direction = 'input' THEN seller_tax_code ELSE buyer_tax_code END AS tax_code
           FROM invoices
          WHERE deleted_at IS NULL
            AND invoice_date > NOW() - INTERVAL '18 months'
       )
       SELECT p.tax_code
         FROM partners p
         LEFT JOIN company_verification_cache c ON c.tax_code = p.tax_code
        WHERE p.tax_code IS NOT NULL
          AND p.tax_code <> 'B2C'
          AND p.tax_code ~ '^[0-9]{10}(-[0-9]{3})?$'
          AND (c.tax_code IS NULL OR c.expires_at < NOW())
          AND COALESCE(c.attempts, 0) < 5
        ORDER BY (c.tax_code IS NULL) DESC,
                 (c.mst_status IN ('inactive_at_address','pending_dissolution','suspended')) DESC,
                 c.expires_at ASC NULLS FIRST
        LIMIT $1`,
      [SWEEP_BATCH],
    );

    if (rows.length === 0) return;
    logger.info('[VerificationWorker] Vòng quét: cần tra lại', { count: rows.length });

    const sessionId = uuidv4();
    for (const row of rows) {
      try {
        await verifySingle(row.tax_code, sessionId);
      } catch (err) {
        logger.warn('[VerificationWorker] Lỗi tra trong vòng quét', {
          taxCode: row.tax_code,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise(r => setTimeout(r, 3_000));   // 1 req/3s
    }
  } catch (err) {
    logger.error('[VerificationWorker] Vòng quét lỗi', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    sweeping = false;
  }
}

// ─── Khởi động ────────────────────────────────────────────────────────────────

export const verificationWorker = new Worker<VerificationJob>(
  QUEUE_NAME,
  processVerification,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 1,
    limiter:     { max: 1, duration: 3_000 },
  },
);

verificationWorker.on('completed', job => logger.debug('[VerificationWorker] Job xong', { id: job.id }));
verificationWorker.on('failed',    (job, err) => logger.error('[VerificationWorker] Job lỗi', {
  id: job?.id, error: err.message,
}));

logger.info('[VerificationWorker] Khởi động', {
  sweepIntervalMs: SWEEP_INTERVAL_MS, sweepBatch: SWEEP_BATCH,
});

const sweepTimer = setInterval(() => { void sweepStale(); }, SWEEP_INTERVAL_MS);
setTimeout(() => { void sweepStale(); }, 30_000);   // chạy lần đầu sau 30s

async function shutdown(): Promise<void> {
  clearInterval(sweepTimer);
  await verificationWorker.close().catch(() => undefined);
  await verificationQueue.close().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT',  () => { void shutdown(); });
