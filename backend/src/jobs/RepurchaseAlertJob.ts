import { Queue, Worker } from 'bullmq';
import { env } from '../config/env';
import { pool } from '../db/pool';
import { BurnRateService } from '../services/BurnRateService';
import { telegramService } from '../services/TelegramNotificationService';

const QUEUE_NAME = 'repurchase-alerts';
const JOB_NAME = 'daily-repurchase-alerts';

// 07:00 ICT = 00:00 UTC
const CRON_UTC_00 = '0 0 * * *';

const burnRateService = new BurnRateService();

export const repurchaseAlertQueue = new Queue(QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 7,
    removeOnFail: 30,
  },
});

const repurchaseAlertWorker = new Worker(
  QUEUE_NAME,
  async () => {
    const { rows: companies } = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM companies',
    );

    for (const company of companies) {
      try {
        await burnRateService.calculateBurnRate(company.id);

        const { rows: due } = await pool.query<{
          id: string;
          buyer_name: string | null;
          buyer_tax_code: string;
          display_item_name: string | null;
          predicted_next_date: string;
          days_until_predicted: number;
        }>(
          `SELECT id, buyer_name, buyer_tax_code, display_item_name,
                  predicted_next_date::text, days_until_predicted
           FROM repurchase_predictions
           WHERE company_id = $1
             AND is_actioned = false
             AND confidence IN ('high', 'medium')
             AND days_until_predicted BETWEEN 3 AND 7
             AND (alert_sent_at IS NULL OR alert_sent_at < NOW() - INTERVAL '2 days')
           ORDER BY days_until_predicted ASC
           LIMIT 20`,
          [company.id],
        );

        if (due.length === 0) continue;

        const title = 'Khach sap den chu ky mua lai';
        const body = `Co ${due.length} khach co kha nang mua lai trong 3-7 ngay toi. Vao CRM/Repurchase de xu ly.`;

        const { rows: users } = await pool.query<{ user_id: string }>(
          'SELECT user_id FROM user_companies WHERE company_id = $1',
          [company.id],
        );

        for (const user of users) {
          await pool.query(
            `INSERT INTO notifications (company_id, user_id, type, title, body, data)
             VALUES ($1, $2, 'REPURCHASE_ALERT', $3, $4, $5::jsonb)`,
            [company.id, user.user_id, title, body, JSON.stringify({ count: due.length })],
          );
        }

        const telegramLines = due.slice(0, 5).map((d) => (
          `- ${d.buyer_name ?? d.buyer_tax_code} | ${d.display_item_name ?? 'N/A'} | ${d.days_until_predicted} ngay`
        ));
        const telegramText = [
          'Canh bao mua lai (3-7 ngay):',
          ...telegramLines,
        ].join('\n');

        await telegramService.sendToCompany(company.id, 'debt_due', telegramText);

        await pool.query(
          `UPDATE repurchase_predictions SET alert_sent_at = NOW()
           WHERE company_id = $1 AND id = ANY($2::uuid[])`,
          [company.id, due.map((d) => d.id)],
        );
      } catch (err) {
        console.error(`[RepurchaseAlertJob] company=${company.id} failed:`, (err as Error).message);
      }
    }
  },
  { connection: { url: env.REDIS_URL }, concurrency: 1 },
);

repurchaseAlertWorker.on('failed', (job, err) => {
  console.error(`[RepurchaseAlertJob] Job ${job?.id ?? '?'} failed:`, err.message);
});

export async function scheduleRepurchaseAlertJob(): Promise<void> {
  const existing = await repurchaseAlertQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === JOB_NAME) {
      await repurchaseAlertQueue.removeRepeatableByKey(job.key);
    }
  }

  await repurchaseAlertQueue.add(
    JOB_NAME,
    {},
    {
      repeat: { pattern: CRON_UTC_00, tz: 'UTC' },
      jobId: JOB_NAME,
    },
  );

  console.info('[RepurchaseAlertJob] Scheduled - daily at 07:00 ICT (00:00 UTC)');
}
