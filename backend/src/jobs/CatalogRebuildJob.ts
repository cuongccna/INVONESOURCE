/**
 * CatalogRebuildJob — hourly auto-populate catalogs for all active bot companies.
 * Each company is processed non-fatally; one failure does not block others.
 */
import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { autoCodeService } from '../services/AutoCodeService';

const QUEUE_NAME = 'catalog-rebuild';
const JOB_NAME   = 'hourly-catalog-rebuild';
const CRON       = '0 * * * *'; // every hour

export const catalogRebuildQueue = new Queue(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: 3,
    removeOnFail: 7,
  },
});

const catalogRebuildWorker = new Worker(
  QUEUE_NAME,
  async () => {
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT DISTINCT company_id FROM gdt_bot_configs WHERE is_active = true`,
    );

    let successCount = 0;
    for (const { company_id } of rows) {
      try {
        await autoCodeService.rebuildCatalogs(company_id);
        successCount++;
      } catch (err) {
        console.error(`[CatalogRebuildJob] Failed for company ${company_id}:`, err);
      }
    }

    console.info(`[CatalogRebuildJob] Rebuilt catalogs for ${successCount}/${rows.length} companies`);
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 1,
  },
);

catalogRebuildWorker.on('failed', (job, err) => {
  console.error(`[CatalogRebuildJob] Worker job ${job?.id} failed:`, err);
});

/** Register the repeatable hourly cron. Call once on server startup. */
export async function registerCatalogRebuildJob(): Promise<void> {
  await catalogRebuildQueue.add(
    JOB_NAME,
    {},
    { repeat: { pattern: CRON } },
  );
}
