/**
 * TaxDeadlineReminderJob — BullMQ worker that fires daily at 08:00 Vietnam time (01:00 UTC).
 *
 * The job calls checkTaxDeadlines() which:
 *  - Finds all active companies
 *  - For companies that haven't filed, calculates days until the 20th of the following month
 *  - Sends in-app notifications at 7 days and 2 days before the deadline
 *
 * Using BullMQ instead of setTimeout ensures the schedule survives server restarts
 * and is stored persistently in Redis.
 */
import { Worker, Queue } from 'bullmq';
import { env } from '../config/env';
import { checkTaxDeadlines } from '../services/NotificationService';

const QUEUE_NAME = 'tax-deadline-reminders';
const JOB_NAME = 'daily-deadline-check';

// UTC cron for 08:00 ICT (UTC+7) = 01:00 UTC
// Format: second minute hour day month weekday
const CRON_UTC_01 = '0 1 * * *';

export const deadlineReminderQueue = new Queue(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 7,   // keep 7 days of history
    removeOnFail: 30,
  },
});

const deadlineWorker = new Worker(
  QUEUE_NAME,
  async (_job) => {
    console.info('[TaxDeadlineJob] Running daily deadline check...');
    await checkTaxDeadlines();
    console.info('[TaxDeadlineJob] Done.');
  },
  { connection: { url: env.REDIS_URL }, concurrency: 1 }
);

deadlineWorker.on('failed', (job, err) => {
  console.error(`[TaxDeadlineJob] Job ${job?.id ?? '?'} failed:`, err.message);
});

/**
 * Register the repeatable cron job in Redis (idempotent — safe to call on every server start).
 */
export async function scheduleTaxDeadlineReminder(): Promise<void> {
  // Remove any stale repeatable jobs with the same name to avoid duplicates
  const existing = await deadlineReminderQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === JOB_NAME) {
      await deadlineReminderQueue.removeRepeatableByKey(job.key);
    }
  }

  await deadlineReminderQueue.add(
    JOB_NAME,
    {},
    {
      repeat: { pattern: CRON_UTC_01, tz: 'UTC' },
      jobId: JOB_NAME,
    }
  );

  console.info('[TaxDeadlineJob] Scheduled — daily at 08:00 ICT (01:00 UTC)');
}
