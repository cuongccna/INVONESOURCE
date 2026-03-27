/**
 * BOT-SEC-06 — Proxy Manager
 * Round-robin pool from PROXY_LIST env var (comma-separated socks5/http URLs).
 * Marks failed proxies, resets when all fail.
 */
import { EventEmitter } from 'events';
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

  constructor(proxyList?: string[]) {
    super();
    const raw = proxyList ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.proxies = raw;
    this.failed  = new Set();
    this.index   = 0;
    logger.info(`[ProxyManager] Loaded ${this.proxies.length} proxies`);
  }

  /** Return next available proxy URL, or null if no proxies configured */
  next(): string | null {
    if (this.proxies.length === 0) return null;

    const available = this.proxies.filter(p => !this.failed.has(p));
    if (available.length === 0) {
      logger.warn('[ProxyManager] All proxies failed — resetting');
      this.reset();
      return this.proxies[0] ?? null;
    }

    const proxy = available[this.index % available.length]!;
    this.index = (this.index + 1) % available.length;
    return proxy;
  }

  markFailed(url: string): void {
    this.failed.add(url);
    logger.warn('[ProxyManager] Marked failed', { url, remaining: this.proxies.length - this.failed.size });
    this.emit('proxyFailed', url);
  }

  markHealthy(url: string): void {
    this.failed.delete(url);
  }

  reset(): void {
    this.failed.clear();
    this.index = 0;
  }

  get size(): number { return this.proxies.length; }
  get failedCount(): number { return this.failed.size; }
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
      port:     parseInt(u.port, 10) || 1080,
      protocol: u.protocol.replace(':', ''),
    };
    if (u.username) {
      config.auth = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    }
    return config;
  } catch {
    logger.error('[ProxyManager] Failed to parse proxy URL', { proxyUrl });
    return false;
  }
}

export const proxyManager = new ProxyManager();
