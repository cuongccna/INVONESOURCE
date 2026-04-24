/**
 * StaticProxyPool — DB-backed static residential proxy assignment
 *
 * Used for manual sync jobs: assigns a sticky proxy per user from the
 * static_proxies table. Used for both manual and auto sync.
 *
 * - acquireForUser(): find or return existing assigned proxy
 * - releaseForUser(): release assignment
 * - markBlocked(): block proxy + auto-rotate to next available
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
   * Get the currently assigned proxy for a user, or assign one if none exists.
   * Returns null if no proxies are available.
   */
  async acquireForUser(userId: string): Promise<{ url: string; proxyId: string } | null> {
    // 1. Check if user already has an assigned proxy
    const existing = await pgPool.query<StaticProxy>(
      `SELECT id, host, port, protocol, username, password, label
       FROM static_proxies
       WHERE assigned_user_id = $1 AND status = 'active'
       LIMIT 1`,
      [userId],
    );

    if (existing.rows.length > 0) {
      const p = existing.rows[0];
      return { url: buildProxyUrl(p), proxyId: p.id };
    }

    // 2. Find first available proxy (not assigned, active, not expired)
    const available = await pgPool.query<StaticProxy>(
      `SELECT id, host, port, protocol, username, password, label
       FROM static_proxies
       WHERE status = 'active'
         AND assigned_user_id IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [],
    );

    if (available.rows.length === 0) {
      logger.warn('[StaticProxyPool] No available proxies for user', { userId: userId.slice(0, 8) });
      return null;
    }

    const p = available.rows[0];

    // 3. Assign to user
    await pgPool.query(
      `UPDATE static_proxies SET assigned_user_id = $1, assigned_at = NOW() WHERE id = $2`,
      [userId, p.id],
    );

    // 4. Audit log
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
   * Release the user's currently assigned proxy.
   */
  async releaseForUser(userId: string): Promise<void> {
    const result = await pgPool.query<{ id: string }>(
      `UPDATE static_proxies
       SET assigned_user_id = NULL, assigned_at = NULL
       WHERE assigned_user_id = $1
       RETURNING id`,
      [userId],
    );

    for (const row of result.rows) {
      await pgPool.query(
        `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
         VALUES ($1, $2, 'release', 'manual_release')`,
        [row.id, userId],
      );
    }
  }

  /**
   * Mark a proxy as blocked (GDT rejected it) and auto-rotate the user
   * to the next available proxy.
   */
  async markBlocked(proxyId: string, userId: string, reason: string): Promise<{ url: string; proxyId: string } | null> {
    // Block the proxy
    await pgPool.query(
      `UPDATE static_proxies
       SET status = 'blocked', blocked_reason = $1, blocked_at = NOW(),
           assigned_user_id = NULL, assigned_at = NULL
       WHERE id = $2`,
      [reason, proxyId],
    );

    // Audit log
    await pgPool.query(
      `INSERT INTO proxy_assignments (proxy_id, user_id, action, reason)
       VALUES ($1, $2, 'blocked', $3)`,
      [proxyId, userId, reason],
    );

    logger.warn('[StaticProxyPool] Proxy blocked — auto-rotating', {
      proxyId: proxyId.slice(0, 8),
      userId: userId.slice(0, 8),
      reason,
    });

    // Auto-rotate: assign next available proxy
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
        COUNT(*)::int                                                          AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int                         AS active,
        COUNT(*) FILTER (WHERE assigned_user_id IS NOT NULL AND status = 'active')::int AS assigned,
        COUNT(*) FILTER (WHERE assigned_user_id IS NULL AND status = 'active')::int     AS available,
        COUNT(*) FILTER (WHERE status = 'blocked')::int                        AS blocked
      FROM static_proxies
    `);
    return result.rows[0];
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
