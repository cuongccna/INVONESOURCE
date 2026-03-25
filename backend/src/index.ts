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
import { registry } from './connectors/ConnectorRegistry';
import { MisaConnector } from './connectors/MisaConnector';
import { ViettelConnector } from './connectors/ViettelConnector';
import { BkavConnector } from './connectors/BkavConnector';
import { GdtIntermediaryConnector } from './connectors/GdtIntermediaryConnector';
import { scheduleSyncCron } from './jobs/SyncWorker';
import { gdtValidateWorker } from './jobs/GdtValidatorWorker';
import { scheduleTaxDeadlineReminder } from './jobs/TaxDeadlineReminderJob';
import { scheduleRepurchaseAlertJob } from './jobs/RepurchaseAlertJob';

const app = express();

const fallbackOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const configuredOrigins = [
  ...(env.FRONTEND_URL ? [env.FRONTEND_URL] : []),
  ...(env.FRONTEND_URLS
    ? env.FRONTEND_URLS.split(',').map((o) => o.trim()).filter(Boolean)
    : []),
  ...fallbackOrigins,
];
const allowOriginSet = new Set(configuredOrigins);

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

// Health check (unauthenticated)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Error handling ──────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Register connector plugins ─────────────────────────────────────────────
function registerPlugins(): void {
  registry.register(new MisaConnector());
  registry.register(new ViettelConnector());
  registry.register(new BkavConnector());
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
  await scheduleTaxDeadlineReminder();
  await scheduleRepurchaseAlertJob();
  console.info('[Jobs] BullMQ workers started');

  app.listen(env.API_PORT, () => {
    console.info(`[Server] Listening on port ${env.API_PORT} (${env.NODE_ENV})`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
