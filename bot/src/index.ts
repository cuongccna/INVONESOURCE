/**
 * BOT-01 entry point
 */
import 'dotenv/config';
import { worker, manualWorker, autoWorker, flushStaleLocks } from './sync.worker';
import { proxyManager } from './proxy-manager';
import { logger } from './logger';

logger.info('[Bot] GDT Crawler Bot starting', {
  concurrency: process.env['WORKER_CONCURRENCY'] ?? '2',
  proxies:     proxyManager.size,
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',
});

// Flush any locks left by a previous crashed/killed process
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
