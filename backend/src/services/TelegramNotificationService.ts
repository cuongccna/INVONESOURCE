import { pool } from '../db/pool';
import { env } from '../config/env';

export type TelegramEvent =
  | 'debt_due'
  | 'vat_deadline'
  | 'price_increase'
  | 'sync_error'
  | 'new_declaration';

export interface TelegramChatConfig {
  id: string;
  company_id: string;
  chat_id: string;
  chat_type: 'private' | 'group';
  subscribed_events: TelegramEvent[];
  is_active: boolean;
  created_at: string;
}

export class TelegramNotificationService {
  private get botToken(): string | undefined {
    return env.TELEGRAM_BOT_TOKEN;
  }

  isEnabled(): boolean {
    return !!this.botToken;
  }

  async sendMessage(chatId: string, text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async sendToCompany(companyId: string, event: TelegramEvent, text: string): Promise<void> {
    const { rows } = await pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM telegram_chat_configs
       WHERE company_id = $1
         AND is_active = true
         AND subscribed_events ? $2`,
      [companyId, event],
    );
    for (const row of rows) {
      await this.sendMessage(row.chat_id, text);
    }
  }

  // ─── Formatted message helpers ───────────────────────────────────────────
  buildDebtDueMessage(companyName: string, items: Array<{ name: string; amount: number; invoiceNumber: string }>): string {
    const total = items.reduce((s, i) => s + i.amount, 0);
    const lines = items.map((i) => `• ${i.name}: <b>${i.amount.toLocaleString('vi-VN')}đ</b> (HĐ #${i.invoiceNumber})`).join('\n');
    return `💰 <b>Đến hạn thu tiền hôm nay</b>\nCông ty: ${companyName}\n${lines}\nTổng: <b>${total.toLocaleString('vi-VN')}đ</b>`;
  }

  buildVatDeadlineMessage(companyName: string, daysLeft: number, period: string, vatAmount: number): string {
    return `📅 <b>Nhắc nộp tờ khai thuế</b>\nCông ty: ${companyName}\nCòn <b>${daysLeft} ngày</b> đến hạn nộp tờ khai ${period}\nVAT phải nộp: <b>${vatAmount.toLocaleString('vi-VN')}đ</b>`;
  }

  buildPriceAlertMessage(itemName: string, supplierName: string, prevPrice: number, currPrice: number, changePct: number): string {
    const sign = changePct > 0 ? '+' : '';
    return `⚠️ <b>Giá NCC tăng</b>\nMặt hàng: ${itemName}\nNCC: ${supplierName}\nTháng trước: ${prevPrice.toLocaleString('vi-VN')}đ → Tháng này: <b>${currPrice.toLocaleString('vi-VN')}đ (${sign}${changePct.toFixed(1)}%)</b>`;
  }

  buildSyncErrorMessage(companyName: string, provider: string, error: string): string {
    return `❌ <b>Lỗi đồng bộ hóa đơn</b>\nCông ty: ${companyName}\nNhà cung cấp: ${provider}\nLỗi: ${error}`;
  }

  // ─── Config CRUD ─────────────────────────────────────────────────────────
  async getConfigs(companyId: string): Promise<TelegramChatConfig[]> {
    const { rows } = await pool.query<TelegramChatConfig>(
      `SELECT * FROM telegram_chat_configs WHERE company_id = $1 ORDER BY created_at`,
      [companyId],
    );
    return rows;
  }

  async upsertConfig(
    companyId: string,
    chatId: string,
    chatType: 'private' | 'group',
    subscribedEvents: TelegramEvent[],
  ): Promise<TelegramChatConfig> {
    const { rows } = await pool.query<TelegramChatConfig>(
      `INSERT INTO telegram_chat_configs (company_id, chat_id, chat_type, subscribed_events, is_active)
       VALUES ($1, $2, $3, $4::jsonb, true)
       ON CONFLICT (company_id, chat_id) DO UPDATE SET
         chat_type = EXCLUDED.chat_type,
         subscribed_events = EXCLUDED.subscribed_events,
         is_active = true
       RETURNING *`,
      [companyId, chatId, chatType, JSON.stringify(subscribedEvents)],
    );
    return rows[0];
  }

  async updateActive(companyId: string, chatId: string, isActive: boolean): Promise<void> {
    await pool.query(
      `UPDATE telegram_chat_configs SET is_active = $3 WHERE company_id = $1 AND chat_id = $2`,
      [companyId, chatId, isActive],
    );
  }

  async deleteConfig(companyId: string, chatId: string): Promise<void> {
    await pool.query(
      `DELETE FROM telegram_chat_configs WHERE company_id = $1 AND chat_id = $2`,
      [companyId, chatId],
    );
  }
}

export const telegramService = new TelegramNotificationService();
