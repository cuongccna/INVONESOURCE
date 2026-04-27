import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { pool } from './db/pool';
import { requestIdMiddleware, errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRouter from './routes/auth';
import invoicesRouter from './routes/invoices';
import connectorsRouter from './routes/connectors';
import pushRouter from './routes/push';
import reconciliationRouter from './routes/reconciliation';
import reportsRouter from './routes/reports';
import declarationsRouter from './routes/declarations';
import aiRouter from './routes/ai';
import dashboardRouter from './routes/dashboard';
import companiesRouter from './routes/companies';
import notificationsRouter from './routes/notifications';
import portfolioRouter from './routes/portfolio';
import groupRouter from './routes/group';
import organizationsRouter from './routes/organizations';
import compareRouter from './routes/compare';
import crmRouter from './routes/crm';
import vendorsRouter from './routes/vendors';
import productsRouter from './routes/products';
import forecastRouter from './routes/forecast';
import cashflowRouter from './routes/cashflow';
import telegramRouter from './routes/telegram';
import esgRouter from './routes/esg';
import repurchaseRouter from './routes/repurchase';
import auditRouter from './routes/audit';
import insightsRouter from './routes/insights';
import importRouter from './routes/import';
import botRouter from './routes/bot';
import crawlerRecipesRouter from './routes/crawler-recipes';
import catalogsRouter from './routes/catalogs';
import inventoryRouter from './routes/inventory';
import cashBookRouter from './routes/cash-book';
import syncRouter from './routes/sync';
import journalsRouter from './routes/journals';
import profitLossRouter from './routes/profit-loss';
import hkdRouter from './routes/hkd';
import hkdReportsRouter from './routes/hkd-reports';
import { registry } from './connectors/ConnectorRegistry';
import { GdtIntermediaryConnector } from './connectors/GdtIntermediaryConnector';
import { scheduleSyncCron } from './jobs/SyncWorker';
import { gdtValidateWorker } from './jobs/GdtValidatorWorker';
import { scheduleTaxDeadlineReminder } from './jobs/TaxDeadlineReminderJob';
import { scheduleRepurchaseAlertJob } from './jobs/RepurchaseAlertJob';
// DISABLED: auto-sync scheduling moved to bot process (bot/src/cron/auto-sync.ts)
// import { scheduleGdtBotSync, gdtBotSchedulerWorker } from './jobs/GdtBotSchedulerJob';
import { scheduleQuotaReset } from './jobs/QuotaResetJob';
import { registerCatalogRebuildJob } from './jobs/CatalogRebuildJob';
import { syncNotificationWorker } from './jobs/SyncNotificationWorker';
import { gdtRawCacheSyncWorker } from './jobs/GdtRawCacheSyncWorker';
import { gdtRawCacheSchedulerWorker, scheduleGdtRawCacheSync } from './jobs/GdtRawCacheScheduler';
import adminRouter from './routes/admin';
import adminProxyRouter from './routes/admin-proxy';
import toolsRouter from './routes/tools';
import syncStatusRouter from './routes/syncStatus';
import indicatorConfigsRouter from './routes/indicatorConfigs';

const app = express();

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}



const fallbackOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const configuredOrigins = [
  env.APP_URL,
  ...(env.FRONTEND_URL ? [env.FRONTEND_URL] : []),
  ...(env.FRONTEND_URLS
    ? env.FRONTEND_URLS.split(',').map((o) => o.trim()).filter(Boolean)
    : []),
  ...fallbackOrigins,
];
const allowOriginSet = new Set(
  configuredOrigins
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean)
);

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server and non-browser requests (no Origin header)
    if (!origin) return callback(null, true);

    if (allowOriginSet.has(origin)) return callback(null, true);

    // Convenience for LAN testing in development
    if (env.NODE_ENV === 'development' && /^http:\/\/192\.168\.[0-9]{1,3}\.[0-9]{1,3}:3000$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(requestIdMiddleware);

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/companies', companiesRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/connectors', connectorsRouter);
app.use('/api/push', pushRouter);
app.use('/api/reconciliation', reconciliationRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/declarations', declarationsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/group', groupRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/crm', crmRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/products', productsRouter);
app.use('/api/forecast', forecastRouter);
app.use('/api/cashflow', cashflowRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/compare', compareRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/esg', esgRouter);
app.use('/api/crm/repurchase', repurchaseRouter);
app.use('/api/audit', auditRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/import', importRouter);
app.use('/api/bot', botRouter);
app.use('/api/crawler-recipes', crawlerRecipesRouter);
app.use('/api/catalogs', catalogsRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/cash-book', cashBookRouter);
app.use('/api/sync', syncRouter);
app.use('/api/journals', journalsRouter);
app.use('/api/reports/profit-loss', profitLossRouter);
app.use('/api/hkd', hkdRouter);
app.use('/api/hkd-reports', hkdReportsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/proxies', adminProxyRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/sync-status', syncStatusRouter);
app.use('/api/indicator-configs', indicatorConfigsRouter);

// Health check (unauthenticated)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Error handling ──────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Register connector plugins ─────────────────────────────────────────────
function registerPlugins(): void {
  registry.register(new GdtIntermediaryConnector());
  console.info('[Connectors] Registered plugins:', registry.getAll().map((p) => p.id));
}

// ─── Start ──────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Verify DB connection
  await pool.query('SELECT 1');
  console.info('[DB] Connected to PostgreSQL');

  registerPlugins();

  // Start BullMQ workers
  await scheduleSyncCron();
  // gdtValidateWorker is auto-started on import
  void gdtValidateWorker;
  // DISABLED: auto-sync scheduling moved to bot process (bot/src/cron/auto-sync.ts)
  // void gdtBotSchedulerWorker;
  // await scheduleGdtBotSync();
  // Notification bridge: processes push notifications enqueued by bot worker
  void syncNotificationWorker;  // auto-started on import
  await scheduleTaxDeadlineReminder();
  await scheduleRepurchaseAlertJob();
  await scheduleQuotaReset();
  await registerCatalogRebuildJob();
  // GDT Raw Cache layer — background pre-fetch + change detection
  void gdtRawCacheSyncWorker;         // auto-started on import
  void gdtRawCacheSchedulerWorker;    // auto-started on import
  await scheduleGdtRawCacheSync();
  console.info('[Jobs] BullMQ workers started');

  app.listen(env.API_PORT, () => {
    console.info(`[Server] Listening on port ${env.API_PORT} (${env.NODE_ENV})`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
