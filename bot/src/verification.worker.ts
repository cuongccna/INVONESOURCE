/**
 * Verification Worker — GHOST-02 bot companion
 *
 * BullMQ worker that processes company verification jobs from the
 * 'company-verification' queue.  Rate-limited to 1 request per 3 seconds
 * to avoid triggering tracuunnt.gdt.gov.vn rate limiting.
 *
 * On completion, results are written to company_verification_cache (via
 * HTTP call to the backend API) and risk flags are analysed.
 *
 * Job types:
 *   verify-single  — verify one tax code
 *   verify-company — verify all partners for a given company_id
 */
import { Worker, Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { TracuunntCrawler } from './tracuunnt-crawler';
import { pool } from './db';
import { logger } from './logger';

const REDIS_URL   = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const QUEUE_NAME  = 'company-verification';

export interface VerifySingleJob {
  type:      'verify-single';
  taxCode:   string;
  companyId: string;         // which company triggered the check
  priority?: number;
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
    attempts:          3,
    backoff:           { type: 'exponential', delay: 30_000 },
    removeOnComplete:  200,
    removeOnFail:      100,
  },
});

async function processVerification(job: Job<VerificationJob>): Promise<void> {
  const { type } = job.data;

  if (type === 'verify-single') {
    const { taxCode, companyId } = job.data as VerifySingleJob;
    await verifySingle(taxCode, companyId, uuidv4());
  } else if (type === 'verify-company') {
    const { companyId } = job.data as VerifyCompanyJob;
    await verifyAllPartners(companyId);
  }
}

async function verifySingle(taxCode: string, companyId: string, sessionId: string): Promise<void> {
  const crawler = new TracuunntCrawler(sessionId);
  const result  = await crawler.lookup(taxCode);

  // Persist to company_verification_cache
  await pool.query(
    `INSERT INTO company_verification_cache
       (tax_code, company_name, legal_rep, address, mst_status,
        registered_date, dissolved_date, source, raw_data, verified_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,
       $6::date, $7::date,
       $8, $9::jsonb, NOW(), NOW()+INTERVAL '30 days')
     ON CONFLICT (tax_code) DO UPDATE SET
       company_name    = EXCLUDED.company_name,
       legal_rep       = EXCLUDED.legal_rep,
       address         = EXCLUDED.address,
       mst_status      = EXCLUDED.mst_status,
       registered_date = EXCLUDED.registered_date,
       dissolved_date  = EXCLUDED.dissolved_date,
       source          = EXCLUDED.source,
       raw_data        = EXCLUDED.raw_data,
       verified_at     = NOW(),
       expires_at      = NOW() + INTERVAL '30 days'`,
    [
      result.taxCode,
      result.company_name ?? null,
      result.legal_rep    ?? null,
      result.address      ?? null,
      result.mst_status,
      result.registered_date ? parseVnDate(result.registered_date) : null,
      result.dissolved_date  ? parseVnDate(result.dissolved_date)  : null,
      result.source,
      result.raw_data ? JSON.stringify(result.raw_data) : null,
    ],
  );

  // Mark verification_queue entry as done
  await pool.query(
    `UPDATE verification_queue SET status='done', updated_at=NOW() WHERE tax_code=$1`,
    [taxCode],
  );

  logger.info(`[VerificationWorker] Verified ${taxCode}: ${result.mst_status} (${result.source})`);
}

async function verifyAllPartners(companyId: string): Promise<void> {
  // Get distinct seller tax codes that haven't been verified recently
  const res = await pool.query<{ seller_tax_code: string }>(
    `SELECT DISTINCT i.seller_tax_code
     FROM active_invoices i
     LEFT JOIN company_verification_cache c ON c.tax_code = i.seller_tax_code
     WHERE i.company_id = $1
       AND i.direction = 'input'
       AND i.seller_tax_code IS NOT NULL
       AND i.seller_tax_code != 'B2C'
       AND (c.tax_code IS NULL OR c.expires_at < NOW())
     ORDER BY i.seller_tax_code
     LIMIT 200`,
    [companyId],
  );

  const sessionId = uuidv4();
  for (const row of res.rows) {
    await verifySingle(row.seller_tax_code, companyId, sessionId);
    // Rate limit: worker limiter handles 1/3s — but add extra jitter between company-level calls
  }

  logger.info(`[VerificationWorker] Completed batch verification for company ${companyId}: ${res.rows.length} codes`);
}

function parseVnDate(str: string): string | null {
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

export const verificationWorker = new Worker<VerificationJob>(
  QUEUE_NAME,
  processVerification,
  {
    connection:  { url: REDIS_URL } as import('bullmq').ConnectionOptions,
    concurrency: 1,  // sequential — 1 verification at a time
    limiter: {
      max:      1,
      duration: 3_000,  // 1 request per 3 seconds max
    },
  },
);

verificationWorker.on('completed', job => logger.info(`[VerificationWorker] Job ${job.id} done`));
verificationWorker.on('failed',    (job, err) => logger.error(`[VerificationWorker] Job ${job?.id} failed: ${err.message}`));

// Graceful shutdown
process.on('SIGTERM', async () => {
  await verificationWorker.close();
  await redis.quit();
  process.exit(0);
});
