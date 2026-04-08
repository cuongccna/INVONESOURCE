/**
 * BOT-01 entry point
 */
import 'dotenv/config';
import { proxyManager } from './proxy-manager';
import { logger } from './logger';
import { runGdtHealthCheck } from './cron/gdt-health-check';

logger.info('[Bot] GDT Crawler Bot starting', {
  concurrency: process.env['WORKER_CONCURRENCY'] ?? '2',
  proxies:     proxyManager.size,
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',
});

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
    ]);
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
})();

// Phase 7: GDT canary health check every 15 minutes
// Runs prefetchCount on dedicated canary account — no DB writes.
// GDT_CANARY_COMPANY_ID env must be set; otherwise silently skipped.
const HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
void runGdtHealthCheck(); // Run immediately on startup
setInterval(() => void runGdtHealthCheck(), HEALTH_CHECK_INTERVAL_MS);
