/**
 * SyncNotificationWorker — processes push notification jobs enqueued by the bot worker.
 *
 * The bot process (separate Node.js) cannot import NotificationService directly
 * (different codebase, no web-push dependency). Instead, the bot enqueues to the
 * 'sync-notifications' BullMQ queue, and this worker picks up and sends the push.
 */
import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { notificationService } from '../services/NotificationService';

interface SyncNotificationPayload {
  companyId: string;
  provider: string;
  count: number;
}

export const syncNotificationWorker = new Worker<SyncNotificationPayload>(
  'sync-notifications',
  async (job: Job<SyncNotificationPayload>) => {
    const { companyId, provider, count } = job.data;
    await notificationService.onSyncComplete(companyId, provider, count);
    console.log(`[SyncNotificationWorker] Sent notification: ${count} invoices from ${provider} for company ${companyId}`);
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 5,
  }
);

syncNotificationWorker.on('failed', (job, err) => {
  console.error(`[SyncNotificationWorker] Job ${job?.id} failed:`, err.message);
});
