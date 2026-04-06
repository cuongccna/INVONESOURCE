/**
 * Phase 7 — GDT Canary Health Check
 *
 * Runs every 15 minutes. Uses a dedicated canary account (GDT_CANARY_COMPANY_ID)
 * to call prefetchCount() — no full fetch, no DB writes.
 *
 * Redis state:
 *   gdt:health:failures    — incremented on each failed check, TTL 3600s
 *   gdt:health:last_count  — last known invoice count (to detect structural changes)
 *
 * Alerts:
 *   - 5+ failures in 1 hour  →  push message to sync-notifications queue (admin alert)
 *   - count === 0 when last known > 0  →  possible GDT structural change
 *   - Successful check resets failure counter
 */
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { decryptCredentials } from '../encryption.service';
import { GdtDirectApiService } from '../gdt-direct-api.service';
import { logger } from '../logger';

const REDIS_URL               = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const GDT_CANARY_COMPANY_ID   = process.env['GDT_CANARY_COMPANY_ID'] ?? '';

const HEALTH_FAILURES_KEY     = 'gdt:health:failures';
const HEALTH_LAST_COUNT_KEY   = 'gdt:health:last_count';
const HEALTH_FAILURES_TTL     = 3600;    // 1-hour sliding window
const HEALTH_ALERT_THRESHOLD  = 5;

const _redis = new Redis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
const _notifQueue = new Queue('sync-notifications', {
  connection: { url: REDIS_URL } as import('bullmq').ConnectionOptions,
});

/** Returns the current consecutive failure count within the rolling 1-hour window. */
async function getFailureCount(): Promise<number> {
  const raw = await _redis.get(HEALTH_FAILURES_KEY).catch(() => null);
  return raw ? parseInt(raw, 10) : 0;
}

async function incrementFailures(): Promise<number> {
  const pipe = _redis.pipeline();
  pipe.incr(HEALTH_FAILURES_KEY);
  pipe.expire(HEALTH_FAILURES_KEY, HEALTH_FAILURES_TTL);
  const results = await pipe.exec().catch(() => null);
  return (results?.[0]?.[1] as number) ?? 0;
}

async function resetFailures(): Promise<void> {
  await _redis.del(HEALTH_FAILURES_KEY).catch(() => {});
}

async function sendAdminAlert(reason: string): Promise<void> {
  try {
    await _notifQueue.add('admin-alert', {
      id:        uuidv4(),
      type:      'GDT_HEALTH_ALERT',
      reason,
      timestamp: new Date().toISOString(),
    });
    logger.warn('[GdtHealthCheck] Admin alert đã gửi', { reason });
  } catch (e) {
    logger.warn('[GdtHealthCheck] Gửi alert thất bại (non-fatal)', { error: (e as Error).message });
  }
}

/**
 * Main health check — runs every 15 minutes.
 * isEnabled() = false when GDT_CANARY_COMPANY_ID is not configured → graceful skip.
 */
export async function runGdtHealthCheck(): Promise<void> {
  if (!GDT_CANARY_COMPANY_ID) {
    logger.debug('[GdtHealthCheck] GDT_CANARY_COMPANY_ID chưa cấu hình — bỏ qua');
    return;
  }

  try {
    await _redis.connect().catch(() => { /* already connected */ });

    // Load canary company credentials from DB
    const cfgRes = await pool.query(
      `SELECT encrypted_credentials, tax_code
       FROM gdt_bot_configs
       WHERE company_id = $1 AND is_active = true
       LIMIT 1`,
      [GDT_CANARY_COMPANY_ID],
    );

    if (cfgRes.rows.length === 0) {
      logger.warn('[GdtHealthCheck] Không tìm thấy config cho canary company', {
        companyId: GDT_CANARY_COMPANY_ID,
      });
      return;
    }

    const cfg = cfgRes.rows[0] as { encrypted_credentials: string; tax_code: string };
    const creds = await decryptCredentials(cfg.encrypted_credentials) as {
      username: string;
      password: string;
    };

    // Instantiate service WITHOUT proxy (canary runs direct)
    const svc = new GdtDirectApiService(null, null, undefined, GDT_CANARY_COMPANY_ID, null);
    await svc.login(creds.username, creds.password, false);

    const today     = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const count = await svc.prefetchCount('sold', monthStart, today);

    if (count === -1) {
      // prefetchCount failed — treat as health failure
      const failures = await incrementFailures();
      logger.warn('[GdtHealthCheck] prefetchCount thất bại', { failures, companyId: GDT_CANARY_COMPANY_ID });

      if (failures >= HEALTH_ALERT_THRESHOLD) {
        await sendAdminAlert(`GDT API không phản hồi: ${failures} lần thất bại trong 1 giờ`);
      }
      return;
    }

    // Detect structural change: count dropped to 0 but last known > 0
    const lastCountRaw = await _redis.get(HEALTH_LAST_COUNT_KEY).catch(() => null);
    const lastCount = lastCountRaw ? parseInt(lastCountRaw, 10) : -1;
    if (count === 0 && lastCount > 0) {
      await sendAdminAlert(
        `GDT có thể đã thay đổi cấu trúc: lần trước ${lastCount} hóa đơn, hiện tại 0`,
      );
    }

    // Save last known count
    await _redis.set(HEALTH_LAST_COUNT_KEY, String(count), 'EX', 7 * 24 * 3600).catch(() => {});

    // Success — reset failure counter
    await resetFailures();
    logger.info('[GdtHealthCheck] GDT hoạt động bình thường', {
      companyId: GDT_CANARY_COMPANY_ID,
      invoiceCount: count,
    });

  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const failures = await incrementFailures();
    logger.error('[GdtHealthCheck] Health check lỗi', {
      companyId: GDT_CANARY_COMPANY_ID,
      error: msg,
      failures,
    });

    if (failures >= HEALTH_ALERT_THRESHOLD) {
      await sendAdminAlert(`GDT health check lỗi ${failures} lần: ${msg.slice(0, 200)}`);
    }
  }
}
