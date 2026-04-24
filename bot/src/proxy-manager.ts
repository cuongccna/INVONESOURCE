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

  constructor(proxyList?: string[]) {
    super();
    const raw = proxyList ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.proxies = raw;
    this.failed  = new Set();
    this.index   = 0;
    logger.info(`[ProxyManager] Static pool — ${this.proxies.length} proxies loaded`);
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
      const dbUrls = await staticProxyPool.listActiveUrls();
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
