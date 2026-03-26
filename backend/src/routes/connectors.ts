import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate, requireRole } from '../middleware/auth';
import { requireCompany } from '../middleware/company';
import { encryptCredentials } from '../utils/encryption';
import { registry } from '../connectors/ConnectorRegistry';
import { ValidationError, NotFoundError } from '../utils/AppError';
import { sendSuccess } from '../utils/response';

const router = Router();
router.use(authenticate);
router.use(requireCompany);

const upsertSchema = z.object({
  providerId: z.string().min(1),
  credentials: z.record(z.string()),
});

const testCredsSchema = z.object({
  providerId: z.string().min(1),
  credentials: z.record(z.string()),
});

// POST /api/connectors/test-credentials — test before saving (no DB write)
router.post(
  '/test-credentials',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = testCredsSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const { providerId, credentials } = parsed.data;
      const plugin = registry.get(providerId);
      if (!plugin) throw new NotFoundError(`Provider "${providerId}" not registered`);

      const { encryptCredentials: enc } = await import('../utils/encryption');
      const encrypted = enc(credentials);
      await plugin.authenticate({ encrypted });
      const healthy = await plugin.healthCheck();

      sendSuccess(res, {
        healthy,
        provider: providerId,
        environment: process.env[`${providerId.toUpperCase()}_ENV`] ?? 'production',
      });
    } catch (err) {
      // Surface provider errors as a structured response (not 500) so the UI can show them
      const msg = (err as Error).message ?? 'Connection failed';
      res.status(200).json({ success: false, error: { code: 'CONNECTION_FAILED', message: msg } });
    }
  }
);

// GET /api/connectors
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `SELECT id,
              provider         AS provider_id,
              enabled          AS is_enabled,
              circuit_state    AS circuit_breaker_state,
              last_sync_at,
              last_error,
              15               AS sync_frequency_minutes
       FROM company_connectors WHERE company_id = $1
       ORDER BY created_at ASC`,
      [req.user!.companyId]
    );
    sendSuccess(res, result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/connectors — create or update
router.post(
  '/',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input');

      const { providerId, credentials } = parsed.data;
      const encryptedCreds = encryptCredentials(credentials);

      const result = await pool.query(
        `INSERT INTO company_connectors (id, company_id, provider, credentials_encrypted, enabled)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (company_id, provider)
         DO UPDATE SET credentials_encrypted = $4, updated_at = NOW()
         RETURNING id, provider, enabled`,
        [uuidv4(), req.user!.companyId, providerId, encryptedCreds]
      );

      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/connectors/:id
router.delete(
  '/:id',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `DELETE FROM company_connectors WHERE id = $1 AND company_id = $2 RETURNING id`,
        [req.params.id, req.user!.companyId]
      );
      if (!result.rows[0]) throw new NotFoundError('Connector not found');
      sendSuccess(res, null, 'Connector removed');
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/connectors/:id/test — health check
router.post(
  '/:id/test',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connRow = await pool.query(
        `SELECT provider, credentials_encrypted FROM company_connectors
         WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!connRow.rows[0]) throw new NotFoundError('Connector not found');

      const plugin = registry.get(connRow.rows[0].provider as string);
      if (!plugin) throw new NotFoundError(`Plugin "${connRow.rows[0].provider}" not registered`);

      await plugin.authenticate({ encrypted: connRow.rows[0].credentials_encrypted as string });
      const healthy = await plugin.healthCheck();

      // Clear stale error when health check passes
      if (healthy) {
        await pool.query(
          `UPDATE company_connectors
           SET last_error = NULL, circuit_state = 'CLOSED', consecutive_failures = 0
           WHERE id = $1 AND company_id = $2`,
          [req.params.id, req.user!.companyId]
        );
      }

      sendSuccess(res, { healthy });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/connectors/:id/toggle — enable/disable
router.patch(
  '/:id/toggle',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await pool.query(
        `UPDATE company_connectors
         SET enabled = NOT enabled, updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING id, provider AS provider_id, enabled AS is_enabled`,
        [req.params.id, req.user!.companyId]
      );
      if (!result.rows[0]) throw new NotFoundError('Connector not found');
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/connectors/:id/sync — trigger manual sync now
router.post(
  '/:id/sync',
  requireRole('OWNER', 'ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connRow = await pool.query(
        `SELECT company_id, last_sync_at FROM company_connectors WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.user!.companyId]
      );
      if (!connRow.rows[0]) throw new NotFoundError('Connector not found');

      const { syncQueue } = await import('../jobs/SyncWorker');
      const now = new Date();
      // Use last_sync_at as fromDate if available; otherwise go back 24 months (initial sync)
      const lastSync = connRow.rows[0].last_sync_at as Date | null;
      const fromDate = lastSync
        ? new Date(lastSync.getTime() - 5 * 60 * 1000).toISOString()   // 5-min overlap to avoid gaps
        : new Date(now.getFullYear() - 2, 0, 1).toISOString();          // Jan 1 two years ago
      await syncQueue.add(
        `manual-sync-${req.user!.companyId}`,
        { companyId: req.user!.companyId!, fromDate, toDate: now.toISOString(), triggeredBy: 'manual' },
        { removeOnComplete: 10 }
      );
      sendSuccess(res, { queued: true });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/connectors/sync-logs — paginated sync history
router.get('/sync-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 20)));
    const provider = req.query.provider as string | undefined;
    const offset = (page - 1) * pageSize;

    const providerFilter = provider ? 'AND provider = $2' : '';
    const countParams: unknown[] = provider
      ? [req.user!.companyId, provider]
      : [req.user!.companyId];
    const dataParams: unknown[] = provider
      ? [req.user!.companyId, provider, pageSize, offset]
      : [req.user!.companyId, pageSize, offset];
    const limitParam = provider ? 3 : 2;
    const offsetParam = provider ? 4 : 3;

    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM sync_logs WHERE company_id = $1 ${providerFilter}`,
        countParams
      ),
      pool.query(
        `SELECT id, provider, started_at, finished_at,
                records_fetched, records_created, records_updated,
                errors_count, error_detail
         FROM sync_logs
         WHERE company_id = $1 ${providerFilter}
         ORDER BY started_at DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        dataParams
      ),
    ]);

    const total = Number(countResult.rows[0].count);
    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
