import * as net from 'net';
import { EventEmitter } from 'events';
import { staticProxyPool } from './static-proxy-pool';
import { logger } from './logger';

export interface AxiosProxyConfig {
  host:     string;
  port:     number;
  auth?:    { username: string; password: string };
  protocol: string;
}

export class ProxyManager extends EventEmitter {
  private proxies: string[];
  private failed:  Set<string>;
  private index:   number;

  private tenantProxyMap = new Map<string, string>();

  /**
   * Per-company rotation index for the detail worker pool.
   * Unlike auto-sync (sticky hash → same proxy every time), detail worker uses
   * round-robin rotation within the non-excluded set so a blocked proxy is
   * automatically skipped on the next cycle without any manual intervention.
   */
  private _detailProxyIndex = new Map<string, number>();

  constructor(proxyList?: string[]) {
    super();
    const raw = proxyList ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.proxies = raw;
    this.failed  = new Set();
    this.index   = 0;
    logger.info(`[ProxyManager] Env PROXY_LIST — ${this.proxies.length} proxies (DB static pool loaded on demand)`);
  }

  next(): string | null {
    if (this.proxies.length === 0) return null;
    const available = this.proxies.filter(p => !this.failed.has(p));
    if (available.length === 0) {
      logger.warn('[ProxyManager] All proxies failed — resetting pool');
      this.reset();
      return this.proxies[0] ?? null;
    }
    const proxy = available[this.index % available.length]!;
    this.index   = (this.index + 1) % available.length;
    return proxy;
  }

  nextForCompany(sessionSuffix: string): string | null {
    const available = this.proxies.filter(p => !this.failed.has(p));
    if (available.length === 0) {
      this.reset();
      return this.proxies[0] ?? null;
    }
    return available[this._hashToIndex(sessionSuffix, available.length)]!;
  }

  nextForSession(sessionId: string): string | null {
    return this.nextForCompany(sessionId);
  }

  nextForTenant(tenantId: string): string | null {
    const assigned = this.tenantProxyMap.get(tenantId);
    if (assigned && !this.failed.has(assigned) && this.proxies.includes(assigned)) {
      return assigned;
    }
    if (assigned) this.tenantProxyMap.delete(tenantId);
    const newProxy = this.nextForCompany(tenantId);
    if (newProxy) this.tenantProxyMap.set(tenantId, newProxy);
    return newProxy;
  }

  clearTenantProxy(tenantId: string): void {
    this.tenantProxyMap.delete(tenantId);
  }

  // Static pool has no SOCKS5 endpoints
  nextSocks5ForCompany(_sessionSuffix: string): string | null {
    return null;
  }

  markFailed(url: string): void {
    this.failed.add(url);
    for (const [tenantId, assigned] of this.tenantProxyMap.entries()) {
      if (assigned === url) this.tenantProxyMap.delete(tenantId);
    }
    logger.warn('[ProxyManager] Marked proxy failed', {
      url,
      remaining: this.proxies.length - this.failed.size,
    });
    this.emit('proxyFailed', url);
  }

  markHealthy(url: string): void {
    this.failed.delete(url);
  }

  async probe(proxyUrl: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };

      let proxy: URL;
      try {
        proxy = new URL(proxyUrl);
      } catch {
        resolve(false);
        return;
      }

      const host = proxy.hostname;
      const port = Number(proxy.port) || 80;

      const socket = net.connect({ host, port });
      const timer  = setTimeout(() => done(false), timeoutMs);

      socket.once('connect', () => done(true));
      socket.once('error',   () => done(false));
    });
  }

  reset(): void {
    this.failed.clear();
    this.index = 0;
  }

  // Static pool is always ready
  async waitUntilReady(_timeoutMs = 15_000): Promise<void> {
    return;
  }

  get size(): number { return this.proxies.length; }
  get failedCount(): number { return this.failed.size; }

  async nextForManualSync(userId: string): Promise<string | null> {
    try {
      const result = await staticProxyPool.acquireForUser(userId);
      if (result) return result.url;
      logger.warn('[ProxyManager] Manual sync: no static proxy assigned for user', {
        userId: userId.slice(0, 8),
      });
      return null;
    } catch (err) {
      logger.error('[ProxyManager] Manual sync: static pool error', {
        userId: userId.slice(0, 8),
        error: (err as Error).message,
      });
      return null;
    }
  }

  async nextForAutoSync(sessionSuffix: string): Promise<string | null> {
    try {
      let dbUrls = await staticProxyPool.listActiveUrls();

      // Fallback: nếu DB pool trống, thử dùng env-based PROXY_LIST
      if (dbUrls.length === 0 && this.proxies.length > 0) {
        logger.warn('[ProxyManager] Auto sync: DB pool empty — falling back to env PROXY_LIST', {
          envProxies: this.proxies.length,
        });
        dbUrls = this.proxies.filter(p => !this.failed.has(p));
        if (dbUrls.length === 0) {
          this.reset();
          dbUrls = this.proxies;
        }
      }

      if (dbUrls.length === 0) {
        logger.warn('[ProxyManager] Auto sync: no active static proxies in DB pool', {
          sessionSuffix: sessionSuffix.slice(0, 8),
        });
        return null;
      }

      let available = dbUrls.filter(url => !this.failed.has(url));
      if (available.length === 0) {
        logger.warn('[ProxyManager] Auto sync: all static proxies are marked failed — resetting pool');
        this.reset();
        available = dbUrls;
      }

      return available[this._hashToIndex(sessionSuffix, available.length)] ?? null;
    } catch (err) {
      logger.error('[ProxyManager] Auto sync: static pool error', {
        sessionSuffix: sessionSuffix.slice(0, 8),
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Select a proxy for the detail worker.
   *
   * Design differs from nextForAutoSync() (sync sticky-hash):
   *   - Uses hash-within-available so each company picks a consistent proxy
   *     from the non-excluded subset, but when a proxy is excluded (TCP blackhole),
   *     the hash naturally maps to the next proxy in the shrunk set.
   *   - excludedUrls: set of proxy URLs that have timed-out for THIS company.
   *     They are excluded from selection so the worker rotates away from a
   *     GDT-blocked IP without marking it globally failed (it may still work for
   *     other companies / endpoints).
   *   - Falls back to env PROXY_LIST if the DB pool is empty.
   *   - Returns null only when ALL proxies are excluded or globally failed.
   *
   * @param companyId    — used to deterministically pick within the available set
   * @param excludedUrls — proxies temporarily excluded for this company (TCP timeouts)
   */
  async nextForDetailWorker(
    companyId: string,
    excludedUrls?: ReadonlySet<string>,
  ): Promise<string | null> {
    try {
      let allUrls = await staticProxyPool.listActiveUrls();

      // Fallback: DB pool empty → try env PROXY_LIST
      if (allUrls.length === 0 && this.proxies.length > 0) {
        logger.warn('[ProxyManager] Detail worker: DB pool empty — falling back to env PROXY_LIST', {
          companyId: companyId.slice(0, 8),
          envProxies: this.proxies.length,
        });
        allUrls = this.proxies;
      }

      if (allUrls.length === 0) {
        logger.warn('[ProxyManager] Detail worker: no proxies configured', {
          companyId: companyId.slice(0, 8),
        });
        return null;
      }

      // Filter out globally-failed + per-company excluded proxies
      const available = allUrls.filter(
        url => !this.failed.has(url) && !(excludedUrls?.has(url) ?? false),
      );

      if (available.length === 0) {
        logger.warn('[ProxyManager] Detail worker: all proxies excluded or failed for company', {
          companyId:     companyId.slice(0, 8),
          totalProxies:  allUrls.length,
          excluded:      excludedUrls?.size ?? 0,
          globalFailed:  this.failed.size,
        });
        return null;
      }

      // Hash-within-available: company gets a stable proxy from the current
      // non-excluded set. When a proxy is excluded, the set shrinks and the
      // hash maps to a different (next) proxy automatically.
      return available[this._hashToIndex(companyId, available.length)] ?? null;
    } catch (err) {
      logger.error('[ProxyManager] Detail worker: proxy selection error', {
        companyId: companyId.slice(0, 8),
        error:     (err as Error).message,
      });
      return null;
    }
  }

  async markStaticBlocked(proxyId: string, userId: string, reason: string): Promise<string | null> {
    try {
      const result = await staticProxyPool.markBlocked(proxyId, userId, reason);
      return result?.url ?? null;
    } catch (err) {
      logger.error('[ProxyManager] Failed to mark static proxy blocked', {
        proxyId: proxyId.slice(0, 8),
        error: (err as Error).message,
      });
      return null;
    }
  }

  private _hashToIndex(s: string, len: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (Math.imul(h, 0x01000193)) >>> 0;
    }
    return h % len;
  }
}

/**
 * Parse a proxy URL string into an Axios-compatible proxy config.
 * Returns false if no proxy (direct connection).
 */
export function parseProxyForAxios(proxyUrl: string | null): AxiosProxyConfig | false {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl);
    const config: AxiosProxyConfig = {
      host:     u.hostname,
      port:     parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80),
      protocol: u.protocol.replace(':', ''),
    };
    if (u.username || u.password) {
      config.auth = {
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      };
    }
    return config;
  } catch {
    const masked = proxyUrl.replace(/:([^@:]+)@/, ':****@');
    logger.error('[ProxyManager] Failed to parse proxy URL', { proxy: masked });
    return false;
  }
}

export const proxyManager = new ProxyManager();

// ── Proxy assignment registry — IP affinity between sync.worker and detail.worker ──
// When sync.worker selects a proxy for a company, it stores the URL here.
// detail.worker reads this key and prefers the same IP to avoid GDT flagging
// simultaneous access from two different IPs for the same account.
const PROXY_ASSIGNMENT_PREFIX = 'gdt:proxy_assignment:';
const PROXY_ASSIGNMENT_TTL_S  = 3600; // 1 hour

export async function storeProxyAssignment(
  redis: import('ioredis').default,
  companyId: string,
  proxyUrl: string,
): Promise<void> {
  try {
    await redis.setex(`${PROXY_ASSIGNMENT_PREFIX}${companyId}`, PROXY_ASSIGNMENT_TTL_S, proxyUrl);
  } catch { /* non-fatal — detail worker will fall back to hash selection */ }
}

export async function getProxyAssignment(
  redis: import('ioredis').default,
  companyId: string,
): Promise<string | null> {
  try {
    return await redis.get(`${PROXY_ASSIGNMENT_PREFIX}${companyId}`);
  } catch {
    return null;
  }
}
