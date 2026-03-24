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
import { registry } from './connectors/ConnectorRegistry';
import { MisaConnector } from './connectors/MisaConnector';
import { ViettelConnector } from './connectors/ViettelConnector';
import { BkavConnector } from './connectors/BkavConnector';
import { GdtIntermediaryConnector } from './connectors/GdtIntermediaryConnector';
import { scheduleSyncCron } from './jobs/SyncWorker';
import { gdtValidateWorker } from './jobs/GdtValidatorWorker';
import { scheduleTaxDeadlineReminder } from './jobs/TaxDeadlineReminderJob';

const app = express();

// ─── Security middleware ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: env.FRONTEND_URL ?? 'http://localhost:3000',
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
app.use('/api/notifications', notificationsRouter);

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
  console.info('[Jobs] BullMQ workers started');

  app.listen(env.API_PORT, () => {
    console.info(`[Server] Listening on port ${env.API_PORT} (${env.NODE_ENV})`);
  });
}

start().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
