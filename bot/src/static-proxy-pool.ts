/**
 * StaticProxyPool — DB-backed static residential proxy assignment
 *
 * Uses proxy_user_assignments_v2 (many-to-many junction table, migration 048).
 * One IP can be assigned to multiple users; one user can hold multiple IPs.
 *
 * Enforcement rule (per user request):
 *   - If a user has ≥1 ACTIVE assigned proxy → use one of them (round-robin random)
 *   - If a user has assignments but ALL are blocked → return null (do NOT fall back)
 *   - If a user has NO assignments at all → fall back to auto-assign from unassigned pool
 *
 * - acquireForUser(): find or return one active assigned proxy; auto-assign if none
 * - releaseForUser(): remove all assignments for a user
 * - markBlocked(): block proxy + remove all its assignments + rotate each affected user
 * - healthCheck(): TCP probe
 */
import { pool as pgPool } from './db';
import { logger } from './logger';

export interface StaticProxy {
  id:       string;
  host:     string;
  port:     number;
  protocol: string;
  username: string | null;
  password: string | null;
  label:    string | null;
}

function buildProxyUrl(p: StaticProxy): string {
  const auth = p.username
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@`
    : '';
  return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

export class StaticProxyPool {
  /**
   * Return all active, non-expired static proxies in a stable order.
   * AUTO jobs hash over this list via proxy_session_id to keep a sticky IP.
   */
  async listActiveUrls(): Promise<string[]> {
    const result = await pgPool.query<StaticProxy>(
      `SELECT id, host, port, protocol, username, password, label
       FROM static_proxies
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC, id ASC`,
    );

    return result.rows.map(buildProxyUrl);
  }

  /**
   * Get one active proxy for a user.
   *
   * Priority:
   * 1. User has active assigned proxies → return one (random pick for load spreading)
   * 2. User has assigned proxies but all blocked → return null (enforce assigned-only rule)
   * 3. User has no assignments → auto-assign from unassigned pool
   *
   * Returns null if no suitable proxy is found.
   */
  async acquireForUser(userId: string): Promise<{ url: string; proxyId: string } | null> {
    // 1. Check for any active proxy already assigned to this user
    const activeAssigned = await pgPool.query<StaticProxy>(
      `SELECT sp.id, sp.host, sp.port, sp.protocol, sp.username, sp.password, sp.label
       FROM proxy_user_assignments_v2 pua
       JOIN static_proxies sp ON sp.id = pua.proxy_id
       WHERE pua.user_id = $1
         AND sp.status = 'active'
         AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
       ORDER BY random()
       LIMIT 1`,
      [userId],
    );

    if (activeAssigned.rows.length > 0) {
      const p = activeAssigned.rows[0]!;
      return { url: buildProxyUrl(p), proxyId: p.id };
    }

    // 2. Check if user has ANY assignments (even all blocked)
    //    If yes, do NOT fall back — respect the "assigned-only" policy.
    const anyAssigned = await pgPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM proxy_user_assignments_v2
       WHERE user_id = $1`,
      [userId],
    );

    if (parseInt(anyAssigned.rows[0]!.count, 10) > 0) {
      logger.warn('[StaticProxyPool] User has assignments but all proxies blocked — no fallback', {
        userId: userId.slice(0, 8),
      });
      return null;
    }

    // 3. No assignments → auto-assign from unassigned pool
    const available = await pgPool.query<StaticProxy>(
      `SELECT sp.id, sp.host, sp.port, sp.protocol, sp.username, sp.password, sp.label
       FROM static_proxies sp
       WHERE sp.status = 'active'
         AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
         AND NOT EXISTS (
           SELECT 1 FROM proxy_user_assignments_v2 pua WHERE pua.proxy_id = sp.id
         )
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [],
    );

    if (available.rows.length === 0) {
      logger.warn('[StaticProxyPool] No available unassigned proxies for user', { userId: userId.slice(0, 8) });
      return null;
    }

    const p = available.rows[0]!;

    // Assign to user via junction table
    await pgPool.query(
      `INSERT INTO proxy_user_assignments_v2 (proxy_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [p.id, userId],
    );

    // Audit log
    await pgPool.query(
      `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
       VALUES ($1, $2, 'assign', 'auto_acquire')`,
      [p.id, userId],
    );

    logger.info('[StaticProxyPool] Assigned proxy to user', {
      userId: userId.slice(0, 8),
      proxyId: p.id.slice(0, 8),
      label: p.label,
    });

    return { url: buildProxyUrl(p), proxyId: p.id };
  }

  /**
   * Release ALL proxy assignments for a user.
   */
  async releaseForUser(userId: string): Promise<void> {
    const result = await pgPool.query<{ proxy_id: string }>(
      `DELETE FROM proxy_user_assignments_v2
       WHERE user_id = $1
       RETURNING proxy_id`,
      [userId],
    );

    for (const row of result.rows) {
      await pgPool.query(
        `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
         VALUES ($1, $2, 'release', 'manual_release')`,
        [row.proxy_id, userId],
      );
    }
  }

  /**
   * Mark a proxy as blocked (GDT rejected it).
   * Removes the proxy from ALL user assignments and tries to rotate each affected user.
   */
  async markBlocked(proxyId: string, userId: string, reason: string): Promise<{ url: string; proxyId: string } | null> {
    // Get all users currently assigned to this proxy
    const affectedUsers = await pgPool.query<{ user_id: string }>(
      `SELECT user_id FROM proxy_user_assignments_v2 WHERE proxy_id = $1`,
      [proxyId],
    );

    // Block the proxy + remove all assignments for it
    await pgPool.query(
      `UPDATE static_proxies
       SET status = 'blocked', blocked_reason = $1, blocked_at = NOW()
       WHERE id = $2`,
      [reason, proxyId],
    );

    await pgPool.query(
      `DELETE FROM proxy_user_assignments_v2 WHERE proxy_id = $1`,
      [proxyId],
    );

    // Audit log for the triggering user
    await pgPool.query(
      `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
       VALUES ($1, $2, 'blocked', $3)`,
      [proxyId, userId, reason],
    );

    logger.warn('[StaticProxyPool] Proxy blocked — removed from all users, auto-rotating', {
      proxyId: proxyId.slice(0, 8),
      userId: userId.slice(0, 8),
      affectedUsers: affectedUsers.rowCount,
      reason,
    });

    // Auto-rotate the triggering user; other affected users will self-rotate on next acquire
    return this.acquireForUser(userId);
  }

  /**
   * Get current pool stats.
   */
  async stats(): Promise<{
    total: number;
    active: number;
    assigned: number;
    available: number;
    blocked: number;
  }> {
    const result = await pgPool.query(`
      SELECT
        COUNT(*)::int                                               AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int             AS active,
        COUNT(*) FILTER (WHERE status = 'blocked')::int            AS blocked
      FROM static_proxies
    `);

    const assignedResult = await pgPool.query(`
      SELECT COUNT(DISTINCT proxy_id)::int AS assigned
      FROM proxy_user_assignments_v2
    `);

    const availableResult = await pgPool.query(`
      SELECT COUNT(*)::int AS available
      FROM static_proxies sp
      WHERE sp.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM proxy_user_assignments_v2 pua WHERE pua.proxy_id = sp.id
        )
    `);

    const row = result.rows[0]!;
    return {
      total:     row.total,
      active:    row.active,
      assigned:  assignedResult.rows[0]!.assigned,
      available: availableResult.rows[0]!.available,
      blocked:   row.blocked,
    };
  }

  /**
   * Check if the static proxy pool is enabled (has any active proxies).
   */
  async isEnabled(): Promise<boolean> {
    const result = await pgPool.query(
      `SELECT EXISTS(SELECT 1 FROM static_proxies WHERE status = 'active') AS has_proxies`,
    );
    return result.rows[0]?.has_proxies === true;
  }
}

/** Singleton instance */
export const staticProxyPool = new StaticProxyPool();
