/**
 * Chẩn đoán kết nối GDT tự động — mỗi ngày một lần trong giờ hành chính (giờ VN).
 *
 * Tick mỗi 10 phút; lần tick đầu tiên rơi vào khung [bot.daily_diagnose_hour, 17h) sẽ
 * giành khoá Redis của ngày hôm đó (SET NX) và đưa các công ty đang bật bot vào queue
 * gdt-diagnose, giãn cách nhau vài phút để không dồn đăng nhập lên GDT.
 * Bot restart giữa ngày vẫn chạy bù nếu hôm đó chưa chạy.
 *
 * Bỏ qua:
 *   - công ty có bot đang TẮT (thường do GDT báo sai tài khoản — thử lại mỗi ngày có thể
 *     làm GDT khoá tài khoản; dashboard đọc thẳng trạng thái từ gdt_bot_configs)
 *   - công ty đang có phiên đồng bộ chạy (chính phiên đó phản ánh tình trạng kết nối)
 *
 * Kết quả được worker ghi vào gdt_connection_checks → dashboard hiển thị khi có lỗi.
 */
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { pool } from '../db';
import { logger } from '../logger';
import { cfg } from '../config/ConfigStore';

const REDIS_URL       = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const OFFICE_END_HOUR = 17;
const SPACING_MS      = 2 * 60_000;   // 2 phút giữa hai công ty
const JITTER_MS       = 60_000;

const _redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const _queue = new Queue('gdt-diagnose', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

/** Ngày (YYYY-MM-DD) và giờ hiện tại theo giờ Việt Nam (UTC+7). */
function vnNow(): { date: string; hour: number } {
  const vn = new Date(Date.now() + 7 * 3600_000);
  return { date: vn.toISOString().slice(0, 10), hour: vn.getUTCHours() };
}

export async function runDailyGdtDiagnoseTick(): Promise<void> {
  try {
    if (cfg.number('bot.daily_diagnose_enabled', 1) !== 1) return;
    const startHour = cfg.number('bot.daily_diagnose_hour', 9);
    const { date, hour } = vnNow();
    if (hour < startHour || hour >= OFFICE_END_HOUR) return;

    // Một lần mỗi ngày, kể cả khi bot restart (khoá sống 36h cho chắc).
    const claimed = await _redis.set(`gdt:diag:daily:${date}`, String(Date.now()), 'EX', 36 * 3600, 'NX');
    if (claimed !== 'OK') return;

    const res = await pool.query<{ company_id: string }>(
      `SELECT b.company_id
       FROM gdt_bot_configs b
       JOIN companies c ON c.id = b.company_id AND c.deleted_at IS NULL
       WHERE b.is_active = true
       ORDER BY b.company_id`,
    );

    let queued = 0;
    for (const { company_id: companyId } of res.rows) {
      if (await _redis.exists(`bot:sync:lock:${companyId}`)) continue;
      const delay = queued * SPACING_MS + Math.floor(Math.random() * JITTER_MS);
      await _queue.add('diagnose', { companyId, source: 'daily' }, {
        jobId:            `diag-daily-${date}-${companyId}`,
        delay,
        attempts:         1,
        removeOnComplete: { age: 3 * 86400, count: 500 },
        removeOnFail:     { age: 3 * 86400, count: 500 },
      });
      queued++;
    }
    logger.info('[DailyGdtDiagnose] Đã lên lịch chẩn đoán hằng ngày', { date, companies: queued });
  } catch (err) {
    logger.warn('[DailyGdtDiagnose] Tick lỗi (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}
