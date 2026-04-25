import webpush from 'web-push';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { v4 as uuidv4 } from 'uuid';

// Configure VAPID
webpush.setVapidDetails(
  `mailto:${env.VAPID_EMAIL}`,
  env.VAPID_PUBLIC_KEY,
  env.VAPID_PRIVATE_KEY
);

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  url?: string;
  data?: Record<string, unknown>;
}

/**
 * PushService — sends Web Push notifications via VAPID to all user subscriptions.
 * Automatically removes expired/invalid subscriptions (410 Gone).
 */
export class PushService {
  async pushToUser(userId: string, payload: PushPayload): Promise<void> {
    const { rows: subscriptions } = await pool.query<{
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );

    if (subscriptions.length === 0) return;

    const notification = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: payload.icon ?? '/icons/icon-192x192.png',
      badge: payload.badge ?? '/icons/badge-72x72.png',
      data: {
        url: payload.url ?? '/',
        ...payload.data,
      },
    });

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            notification
          );
        } catch (err: unknown) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            // Subscription expired — remove from DB
            await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
          } else {
            console.error(`[PushService] Failed to push to ${sub.endpoint}:`, (err as Error).message);
          }
        }
      })
    );
  }

  async pushToCompany(companyId: string, payload: PushPayload): Promise<void> {
    const { rows } = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM user_companies WHERE company_id = $1',
      [companyId]
    );
    await Promise.allSettled(rows.map((r) => this.pushToUser(r.user_id, payload)));
  }
}

export const pushService = new PushService();

/**
 * NotificationService — creates DB notification records + triggers Web Push
 */
export class NotificationService {
  private push = pushService;

  private async createAndPush(
    companyId: string,
    type: string,
    title: string,
    body: string,
    url?: string
  ): Promise<void> {
    // Get company users
    const { rows: users } = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM user_companies WHERE company_id = $1',
      [companyId]
    );

    const insertedIds: string[] = [];

    for (const user of users) {
      const notifId = uuidv4();
      await pool.query(
        `INSERT INTO notifications (id, company_id, user_id, type, title, body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [notifId, companyId, user.user_id, type, title, body]
      );
      insertedIds.push(notifId);

      await this.push.pushToUser(user.user_id, { title, body, url });
    }

    // Mark exactly these notifications as push_sent (no time-window race condition)
    if (insertedIds.length > 0) {
      await pool.query(
        `UPDATE notifications SET push_sent = true WHERE id = ANY($1::uuid[])`,
        [insertedIds]
      );
    }
  }

  async onSyncComplete(companyId: string, provider: string, count: number): Promise<void> {
    const providerName = provider === 'gdt_intermediary' ? 'GDT' : provider;
    await this.createAndPush(
      companyId,
      'SYNC_COMPLETE',
      'Đồng bộ hoàn tất',
      `Đồng bộ xong ${count} hóa đơn từ ${providerName}`,
      '/invoices'
    );
  }

  async onSyncCountWarning(companyId: string, expected: number, actual: number, missing: number): Promise<void> {
    await this.createAndPush(
      companyId,
      'SYNC_COUNT_WARNING',
      '⚠️ Hóa đơn bị thiếu sau đồng bộ',
      `GDT có ${expected.toLocaleString('vi-VN')} HĐ nhưng chỉ tải được ${actual.toLocaleString('vi-VN')}. Còn thiếu ${missing.toLocaleString('vi-VN')} HĐ — vui lòng đồng bộ lại.`,
      '/settings/bot'
    );
  }

  async onInvalidInvoicesFound(companyId: string, count: number): Promise<void> {
    await this.createAndPush(
      companyId,
      'INVALID_INVOICES',
      'Hóa đơn không hợp lệ',
      `⚠️ Phát hiện ${count} hóa đơn không hợp lệ`,
      '/invoices?status=invalid'
    );
  }

  async onTaxDeadlineApproaching(
    companyId: string,
    daysLeft: number,
    month: number
  ): Promise<void> {
    await this.createAndPush(
      companyId,
      'TAX_DEADLINE',
      'Sắp đến hạn nộp thuế',
      `📅 Còn ${daysLeft} ngày đến hạn nộp tờ khai tháng ${month}`,
      '/declarations'
    );
  }

  async onConnectorError(companyId: string, provider: string): Promise<void> {
    const providerName = provider === 'gdt_intermediary' ? 'GDT' : provider;
    await this.createAndPush(
      companyId,
      'CONNECTOR_ERROR',
      `Mất kết nối ${providerName}`,
      `🔴 Mất kết nối ${providerName} — cần xác thực lại`,
      '/settings/connectors'
    );
  }

  /**
   * Gửi thông báo khẩn khi bot bị lỗi đăng nhập GDT không thể phục hồi.
   * Bot đã tự động dừng để tránh bị khóa tài khoản thêm.
   * User cần vào Cài đặt > Bot để xem lỗi và cập nhật mật khẩu.
   */
  async onBotAuthFailure(companyId: string, errorMessage: string): Promise<void> {
    await this.createAndPush(
      companyId,
      'BOT_AUTH_FAILURE',
      '🚨 Bot GDT: Lỗi đăng nhập nghiêm trọng',
      `Bot đã dừng tự động để bảo vệ tài khoản. Lỗi: ${errorMessage.slice(0, 120)}`,
      '/settings/bot'
    );
  }

  async onVatAnomaly(companyId: string, message: string): Promise<void> {
    await this.createAndPush(
      companyId,
      'VAT_ANOMALY',
      'Bất thường VAT',
      `⚠️ ${message}`,
      '/dashboard'
    );
  }
}

export const notificationService = new NotificationService();

/**
 * Tax deadline reminder — check daily at 8am.
 * Alert at 7 days and 2 days before the 20th of next month.
 */
export async function checkTaxDeadlines(): Promise<void> {
  const today = new Date();
  const currentMonth = today.getMonth() + 1;
  const currentYear = today.getFullYear();

  // Deadline is the 20th of the following month
  const deadlineMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const deadlineYear = currentMonth === 12 ? currentYear + 1 : currentYear;
  const deadline = new Date(deadlineYear, deadlineMonth - 1, 20);
  const daysLeft = Math.ceil((deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysLeft !== 7 && daysLeft !== 2) return;

  const { rows: companies } = await pool.query('SELECT id FROM companies');
  for (const company of companies) {
    await notificationService.onTaxDeadlineApproaching(company.id, daysLeft, currentMonth);
  }
}
