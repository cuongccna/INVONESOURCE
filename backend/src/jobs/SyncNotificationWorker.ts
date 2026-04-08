/**
 * SyncNotificationWorker — processes push notification jobs enqueued by the bot worker.
 *
 * The bot process (separate Node.js) cannot import NotificationService directly
 * (different codebase, no web-push dependency). Instead, the bot enqueues to the
 * 'sync-notifications' BullMQ queue, and this worker picks up and sends the push.
 *
 * Sau khi gửi push notification, worker tự động chạy:
 *   1. InvoiceValidationPipeline  → ghi invoice_validation_log (loại hóa đơn thay thế/hủy)
 *   2. TaxDeclarationEngine       → upsert vat_reconciliations + tax_declarations
 * để UI không cần thao tác thủ công sau mỗi lần sync.
 */
import { Worker, Job } from 'bullmq';
import { env } from '../config/env';
import { notificationService } from '../services/NotificationService';
import { TaxDeclarationEngine } from '../services/TaxDeclarationEngine';

interface SyncNotificationPayload {
  companyId: string;
  provider: string;
  count: number;
  /** Ngày bắt đầu kỳ đồng bộ (YYYY-MM-DD) — dùng để xác định quarter/year */
  fromDate?: string;
  /** Ngày kết thúc kỳ đồng bộ (YYYY-MM-DD) */
  toDate?: string;
}

/** Xác định quý từ chuỗi ngày YYYY-MM-DD */
function getQuarterFromDateStr(dateStr: string): { quarter: number; year: number } {
  const d = new Date(dateStr);
  const month = d.getMonth() + 1; // 1-12
  return { quarter: Math.ceil(month / 3), year: d.getFullYear() };
}

export const syncNotificationWorker = new Worker<SyncNotificationPayload>(
  'sync-notifications',
  async (job: Job<SyncNotificationPayload>) => {
    const { companyId, provider, count, fromDate, toDate } = job.data;

    // ── Bước 1: Gửi push notification ──────────────────────────────────────────
    await notificationService.onSyncComplete(companyId, provider, count);
    console.log(`[SyncNotificationWorker] Notification sent: ${count} invoices from ${provider} for company ${companyId}`);

    // ── Bước 2: Auto validation pipeline + recalc (non-fatal) ──────────────────
    if (count > 0 && (fromDate ?? toDate)) {
      try {
        const periodDate = fromDate ?? toDate!;
        const { quarter, year } = getQuarterFromDateStr(periodDate);

        console.log(`[SyncNotificationWorker] Auto-recalc Q${quarter}/${year} for company ${companyId}...`);

        const engine = new TaxDeclarationEngine();
        // calculateQuarterlyDeclaration chạy InvoiceValidationPipeline bên trong
        // rồi upsert vat_reconciliations và tax_declarations.
        await engine.calculateQuarterlyDeclaration(companyId, quarter, year);

        console.log(`[SyncNotificationWorker] Recalc hoàn tất Q${quarter}/${year} company ${companyId}`);
      } catch (err) {
        // Lỗi recalc KHÔNG được ảnh hưởng tới notification job — chỉ log
        console.error(`[SyncNotificationWorker] Auto-recalc thất bại (non-fatal)`, {
          companyId,
          err: (err as Error).message,
        });
      }
    }
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: 1, // Giảm xuống 1 để tránh race-condition khi nhiều company sync cùng lúc
  }
);

syncNotificationWorker.on('failed', (job, err) => {
  console.error(`[SyncNotificationWorker] Job ${job?.id} failed:`, err.message);
});
