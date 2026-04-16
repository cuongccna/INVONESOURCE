/**
 * PROMPT 5 — Module 2: GDT Session Pool
 *
 * Manages GDT login sessions with JWT parsing, Redis caching,
 * proxy+UA consistency, and login cooldown separation.
 */

import type { Redis } from 'ioredis';
import { logger } from './logger';

// ─── UA Profiles ─────────────────────────────────────────────────────────────

export interface UAProfile {
  secChUa: string;
  ua: string;
}

export const UA_PROFILES: UAProfile[] = [
  {
    secChUa: '"Chromium";v="146","Not-A.Brand";v="24","Microsoft Edge";v="146"',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0',
  },
  {
    secChUa: '"Google Chrome";v="125","Chromium";v="125","Not-A.Brand";v="24"',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  },
];

// ─── Session Types ───────────────────────────────────────────────────────────

export interface PooledSession {
  tenantId: string;
  accessToken: string;
  sessionCookie: string;
  expiresAt: number;           // ms since epoch (parsed from JWT payload.exp)
  proxyUrl: string | null;     // fixed for entire session lifetime
  uaProfile: UAProfile;       // consistent UA for this session
  requestCount: number;
  createdAt: number;
}

// ─── Key Prefixes ────────────────────────────────────────────────────────────

const SESSION_KEY      = (tid: string) => `session:${tid}`;
const LAST_LOGIN_KEY   = (tid: string) => `last_login_at:${tid}`;
const LAST_SYNC_KEY    = (tid: string) => `last_sync_at:${tid}`;
const COOLDOWN_TTL_SEC = 24 * 3600;

// Cooldown rules (separated):
const SCHEDULED_COOLDOWN_MS = 5 * 60_000;  // 5 minutes
const MANUAL_COOLDOWN_MS    = 2 * 60_000;  // 2 minutes

/**
 * GDT Session Pool — manages authenticated sessions in Redis.
 *
 * Key features:
 *   - JWT expiry parsed from token (not hardcoded 25 min)
 *   - Proxy+UA locked to session (anti-detection)
 *   - Login vs Sync cooldown separated
 *   - Session cookies include "Merry-Christmas=..." and others
 */
export class GdtSessionPool {
  constructor(private readonly redis: Redis) {}

  /**
   * Retrieve a cached session for a tenant.
   * Returns null if no session or expired.
   */
  async get(tenantId: string): Promise<PooledSession | null> {
    try {
      const raw = await this.redis.get(SESSION_KEY(tenantId));
      if (!raw) return null;

      const session = JSON.parse(raw) as PooledSession;

      // Check expiry with 5-minute buffer
      if (Date.now() > session.expiresAt - 5 * 60_000) {
        await this.redis.del(SESSION_KEY(tenantId));
        logger.debug('Session expired/near-expiry, removed', { tenantId });
        return null;
      }

      return session;
    } catch {
      return null;
    }
  }

  /**
   * Store a new session after successful login.
   *
   * The TTL is calculated from JWT expiry minus 5-minute buffer.
   * Proxy and UA are locked for the session lifetime.
   */
  async store(session: PooledSession): Promise<void> {
    const ttlMs  = session.expiresAt - Date.now() - 5 * 60_000;
    const ttlSec = Math.max(Math.floor(ttlMs / 1000), 60); // minimum 60s

    try {
      await this.redis.set(
        SESSION_KEY(session.tenantId),
        JSON.stringify(session),
        'EX',
        ttlSec,
      );
      logger.info('Session stored', {
        tenantId: session.tenantId,
        ttlMin: Math.round(ttlSec / 60),
        proxy: session.proxyUrl ? redactProxyUrl(session.proxyUrl) : 'direct',
      });
    } catch (err) {
      logger.error('Failed to store session', { error: (err as Error).message });
    }
  }

  /**
   * Invalidate a session (e.g. after 401 or proxy change).
   */
  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(SESSION_KEY(tenantId));
    logger.info('Session invalidated', { tenantId });
  }

  /**
   * Increment request count for tracking.
   */
  async incrementRequestCount(tenantId: string): Promise<void> {
    try {
      const raw = await this.redis.get(SESSION_KEY(tenantId));
      if (!raw) return;
      const session = JSON.parse(raw) as PooledSession;
      session.requestCount++;
      const ttl = await this.redis.ttl(SESSION_KEY(tenantId));
      if (ttl > 0) {
        await this.redis.set(SESSION_KEY(tenantId), JSON.stringify(session), 'EX', ttl);
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Pick a random UA profile for a new session.
   */
  pickUAProfile(): UAProfile {
    return UA_PROFILES[Math.floor(Math.random() * UA_PROFILES.length)];
  }

  // ─── Login Cooldown (separated from sync cooldown) ─────────────────────────

  /**
   * Record a real GDT login (captcha + auth).
   * Distinct from session reuse — only real logins update this.
   */
  async recordLoginAt(tenantId: string): Promise<void> {
    try {
      await this.redis.set(LAST_LOGIN_KEY(tenantId), String(Date.now()), 'EX', COOLDOWN_TTL_SEC);
    } catch { /* non-fatal */ }
  }

  /**
   * Record any sync activity (session reuse or real login).
   */
  async recordSyncAt(tenantId: string): Promise<void> {
    try {
      await this.redis.set(LAST_SYNC_KEY(tenantId), String(Date.now()), 'EX', COOLDOWN_TTL_SEC);
    } catch { /* non-fatal */ }
  }

  /**
   * Get remaining cooldown in ms (0 = ready).
   *
   * Rules:
   *   Scheduled jobs: check last_sync_at,  cooldown = 5 minutes
   *   Manual jobs:    check last_login_at, cooldown = 2 minutes
   *   Session reuse:  skip cooldown entirely
   */
  async getCooldownMs(
    tenantId: string,
    jobType: 'scheduled' | 'manual',
    isSessionReuse = false,
  ): Promise<number> {
    if (isSessionReuse) return 0;

    try {
      const key = jobType === 'manual' ? LAST_LOGIN_KEY(tenantId) : LAST_SYNC_KEY(tenantId);
      const raw = await this.redis.get(key);
      if (!raw) return 0;

      const last    = parseInt(raw, 10);
      const elapsed = Date.now() - last;
      const limit   = jobType === 'manual' ? MANUAL_COOLDOWN_MS : SCHEDULED_COOLDOWN_MS;
      return Math.max(0, limit - elapsed);
    } catch {
      return 0;
    }
  }

  // ─── Static helpers ────────────────────────────────────────────────────────

  /**
   * Parse JWT expiry from access token.
   *
   * Decodes the payload (2nd part) to get `exp` claim.
   * Does NOT verify signature — just reads expiry timestamp.
   */
  static parseJwtExpiry(accessToken: string): number {
    try {
      const parts = accessToken.split('.');
      if (parts.length < 2) throw new Error('Invalid JWT');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload.exp !== 'number') throw new Error('No exp claim');
      return payload.exp * 1000; // seconds → ms
    } catch {
      // Fallback: 25 minutes from now
      return Date.now() + 25 * 60_000;
    }
  }

  /**
   * Extract session cookies from Set-Cookie headers.
   * Keeps "Merry-Christmas=..." and other session cookies.
   */
  static extractSessionCookie(setCookieHeaders: string[]): string {
    const cookies: string[] = [];
    for (const header of setCookieHeaders) {
      // Extract "name=value" from "name=value; Path=/; HttpOnly; ..."
      const nameValue = header.split(';')[0]?.trim();
      if (nameValue) cookies.push(nameValue);
    }
    return cookies.join('; ');
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function redactProxyUrl(url: string): string {
  return url.replace(/:([^@:]+)@/, ':****@');
}
