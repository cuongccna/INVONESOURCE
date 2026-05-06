/**
 * GhostScanJob — Tự động quét rủi ro nhà cung cấp định kỳ.
 *
 * Chạy mỗi 6 giờ. Chỉ quét các công ty có hóa đơn mới kể từ lần quét cuối
 * (hoặc chưa bao giờ quét). Stagger 30s giữa mỗi công ty để tránh overload.
 *
 * CompanyVerificationService cache 30 ngày → hầu hết lần chạy không hit external API.
 */

import { pool } from '../db/pool';
import { ghostCompanyDetector } from '../services/GhostCompanyDetector';
import { cfg } from '../config/ConfigStore';

const SCAN_INTERVAL_MS = () => cfg.number('ghost_scan.interval_ms', 6 * 60 * 60 * 1_000); // 6h
const STAGGER_MS       = 30_000; // 30s giữa mỗi công ty
const MAX_PER_RUN      = 20;     // tối đa 20 công ty mỗi lần chạy

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;

async function runGhostScan(): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    // Tìm các công ty có hóa đơn mới hoặc chưa từng quét
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT DISTINCT i.company_id
       FROM invoices i
       LEFT JOIN (
         SELECT company_id, MAX(updated_at) AS last_scan
         FROM company_risk_flags
         GROUP BY company_id
       ) crf ON crf.company_id = i.company_id
       WHERE i.deleted_at IS NULL
         AND i.direction = 'input'
         AND (
           crf.last_scan IS NULL
           OR i.created_at > crf.last_scan
         )
       LIMIT $1`,
      [MAX_PER_RUN],
    );

    if (rows.length === 0) return;
    console.info(`[GhostScanJob] Sẽ quét ${rows.length} công ty`);

    for (const row of rows) {
      await new Promise(r => setTimeout(r, STAGGER_MS));
      try {
        const result = await ghostCompanyDetector.runForCompany(row.company_id);
        console.info(`[GhostScanJob] ${row.company_id}: quét ${result.scanned} vendor, ${result.flagged} cờ rủi ro`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[GhostScanJob] Lỗi công ty ${row.company_id}: ${msg}`);
      }
    }
  } catch (err) {
    console.error('[GhostScanJob] Lỗi run:', err);
  } finally {
    _running = false;
  }
}

export function scheduleGhostScan(): void {
  const loop = async () => {
    await runGhostScan();
    _timer = setTimeout(() => void loop(), SCAN_INTERVAL_MS());
  };

  // Chạy lần đầu sau 5 phút kể từ khi server khởi động (tránh overload startup)
  _timer = setTimeout(() => void loop(), 5 * 60 * 1_000);
  console.info('[GhostScanJob] Đã lên lịch auto-scan mỗi 6 giờ (bắt đầu sau 5 phút)');
}
