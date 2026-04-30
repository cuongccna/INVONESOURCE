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
        COUNT(*)  FILTER (WHERE p.status = 'active')                                    AS active,
        COUNT(*)  FILTER (WHERE p.status = 'blocked')                                   AS blocked,
        COUNT(*)  FILTER (WHERE p.status = 'quarantine')                                AS quarantine,
        COUNT(*)                                                                         AS total,
        COUNT(*)  FILTER (WHERE p.expires_at IS NOT NULL AND p.expires_at < NOW())      AS expired,
        COUNT(*)  FILTER (WHERE p.gdt_check_status = 'gdt_blocked')                    AS gdt_blocked,
        COUNT(*)  FILTER (WHERE p.gdt_check_status = 'reachable')                      AS gdt_reachable,
        COUNT(*)  FILTER (WHERE p.gdt_check_status IS NOT NULL)                        AS gdt_checked
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
      total:         parseInt(row.total, 10),
      active:        parseInt(row.active, 10),
      blocked:       parseInt(row.blocked, 10),
      quarantine:    parseInt(row.quarantine, 10),
      assigned:      assignedCount.rows[0]!.assigned,
      available:     availableCount.rows[0]!.available,
      expired:       parseInt(row.expired, 10),
      gdt_blocked:   parseInt(row.gdt_blocked,   10),
      gdt_reachable: parseInt(row.gdt_reachable, 10),
      gdt_checked:   parseInt(row.gdt_checked,   10),
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
              'user_id',     u.id,
              'email',       u.email,
              'name',        u.full_name,
              'assigned_at', pua.assigned_at
            )
          ) FILTER (WHERE u.id IS NOT NULL),
          '[]'::json
        ) AS assigned_users
      FROM static_proxies p
      LEFT JOIN proxy_user_assignments_v2 pua ON pua.proxy_id = p.id
      LEFT JOIN users u ON u.id = pua.user_id
      GROUP BY p.id
      ORDER BY
        -- Ưu tiên hiển thị proxy bị GDT chặn lên đầu
        CASE p.gdt_check_status WHEN 'gdt_blocked' THEN 0 ELSE 1 END,
        p.created_at DESC
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

// ── GDT Block Check ───────────────────────────────────────────────────────────
// Sends an HTTP CONNECT tunnel request through the proxy to
// hoadondientu.gdt.gov.vn:443.  This reveals whether GDT is TCP-blackholing
// the proxy's outbound IP — without making any authenticated GDT API calls.
//
// Possible outcomes:
//   'reachable'       — tunnel succeeded; GDT is reachable from this proxy
//   'gdt_blocked'     — proxy connected but GDT blackholed the TCP handshake
//   'proxy_error'     — could not connect to the proxy server at all
//   'proxy_auth_fail' — proxy returned 407 (wrong username/password)

export type GdtCheckStatus = 'reachable' | 'gdt_blocked' | 'proxy_error' | 'proxy_auth_fail';

interface GdtCheckResult {
  status:    GdtCheckStatus;
  latencyMs: number | null;
  detail:    string | null;
}

const GDT_CONNECT_TARGET = 'hoadondientu.gdt.gov.vn:443';
const GDT_CHECK_TIMEOUT  = 14_000; // 14s total budget per proxy

function checkGdtViaProxy(
  host:     string,
  port:     number,
  username: string | null,
  password: string | null,
): Promise<GdtCheckResult> {
  return new Promise(resolve => {
    const t0 = Date.now();
    let settled = false;

    const done = (r: GdtCheckResult) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };

    // ── Step 1: TCP connect to the proxy server ──────────────────────────────
    const sock = net.createConnection({ host, port });

    // Total budget timer — fires if proxy connect + tunnel negotiation both hang
    const globalTimer = setTimeout(
      () => done({ status: 'gdt_blocked', latencyMs: Date.now() - t0, detail: 'GDT TCP blackhole (total timeout)' }),
      GDT_CHECK_TIMEOUT,
    );

    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(globalTimer);
      done({ status: 'proxy_error', latencyMs: null, detail: err.message });
    });

    sock.once('connect', () => {
      // ── Step 2: Send HTTP CONNECT to GDT through the proxy ──────────────
      const authHeader = username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}\r\n`
        : '';

      sock.write(
        `CONNECT ${GDT_CONNECT_TARGET} HTTP/1.1\r\n` +
        `Host: ${GDT_CONNECT_TARGET}\r\n` +
        `User-Agent: Mozilla/5.0\r\n` +
        `${authHeader}\r\n`,
      );

      // ── Step 3: Read CONNECT response ────────────────────────────────────
      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        // Wait for end-of-headers
        if (!buf.includes('\r\n\r\n') && !buf.includes('\n\n')) return;

        clearTimeout(globalTimer);
        const latencyMs  = Date.now() - t0;
        const statusLine = buf.split(/\r?\n/)[0] ?? '';

        if (/^HTTP\/1\.[01]\s+200\b/.test(statusLine)) {
          // 200 Connection established — GDT is reachable through this proxy
          done({ status: 'reachable', latencyMs, detail: null });
        } else if (/^HTTP\/1\.[01]\s+407\b/.test(statusLine)) {
          // 407 Proxy Authentication Required — proxy credentials are wrong.
          // This does NOT tell us about GDT reachability.
          done({ status: 'proxy_auth_fail', latencyMs, detail: statusLine.trim() });
        } else {
          // Any other proxy error (403, 502, etc.) — treat as proxy-level issue,
          // not a GDT-side block. GDT reachability is unknown.
          done({ status: 'proxy_error', latencyMs, detail: statusLine.trim() });
        }
      });
    });
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

// ── GDT Block Check — Single Proxy ───────────────────────────────────────────
// POST /admin/proxies/:id/check-gdt-block
// Runs the CONNECT-tunnel test for one proxy and saves the result.

router.post('/:id/check-gdt-block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const proxyRow = await pool.query<{
      id: string; host: string; port: number; username: string | null; password: string | null; label: string | null;
    }>(
      `SELECT id, host, port, username, password, label FROM static_proxies WHERE id = $1`,
      [req.params.id],
    );
    if (proxyRow.rowCount === 0) throw new NotFoundError('Proxy not found');

    const p = proxyRow.rows[0]!;
    const result = await checkGdtViaProxy(p.host, p.port, p.username, p.password);

    // Persist result
    await pool.query(
      `UPDATE static_proxies
       SET gdt_check_at = NOW(), gdt_check_status = $1, gdt_check_ms = $2
       WHERE id = $3`,
      [result.status, result.latencyMs, p.id],
    );

    sendSuccess(res, {
      proxyId:   p.id,
      host:      p.host,
      port:      p.port,
      label:     p.label,
      ...result,
    });
  } catch (err) { next(err); }
});

// ── GDT Block Check — Bulk (all active proxies) ───────────────────────────────
// POST /admin/proxies/check-gdt-block
// Checks ALL active proxies in parallel (max concurrency 8).
// Results are saved to DB and returned in one batch.
// Typical runtime: ~14s for any number of proxies (limited by GDT_CHECK_TIMEOUT).

const BULK_CONCURRENCY = 8;

router.post('/check-gdt-block', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const proxiesRes = await pool.query<{
      id: string; host: string; port: number; username: string | null; password: string | null; label: string | null;
    }>(
      `SELECT id, host, port, username, password, label
       FROM static_proxies
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC`,
    );

    const proxies = proxiesRes.rows;
    if (proxies.length === 0) {
      sendSuccess(res, { checked: 0, results: [] });
      return;
    }

    // Run in batches of BULK_CONCURRENCY to avoid creating too many parallel TCP sockets
    const results: {
      proxyId: string; host: string; port: number; label: string | null;
      status: GdtCheckStatus; latencyMs: number | null; detail: string | null;
    }[] = [];

    for (let i = 0; i < proxies.length; i += BULK_CONCURRENCY) {
      const batch = proxies.slice(i, i + BULK_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (p) => {
          const r = await checkGdtViaProxy(p.host, p.port, p.username, p.password);
          return { p, r };
        }),
      );

      // Persist batch results in one query per row
      for (const { p, r } of batchResults) {
        await pool.query(
          `UPDATE static_proxies
           SET gdt_check_at = NOW(), gdt_check_status = $1, gdt_check_ms = $2
           WHERE id = $3`,
          [r.status, r.latencyMs, p.id],
        );
        results.push({
          proxyId:   p.id,
          host:      p.host,
          port:      p.port,
          label:     p.label,
          ...r,
        });
      }
    }

    const summary = {
      checked:         results.length,
      reachable:       results.filter(r => r.status === 'reachable').length,
      gdt_blocked:     results.filter(r => r.status === 'gdt_blocked').length,
      proxy_error:     results.filter(r => r.status === 'proxy_error').length,
      proxy_auth_fail: results.filter(r => r.status === 'proxy_auth_fail').length,
    };

    sendSuccess(res, { ...summary, results });
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
