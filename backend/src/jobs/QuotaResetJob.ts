/**
 * QuotaResetJob — resets monthly invoice quota for all active/trial subscriptions
 * Runs: 1st of every month at 00:00 UTC (= 07:00 ICT)
 */
import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { quotaService } from '../services/QuotaService';

const QUEUE_NAME = 'quota-reset';
const JOB_NAME   = 'monthly-quota-reset';

// 00:00 UTC on the 1st of every month
const CRON = '0 0 1 * *';

export const quotaResetQueue = new Queue(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 3,
    removeOnFail: 7,
  },
});

const quotaResetWorker = new Worker(
  QUEUE_NAME,
  async () => {
    const count = await quotaService.resetAllMonthlyQuotas();
    console.info(`[QuotaResetJob] Reset quota for ${count} subscriptions`);
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 1,
  },
);

quotaResetWorker.on('failed', (job, err) => {
  console.error(`[QuotaResetJob] Job ${job?.id} failed:`, err);
});

export async function scheduleQuotaReset(): Promise<void> {
  // Remove stale repeatable jobs first to avoid duplicates on restart
  const repeatables = await quotaResetQueue.getRepeatableJobs();
  for (const job of repeatables) {
    await quotaResetQueue.removeRepeatableByKey(job.key);
  }

  await quotaResetQueue.add(
    JOB_NAME,
    {},
    { repeat: { pattern: CRON, tz: 'UTC' } },
  );

  console.info('[QuotaResetJob] Cron scheduled (0 0 1 * * UTC)');
}
