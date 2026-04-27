/**
 * Admin Proxy Management Routes
 *
 * CRUD for static residential proxy pool + assignment management.
 * All routes require: authenticate → requireAdmin
 *
 * Mounted at: /api/admin/proxies
 *
 * Many-to-many model (since migration 048):
 *   proxy_user_assignments_v2 (proxy_id, user_id) — one IP can be assigned to
 *   multiple users; one user can hold multiple IPs.
 *   The bot enforces "only assigned IPs" per user.
 */
import { Router, Request, Response, NextFunction } from 'express';
import * as net from 'net';
import { z } from 'zod';
import { pool } from '../db/pool';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import { sendSuccess } from '../utils/response';
import { ValidationError, NotFoundError } from '../utils/AppError';

const router = Router();
router.use(authenticate, requireAdmin);

// ── Validation Schemas ────────────────────────────────────────────────────────

const createProxySchema = z.object({
  host:     z.string().min(1).max(255),
  port:     z.number().int().min(1).max(65535),
  protocol: z.enum(['http', 'https', 'socks5']).default('http'),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  label:    z.string().max(100).optional(),
  country:  z.string().max(10).default('VN'),
  expires_at: z.string().datetime().optional(),
});

const updateProxySchema = z.object({
  host:     z.string().min(1).max(255).optional(),
  port:     z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['http', 'https', 'socks5']).optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  label:    z.string().max(100).optional(),
  country:  z.string().max(10).optional(),
  status:   z.enum(['active', 'blocked', 'quarantine']).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

const bulkCreateSchema = z.object({
  proxies: z.array(createProxySchema).min(1).max(100),
});

// ── Dashboard Overview ────────────────────────────────────────────────────────

router.get('/dashboard', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const counts = await pool.query(`
      SELECT
        COUNT(*)  FILTER (WHERE p.status = 'active')     AS active,
        COUNT(*)  FILTER (WHERE p.status = 'blocked')    AS blocked,
        COUNT(*)  FILTER (WHERE p.status = 'quarantine') AS quarantine,
        COUNT(*)                                          AS total,
        COUNT(*)  FILTER (WHERE p.expires_at IS NOT NULL AND p.expires_at < NOW()) AS expired
      FROM static_proxies p
    `);

    // Count assigned proxies (those with at least one user in the junction table)
    const assignedCount = await pool.query(`
      SELECT COUNT(DISTINCT proxy_id)::int AS assigned
      FROM proxy_user_assignments_v2
    `);

    // Count available proxies (active + not in junction table at all)
    const availableCount = await pool.query(`
      SELECT COUNT(*)::int AS available
      FROM static_proxies p
      WHERE p.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM proxy_user_assignments_v2 pua WHERE pua.proxy_id = p.id
        )
    `);

    const row = counts.rows[0];
    sendSuccess(res, {
      total:      parseInt(row.total, 10),
      active:     parseInt(row.active, 10),
      blocked:    parseInt(row.blocked, 10),
      quarantine: parseInt(row.quarantine, 10),
      assigned:   assignedCount.rows[0]!.assigned,
      available:  availableCount.rows[0]!.available,
      expired:    parseInt(row.expired, 10),
    });
  } catch (err) { next(err); }
});

// ── List All Proxies ──────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        COALESCE(
          json_agg(
            json_build_object(
              'user_id',  u.id,
              'email',    u.email,
              'name',     u.full_name,
              'assigned_at', pua.assigned_at
            )
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'::json
        ) AS assigned_users
      FROM static_proxies p
      LEFT JOIN proxy_user_assignments_v2 pua ON pua.proxy_id = p.id
      LEFT JOIN users u ON u.id = pua.user_id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    sendSuccess(res, result.rows);
  } catch (err) { next(err); }
});

// ── Create Single Proxy ───────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createProxySchema.parse(req.body);
    const result = await pool.query(
      `INSERT INTO static_proxies (host, port, protocol, username, password, label, country, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [data.host, data.port, data.protocol, data.username, data.password, data.label, data.country, data.expires_at ?? null],
    );
    sendSuccess(res, { ...result.rows[0], assigned_users: [] }, undefined, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Bulk Create Proxies ───────────────────────────────────────────────────────

router.post('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { proxies } = bulkCreateSchema.parse(req.body);
    const created = [];
    for (const data of proxies) {
      const result = await pool.query(
        `INSERT INTO static_proxies (host, port, protocol, username, password, label, country, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [data.host, data.port, data.protocol, data.username, data.password, data.label, data.country, data.expires_at ?? null],
      );
      created.push({ ...result.rows[0], assigned_users: [] });
    }
    sendSuccess(res, { created: created.length, proxies: created }, undefined, 201);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Update Proxy ──────────────────────────────────────────────────────────────

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateProxySchema.parse(req.body);
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(data)) {
      if (val !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(val);
      }
    }

    if (fields.length === 0) throw new ValidationError('No fields to update');

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE static_proxies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );

    if (result.rowCount === 0) throw new NotFoundError('Proxy not found');
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Delete Proxy ──────────────────────────────────────────────────────────────

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await pool.query(
      `DELETE FROM static_proxies WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (result.rowCount === 0) throw new NotFoundError('Proxy not found');
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
});

// ── Assign Proxy to User ──────────────────────────────────────────────────────
// Many-to-many: a proxy can be assigned to multiple users simultaneously.
// No auto-release of existing assignments.

router.post('/:id/assign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, company_id, reason } = z.object({
      user_id:    z.string().uuid(),
      company_id: z.string().uuid().optional(),
      reason:     z.string().max(500).optional(),
    }).parse(req.body);

    // Verify the proxy exists and is active
    const proxyCheck = await pool.query(
      `SELECT id FROM static_proxies WHERE id = $1 AND status = 'active'`,
      [req.params.id],
    );
    if (proxyCheck.rowCount === 0) throw new NotFoundError('Proxy not found or not active');

    // Insert into junction table (idempotent — ON CONFLICT DO NOTHING)
    await pool.query(
      `INSERT INTO proxy_user_assignments_v2 (proxy_id, user_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, user_id, req.user?.userId ?? null],
    );

    // Audit log
    await pool.query(
      `INSERT INTO proxy_assignments (proxy_id, user_id, company_id, action, reason)
       VALUES ($1, $2, $3, 'assign', $4)`,
      [req.params.id, user_id, company_id ?? null, reason ?? null],
    );

    // Return the updated proxy with all assigned users
    const updated = await pool.query(`
      SELECT
        p.*,
        COALESCE(
          json_agg(json_build_object('user_id', u.id, 'email', u.email, 'name', u.full_name, 'assigned_at', pua.assigned_at))
          FILTER (WHERE u.id IS NOT NULL),
          '[]'::json
        ) AS assigned_users
      FROM static_proxies p
      LEFT JOIN proxy_user_assignments_v2 pua ON pua.proxy_id = p.id
      LEFT JOIN users u ON u.id = pua.user_id
      WHERE p.id = $1
      GROUP BY p.id
    `, [req.params.id]);

    sendSuccess(res, updated.rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Release Proxy from a specific User ───────────────────────────────────────
// user_id is required — admin must specify which user to release.
// To release all users, call this once per user or use /release-all.

router.post('/:id/release', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, reason } = z.object({
      user_id: z.string().uuid(),
      reason:  z.string().max(500).optional(),
    }).parse(req.body);

    // Verify proxy exists
    const proxyCheck = await pool.query(`SELECT id FROM static_proxies WHERE id = $1`, [req.params.id]);
    if (proxyCheck.rowCount === 0) throw new NotFoundError('Proxy not found');

    // Remove the specific assignment
    const del = await pool.query(
      `DELETE FROM proxy_user_assignments_v2 WHERE proxy_id = $1 AND user_id = $2`,
      [req.params.id, user_id],
    );

    // Audit log (only if there was actually an assignment)
    if ((del.rowCount ?? 0) > 0) {
      await pool.query(
        `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
         VALUES ($1, $2, 'release', $3)`,
        [req.params.id, user_id, reason ?? null],
      );
    }

    // Return the updated proxy with remaining assigned users
    const updated = await pool.query(`
      SELECT
        p.*,
        COALESCE(
          json_agg(json_build_object('user_id', u.id, 'email', u.email, 'name', u.full_name, 'assigned_at', pua.assigned_at))
          FILTER (WHERE u.id IS NOT NULL),
          '[]'::json
        ) AS assigned_users
      FROM static_proxies p
      LEFT JOIN proxy_user_assignments_v2 pua ON pua.proxy_id = p.id
      LEFT JOIN users u ON u.id = pua.user_id
      WHERE p.id = $1
      GROUP BY p.id
    `, [req.params.id]);

    sendSuccess(res, updated.rows[0]);
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Release Proxy from ALL Users ─────────────────────────────────────────────

router.post('/:id/release-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = z.object({
      reason: z.string().max(500).optional(),
    }).parse(req.body);

    const proxyCheck = await pool.query(`SELECT id FROM static_proxies WHERE id = $1`, [req.params.id]);
    if (proxyCheck.rowCount === 0) throw new NotFoundError('Proxy not found');

    // Get all users currently assigned
    const assignments = await pool.query(
      `SELECT user_id FROM proxy_user_assignments_v2 WHERE proxy_id = $1`,
      [req.params.id],
    );

    // Remove all assignments
    await pool.query(`DELETE FROM proxy_user_assignments_v2 WHERE proxy_id = $1`, [req.params.id]);

    // Audit log for each user
    for (const row of assignments.rows as { user_id: string }[]) {
      await pool.query(
        `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
         VALUES ($1, $2, 'release', $3)`,
        [req.params.id, row.user_id, reason ?? 'Admin release-all'],
      );
    }

    sendSuccess(res, { released: assignments.rowCount ?? 0 });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new ValidationError(err.errors.map(e => e.message).join(', ')));
    next(err);
  }
});

// ── Health Check a Proxy ──────────────────────────────────────────────────────
// TCP-ping the proxy host:port — fast, no external deps, no outbound HTTP needed.
// If the proxy accepts a TCP connection within 10s it is considered reachable.

function tcpPing(host: string, port: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

router.post('/:id/health-check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxyRow = await pool.query(
      `SELECT host, port, protocol, username, password FROM static_proxies WHERE id = $1`,
      [req.params.id],
    );
    if (proxyRow.rowCount === 0) throw new NotFoundError('Proxy not found');

    const p = proxyRow.rows[0] as { host: string; port: number; protocol: string; username: string | null; password: string | null };
    const healthy = await tcpPing(p.host, p.port);

    await pool.query(
      `UPDATE static_proxies
       SET last_health_check = NOW(), last_health_status = $1
       WHERE id = $2`,
      [healthy, req.params.id],
    );

    sendSuccess(res, { healthy, host: p.host, port: p.port });
  } catch (err) { next(err); }
});

// ── Assignment History ────────────────────────────────────────────────────────

router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 50, 200);
    const result = await pool.query(
      `SELECT
         pa.*,
         sp.host, sp.port, sp.label,
         u.email AS user_email
       FROM proxy_assignments pa
       JOIN static_proxies sp ON pa.proxy_id = sp.id
       JOIN users u ON pa.user_id = u.id
       ORDER BY pa.created_at DESC
       LIMIT $1`,
      [limit],
    );
    sendSuccess(res, result.rows);
  } catch (err) { next(err); }
});

export default router;
