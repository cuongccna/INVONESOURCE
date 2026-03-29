/**
 * BOT-SEC-06 — Proxy Manager
 *
 * Three operating modes — selected automatically at startup:
 *
 * A) TMProxy multi-key pool (preferred — TMPROXY_API_KEYS=key1,key2,key3):
 *    • Each API key = 1 dedicated residential IP on TMProxy "Đổi IP" plan.
 *    • nextForCompany() hashes company session suffix → consistent slot → own IP.
 *    • GDT sees a different IP per company (N companies ÷ N keys = 1 IP each).
 *    • Scale: buy 1 key per ~10 companies.  Cost: 5,000đ/key/day.
 *    • TMPROXY_API_KEY (single key) is also accepted for backward-compat (1-key pool).
 *
 * B) Static pool fallback (PROXY_LIST env, comma-separated http:// URLs):
 *    • Round-robin across the list; failed ones are skipped until all fail (then reset).
 *
 * How to add more TMProxy API keys:
 *   1. Buy additional "Đổi IP" APIs on tmproxy.com dashboard.
 *   2. Add all keys (including the existing one) to TMPROXY_API_KEYS in bot/.env:
 *         TMPROXY_API_KEYS=4c0320b1...,newkey2,newkey3
 *   3. Restart bot — companies are automatically redistributed across keys.
 */
import { EventEmitter } from 'events';
import { TmproxyRefresher, TmproxyNoSessionError } from './tmproxy-refresher';
import { logger } from './logger';

export interface AxiosProxyConfig {
  host:     string;
  port:     number;
  auth?:    { username: string; password: string };
  protocol: string;
}

// ── One slot = one TMProxy API key + its state ────────────────────────────────
interface TmproxySlot {
  readonly apiKey:      string;
  refresher:            TmproxyRefresher;
  currentUrl:           string | null;  // http:// for HTTP CONNECT (JSON API)
  currentSocks5Url:     string | null;  // socks5:// for binary downloads (ZIP/XLSX)
  refreshing:           boolean;
  failedUrls:           Set<string>;
}

export class ProxyManager extends EventEmitter {
  // ── Mode A: TMProxy multi-key pool ───────────────────────────────────────
  private slots: TmproxySlot[] = [];

  // ── Mode B: static pool ──────────────────────────────────────────────────
  private proxies: string[];
  private failed:  Set<string>;
  private index:   number;

  constructor(proxyList?: string[]) {
    super();
    const raw = proxyList ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.proxies = raw;
    this.failed  = new Set();
    this.index   = 0;

    // Collect all TMProxy API keys:
    //   TMPROXY_API_KEYS=key1,key2,key3   (preferred — multi-key pool)
    //   TMPROXY_API_KEY=key1              (single key — backward-compat)
    const multiKeys = (process.env['TMPROXY_API_KEYS'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const singleKey = process.env['TMPROXY_API_KEY']?.trim();
    const allKeys   = multiKeys.length > 0
      ? multiKeys
      : singleKey ? [singleKey] : [];

    if (allKeys.length > 0) {
      this.slots = allKeys.map(apiKey => ({
        apiKey,
        refresher:        new TmproxyRefresher(apiKey),
        currentUrl:       null,
        currentSocks5Url: null,
        refreshing:       false,
        failedUrls:       new Set<string>(),
      }));

      logger.info('[ProxyManager] TMProxy multi-key pool initialising', {
        keyCount: this.slots.length,
      });

      // Fire-and-forget: seed all slots with their current IP
      for (const slot of this.slots) {
        this._initSlot(slot).catch(err => {
          logger.warn('[ProxyManager] Could not load TMProxy session for slot', {
            apiKey: slot.apiKey.slice(0, 8) + '…',
            error:  (err as Error).message,
          });
        });
      }
    } else {
      logger.info(`[ProxyManager] Static pool — ${this.proxies.length} proxies loaded`);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Return the next proxy URL (round-robin for static pool, first slot for TMProxy).
   * Used only for non-company-specific calls (health checks etc).
   */
  next(): string | null {
    if (this.slots.length > 0) return this.slots[0]!.currentUrl;

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

  /**
   * Return a proxy URL pinned to this company's session suffix.
   *
   * Mode A (TMProxy pool):
   *   Hashes sessionSuffix → selects a consistent slot index.
   *   Each company always maps to the same API key (same IP) across runs.
   *   Companies are spread evenly across all available keys.
   *   e.g. 3 keys, 30 companies → 10 companies per IP.
   *
   * Mode B (static pool):
   *   Same deterministic hash → consistent pool entry per company.
   */
  nextForCompany(sessionSuffix: string): string | null {
    if (this.slots.length > 0) {
      const slotIdx = this._hashToIndex(sessionSuffix, this.slots.length);
      const slot    = this.slots[slotIdx]!;
      if (!slot.currentUrl) {
        // Slot still initialising — fall back to first available slot
        const fallback = this.slots.find(s => s.currentUrl);
        if (!fallback) return null;
        logger.debug('[ProxyManager] Slot not ready, using fallback', {
          wantedSlot: slotIdx, fallbackKey: fallback.apiKey.slice(0, 8) + '…',
        });
        return fallback.currentUrl;
      }
      return slot.currentUrl;
    }

    // Static pool — deterministic
    const available = this.proxies.filter(p => !this.failed.has(p));
    if (available.length === 0) {
      this.reset();
      return this.proxies[0] ?? null;
    }
    return available[this._hashToIndex(sessionSuffix, available.length)]!;
  }

  /**
   * Return the SOCKS5 proxy URL for this company's session.
   *
   * SOCKS5 is used for binary downloads (ZIP/XLSX export from GDT).
   * Unlike HTTP CONNECT proxies, SOCKS5 is a transparent TCP relay:
   * no content inspection, no binary filtering, no port restrictions.
   *
   * Returns null for static-pool mode (those entries are HTTP proxies only).
   */
  nextSocks5ForCompany(sessionSuffix: string): string | null {
    if (this.slots.length > 0) {
      const slotIdx = this._hashToIndex(sessionSuffix, this.slots.length);
      const slot    = this.slots[slotIdx]!;
      if (!slot.currentSocks5Url) {
        const fallback = this.slots.find(s => s.currentSocks5Url);
        return fallback?.currentSocks5Url ?? null;
      }
      return slot.currentSocks5Url;
    }
    // Static pool does not expose SOCKS5 endpoints
    return null;
  }

  /**
   * Mark a proxy URL as failed.
   * Mode A: triggers background IP rotation on the owning TMProxy slot.
   * Mode B: removes from round-robin.
   */
  markFailed(url: string): void {
    if (this.slots.length > 0) {
      const slot = this.slots.find(s => s.currentUrl === url);
      if (slot) {
        slot.failedUrls.add(url);
        this._rotateSlot(slot);
      }
      return;
    }
    this.failed.add(url);
    logger.warn('[ProxyManager] Marked proxy failed', {
      url,
      remaining: this.proxies.length - this.failed.size,
    });
    this.emit('proxyFailed', url);
  }

  markHealthy(url: string): void {
    this.failed.delete(url);
    for (const slot of this.slots) slot.failedUrls.delete(url);
  }

  reset(): void {
    this.failed.clear();
    this.index = 0;
  }

  get size(): number {
    return this.slots.length > 0 ? this.slots.length : this.proxies.length;
  }
  get failedCount(): number { return this.failed.size; }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Deterministic hash of string → index in range [0, len) */
  private _hashToIndex(s: string, len: number): number {
    const h = [...s].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
    return h % len;
  }

  /** Seed a slot with its current TMProxy IP (no rotation). */
  private async _initSlot(slot: TmproxySlot): Promise<void> {
    let session;
    try {
      session = await slot.refresher.getCurrent();
    } catch (err) {
      if (err instanceof TmproxyNoSessionError) {
        // Key is valid but no session has ever been started (code=27).
        // Automatically request a fresh IP instead of failing silently.
        logger.warn('[ProxyManager] No active session for slot — requesting new IP automatically', {
          apiKey: slot.apiKey.slice(0, 8) + '…',
        });
        session = await slot.refresher.getNew();
      } else {
        throw err;
      }
    }
    slot.currentUrl       = session.url;
    slot.currentSocks5Url = session.socks5Url;
    logger.info('[ProxyManager] TMProxy slot ready', {
      apiKey:    slot.apiKey.slice(0, 8) + '…',
      publicIp:  session.publicIp,
      expiresAt: session.expiresAt.toISOString(),
      hasSocks5: !!session.socks5Url,
    });
  }

  /** Rotate a slot's IP in the background. */
  private _rotateSlot(slot: TmproxySlot): void {
    if (slot.refreshing) return;
    slot.refreshing = true;
    slot.refresher.getNew()
      .then(session => {
        slot.currentUrl       = session.url;
        slot.currentSocks5Url = session.socks5Url;
        logger.info('[ProxyManager] TMProxy slot rotated', {
          apiKey: slot.apiKey.slice(0, 8) + '…', publicIp: session.publicIp,
        });
        this.emit('proxyRotated', session.url);
      })
      .catch(err => {
        logger.error('[ProxyManager] TMProxy slot rotation failed', {
          apiKey: slot.apiKey.slice(0, 8) + '…',
          error:  (err as Error).message,
        });
        slot.currentUrl       = null;
        slot.currentSocks5Url = null;
      })
      .finally(() => { slot.refreshing = false; });
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

