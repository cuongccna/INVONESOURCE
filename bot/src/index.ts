/**
 * BOT-01 entry point
 */
import 'dotenv/config';
import { worker, flushStaleLocks } from './sync.worker';
import { proxyManager } from './proxy-manager';
import { logger } from './logger';

logger.info('[Bot] GDT Crawler Bot starting', {
  concurrency: process.env['WORKER_CONCURRENCY'] ?? '2',
  proxies:     proxyManager.size,
  nodeEnv:     process.env['NODE_ENV'] ?? 'development',
});

// Flush any locks left by a previous crashed/killed process
void flushStaleLocks();

worker.on('ready', () => {
  logger.info('[Bot] Worker ready — listening for jobs');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[Bot] SIGTERM received, graceful shutdown...');
  await worker.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('[Bot] SIGINT received, graceful shutdown...');
  await worker.close();
  process.exit(0);
});
