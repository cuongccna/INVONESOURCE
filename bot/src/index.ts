/**
 * BOT-01 entry point
 */
import 'dotenv/config';
import Redis from 'ioredis';
import { proxyManager } from './proxy-manager';
import { logger } from './logger';
import { runGdtHealthCheck } from './cron/gdt-health-check';
import { runAutoSyncCycle } from './cron/auto-sync';
import { pool } from './db';

const BOT_WORKER_HEARTBEAT_KEY = 'bot:worker:heartbeat';
const BOT_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
const BOT_WORKER_HEARTBEAT_TTL_SEC = 45;

const heartbeatRedis = new Redis(process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: 3,
});

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function writeBotHeartbeat(): Promise<void> {
  try {
    await heartbeatRedis.set(
      BOT_WORKER_HEARTBEAT_KEY,
      JSON.stringify({ pid: process.pid, updatedAt: new Date().toISOString() }),
      'EX',
      BOT_WORKER_HEARTBEAT_TTL_SEC,
    );
  } catch (err) {
    logger.warn('[Bot] Heartbeat update failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function startBotHeartbeat(): void {
  void writeBotHeartbeat();
  heartbeatTimer = setInterval(() => {
    void writeBotHeartbeat();
  }, BOT_WORKER_HEARTBEAT_INTERVAL_MS);
}

async function stopBotHeartbeat(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  await heartbeatRedis.del(BOT_WORKER_HEARTBEAT_KEY).catch(() => undefined);
  await heartbeatRedis.quit().catch(() => undefined);
}

logger.info('[Bot] GDT Crawler Bot starting', {
  concurrency: process.env['WORKER_CONCURRENCY'] ?? '2',
  proxies:     proxyManager.size,
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',
});

startBotHeartbeat();

// Đợi ít nhất một slot proxy sẵn sàng trước khi workers được tạo/resume.
// Tránh race condition khởi động: tất cả slot trả null trong 2–5 giây đầu
void (async () => {
  await proxyManager.waitUntilReady();

  // Dynamic import workers AFTER proxy is ready so they won't accept jobs
  const sw = await import('./sync.worker');
  const { worker, manualWorker, autoWorker, flushStaleLocks } = sw;

  // Flush locks cũ chỉ sau khi proxy xác nhận sẵn sàng
  void flushStaleLocks();

  // Legacy worker (gdt-bot-sync) — processes older queued jobs from sync.ts /start
  worker.on('ready', () => {
    logger.info('[Bot] Legacy worker ready — gdt-bot-sync queue');
  });

  // Manual worker — user-triggered syncs, high concurrency + priority
  manualWorker.on('ready', () => {
    logger.info('[Bot] Manual worker ready — gdt-sync-manual queue (concurrency 10)');
  });

  // Auto worker — background scheduled syncs, conservative concurrency
  autoWorker.on('ready', () => {
    logger.info('[Bot] Auto worker ready — gdt-sync-auto queue (concurrency 2)');
  });

  // Graceful shutdown — drain all three workers before exiting
  async function shutdown(signal: string): Promise<void> {
    logger.info(`[Bot] ${signal} received, graceful shutdown...`);
    await Promise.all([
      worker.close(),
      manualWorker.close(),
      autoWorker.close(),
      stopBotHeartbeat(),
    ]);
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  // Auto-sync scheduler — checks every 5 minutes for companies due for sync
  const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 min
  void runAutoSyncCycle(); // Run immediately on startup
  setInterval(() => void runAutoSyncCycle(), AUTO_SYNC_INTERVAL_MS);
  logger.info('[Bot] Auto-sync scheduler started — polling every 5 min');
})();

// Phase 7: GDT canary health check every 15 minutes
// Runs prefetchCount on dedicated canary account — no DB writes.
// GDT_CANARY_COMPANY_ID env must be set; otherwise silently skipped.
const HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
void runGdtHealthCheck(); // Run immediately on startup
setInterval(() => void runGdtHealthCheck(), HEALTH_CHECK_INTERVAL_MS);

// BOT-REFACTOR-04: Daily cleanup — delete done/skipped detail queue rows older than 7 days.
// This runs in index.ts (invone-bot process) so detail.worker stays simple (no scheduler).
const DETAIL_QUEUE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
async function cleanupDetailQueue(): Promise<void> {
  try {
    const res = await pool.query(
      `DELETE FROM invoice_detail_queue
       WHERE status IN ('done','skipped')
         AND done_at < NOW() - INTERVAL '7 days'`,
    );
    if ((res.rowCount ?? 0) > 0) {
      logger.info('[Scheduler] Detail queue cleanup', { deleted: res.rowCount });
    }
  } catch (err) {
    logger.warn('[Scheduler] Detail queue cleanup failed (non-fatal)', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
void cleanupDetailQueue(); // Run once on startup (catches any backlog)
setInterval(() => void cleanupDetailQueue(), DETAIL_QUEUE_CLEANUP_INTERVAL_MS);
