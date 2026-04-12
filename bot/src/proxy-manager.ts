/**
 * BOT-SEC-06 — Proxy Manager
 *
 * Three operating modes — selected automatically at startup:
 *
 * A) TMProxy multi-key pool (TMPROXY_API_KEYS=key1,key2,key3):
 *    • Each API key = 1 dedicated residential IP on TMProxy "Đổi IP" plan.
 *    • nextForCompany() hashes company session suffix → consistent slot → own IP.
 *    • Scale: buy 1 key per ~10 companies.  Cost: 5,000đ/key/day.
 *    • TMPROXY_API_KEY (single key) is also accepted for backward-compat (1-key pool).
 *
 * C) IPRoyal sticky-session pool (preferred for binary downloads — IPROYAL_PROXY_LIST):
 *    • Format: host:port:user:pass per entry, comma-separated.
 *    • Example: geo.iproyal.com:12321:user:pass_country-vn_session-ABC_lifetime-30m,...
 *    • SOCKS5 is derived from the same credentials (same host:port, socks5:// scheme).
 *    • Each session ID in the password gives a sticky IP for 30 min — stable for streams.
 *    • Scale: add more entries to IPROYAL_PROXY_LIST.
 *    • Priority: IPRoyal is checked BEFORE TMProxy when both are configured.
 *
 * B) Static pool fallback (PROXY_LIST env, comma-separated http:// URLs):
 *    • Round-robin across the list; failed ones are skipped until all fail (then reset).
 *    • SOCKS5 NOT available in this mode.
 *
 * How to add more IPRoyal sessions:
 *   Generate new sessions on dashboard.iproyal.com → Residential → Proxy access.
 *   Set session lifetime to 30m. Add to IPROYAL_PROXY_LIST in bot/.env:
 *     IPROYAL_PROXY_LIST=geo.iproyal.com:12321:user:pass_session-A,geo.iproyal.com:12321:user:pass_session-B
 */
import * as net from 'net';
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
  currentExpiresAt:     Date | null;    // when the current IP expires
  refreshing:           boolean;
  failedUrls:           Set<string>;
  permanentlyDead:      boolean;        // true when API key is expired/cancelled — skip forever
}

// ── One slot = one IPRoyal sticky session ────────────────────────────────────
// Both HTTP CONNECT and SOCKS5 share the same host:port — scheme only differs.
// The session ID embedded in the password provides IP stickiness for 30 min.
interface IProyalSlot {
  readonly httpUrl:   string;   // http://user:pass@host:port
  readonly socks5Url: string;   // socks5://user:pass@host:port
  readonly sessionId: string;   // extracted from password for logging
  failed:             boolean;
}

export class ProxyManager extends EventEmitter {
  // ── Mode A: TMProxy multi-key pool ───────────────────────────────────────
  private slots: TmproxySlot[] = [];

  // ── Mode C: IPRoyal sticky-session pool ──────────────────────────────────
  private iproyalSlots: IProyalSlot[] = [];

  // ── Mode B: static pool ──────────────────────────────────────────────────
  private proxies: string[];
  private failed:  Set<string>;
  private index:   number;

  // ── BOT-ENT-04: Per-tenant proxy affinity map ────────────────────────────
  // tenantId → last assigned proxy URL (persists across sessions)
  private tenantProxyMap = new Map<string, string>();

  constructor(proxyList?: string[]) {
    super();
    const raw = proxyList ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    this.proxies = raw;
    this.failed  = new Set();
    this.index   = 0;

    // ── Mode C: IPRoyal sticky-session pool ──────────────────────────────
    // Format: host:port:user:pass  (comma-separated, one entry per session)
    // Example: geo.iproyal.com:12321:user:pass_country-vn_session-ABC_lifetime-30m
    const iproyalRaw = (process.env['IPROYAL_PROXY_LIST'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (iproyalRaw.length > 0) {
      this.iproyalSlots = iproyalRaw.map(entry => {
        // Format is host:port:user:pass — but password may contain colons
        // Split on first 3 colons only to preserve password intact
        const firstColon  = entry.indexOf(':');
        const secondColon = entry.indexOf(':', firstColon + 1);
        const thirdColon  = entry.indexOf(':', secondColon + 1);
        if (firstColon < 0 || secondColon < 0 || thirdColon < 0) {
          throw new Error(`IPROYAL_PROXY_LIST: invalid entry format "${entry.slice(0, 30)}…" — expected host:port:user:pass`);
        }
        const host = entry.slice(0, firstColon);
        const port = entry.slice(firstColon + 1, secondColon);
        const user = entry.slice(secondColon + 1, thirdColon);
        const pass = entry.slice(thirdColon + 1);
        // Extract session ID from password for readable logging
        const sessionMatch = pass.match(/_session-([^_]+)/);
        const sessionId    = sessionMatch?.[1] ?? pass.slice(-8);
        const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
        return {
          httpUrl:   `http://${auth}@${host}:${port}`,
          socks5Url: `socks5://${auth}@${host}:${port}`,
          sessionId,
          failed:    false,
        };
      });
      logger.info('[ProxyManager] IPRoyal sticky pool initialised', {
        slots:    this.iproyalSlots.length,
        sessions: this.iproyalSlots.map(s => s.sessionId),
      });
    }

    // ── Mode A: TMProxy multi-key pool ───────────────────────────────────
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
        currentExpiresAt: null,
        currentUrl:       null,
        currentSocks5Url: null,
        refreshing:       false,
        failedUrls:       new Set<string>(),
        permanentlyDead:  false,
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
      // Auto-recovery timer: thử khôi phục slot hết hạn sau mỗi 30 phút
      this._startDeadSlotRetryTimer();
    }

    if (this.iproyalSlots.length === 0 && allKeys.length === 0) {
      logger.info(`[ProxyManager] Static pool — ${this.proxies.length} proxies loaded`);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Return the next proxy URL (round-robin for static pool, first slot for TMProxy).
   * Used only for non-company-specific calls (health checks etc).
   */
  next(): string | null {
    if (this.iproyalSlots.length > 0) {
      const slot = this.iproyalSlots.find(s => !s.failed) ?? this.iproyalSlots[0]!;
      return slot.httpUrl;
    }
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
    // Mode C: IPRoyal — hash to consistent slot, skip failed slots
    if (this.iproyalSlots.length > 0) {
      const available = this.iproyalSlots.filter(s => !s.failed);
      const pool = available.length > 0 ? available : this.iproyalSlots;
      return pool[this._hashToIndex(sessionSuffix, pool.length)]!.httpUrl;
    }

    // Mode A: TMProxy
    if (this.slots.length > 0) {
      // Exclude permanently dead slots (expired API keys) from hash pool
      const liveSlots = this.slots.filter(s => !s.permanentlyDead);
      const pool      = liveSlots.length > 0 ? liveSlots : this.slots; // fallback: use all
      const slotIdx   = this._hashToIndex(sessionSuffix, pool.length);
      const slot      = pool[slotIdx]!;
      if (!slot.currentUrl) {
        // Slot đang khởi tạo — thử slot sẵn sàng khác (không đang refreshing)
        const fallback = pool.find(s => s.currentUrl && !s.refreshing)
                      ?? this.slots.find(s => s.currentUrl && !s.refreshing);
        if (!fallback) {
          // Tất cả slot đang khởi tạo — caller cần xử lý null
          // Auto-recovery: nếu slot bị stuck (null + not refreshing), kick off rotation lại
          const stuckSlots = this.slots.filter(s => !s.currentUrl && !s.refreshing && !s.permanentlyDead);
          for (const stuckSlot of stuckSlots) {
            logger.info('[ProxyManager] Auto-recovering stuck slot — retrying rotation', {
              apiKey: stuckSlot.apiKey.slice(0, 8) + '…',
            });
            this._rotateSlot(stuckSlot);
          }
          logger.warn('[ProxyManager] Tất cả slot đang khởi tạo, chờ slot đầu tiên sẵn sàng', {
            sessionSuffix:   sessionSuffix.slice(0, 8),
            refreshingSlots: this.slots.filter(s => s.refreshing).length,
          });
          return null; // caller phải xử lý null một cách an toàn
        }
        logger.debug('[ProxyManager] Slot chưa sẵn sàng, dùng fallback', {
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
   * Return the proxy URL pinned to this session ID.
   * Alias for nextForCompany() — used by verification.worker.ts and tracuunnt-crawler.ts.
   */
  nextForSession(sessionId: string): string | null {
    return this.nextForCompany(sessionId);
  }

  /**
   * BOT-ENT-04: Per-tenant proxy affinity.
   * Prefer re-using the same proxy for the same tenant across sessions,
   * so GDT sees a consistent IP per company rather than random rotation.
   * Falls back to nextForCompany() if the previously assigned proxy is unhealthy.
   */
  nextForTenant(tenantId: string): string | null {
    // Check if tenant has a healthy assigned proxy
    const assigned = this.tenantProxyMap.get(tenantId);
    if (assigned) {
      const isHealthy = this.slots.length > 0
        ? this.slots.some(s => s.currentUrl === assigned)
        : !this.failed.has(assigned) && this.proxies.includes(assigned);
      if (isHealthy) return assigned;
      // Assigned proxy degraded — clear and pick a new one
      this.tenantProxyMap.delete(tenantId);
    }

    const newProxy = this.nextForCompany(tenantId);
    if (newProxy) this.tenantProxyMap.set(tenantId, newProxy);
    return newProxy;
  }

  /** Clear a tenant's proxy assignment — called when proxy fails for that tenant. */
  clearTenantProxy(tenantId: string): void {
    this.tenantProxyMap.delete(tenantId);
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
    // Mode C: IPRoyal — same slot as nextForCompany, return socks5Url
    if (this.iproyalSlots.length > 0) {
      const available = this.iproyalSlots.filter(s => !s.failed);
      const pool = available.length > 0 ? available : this.iproyalSlots;
      return pool[this._hashToIndex(sessionSuffix, pool.length)]!.socks5Url;
    }

    // Mode A: TMProxy
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
    // Mode C: IPRoyal
    const iproyalSlot = this.iproyalSlots.find(s => s.httpUrl === url || s.socks5Url === url);
    if (iproyalSlot) {
      iproyalSlot.failed = true;
      logger.warn('[ProxyManager] IPRoyal slot marked failed', {
        sessionId: iproyalSlot.sessionId,
        remaining: this.iproyalSlots.filter(s => !s.failed).length,
      });
      this.emit('proxyFailed', url);
      return;
    }

    // Mode A: TMProxy
    if (this.slots.length > 0) {
      const slot = this.slots.find(s => s.currentUrl === url);
      if (slot) {
        slot.failedUrls.add(url);
        // Nullify ngay lập tức để nextForCompany không trả về URL lỗi trong thời gian xoay IP
        slot.currentUrl       = null;
        slot.currentSocks5Url = null;
        logger.warn('[ProxyManager] Slot bị đánh dấu lỗi — đang xoay IP mới', {
          apiKey:    slot.apiKey.slice(0, 8) + '…',
          failedUrl: url.replace(/:([^@:]+)@/, ':****@'),
        });
        // Clear any tenant affinity that points to this failed proxy so tenants
        // don't get re-assigned the broken URL.
        for (const [tenantId, assigned] of this.tenantProxyMap.entries()) {
          if (assigned === url) {
            this.tenantProxyMap.delete(tenantId);
            logger.info('[ProxyManager] Xóa affinity proxy cho tenant do proxy lỗi', {
              tenantId: tenantId.slice(0, 8),
              proxy:    url.replace(/:([^@:]+)@/, ':****@'),
            });
          }
        }
        // Emit proxyFailed for TMProxy mode (parity with IPRoyal/static branches)
        this.emit('proxyFailed', url);
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

  /**
   * Proactively rotate the TMProxy IP for this company's slot if the current IP
   * expires within minTtlMs milliseconds.
   * Call before starting a sync so the IP never expires mid-run.
   * Returns true if a rotation was triggered (caller can await the new URL).
   * No-op for IPRoyal / static-pool modes.
   */
  async refreshIfExpiringSoon(sessionSuffix: string, minTtlMs = 3 * 60_000): Promise<boolean> {
    if (this.slots.length === 0) return false;
    const slotIdx = this._hashToIndex(sessionSuffix, this.slots.length);
    const slot    = this.slots[slotIdx]!;
    if (!slot.currentExpiresAt) return false;
    const ttlMs = slot.currentExpiresAt.getTime() - Date.now();
    if (ttlMs > minTtlMs) return false;
    logger.warn('[ProxyManager] Proxy IP expiring soon — rotating before sync', {
      apiKey:    slot.apiKey.slice(0, 8) + '…',
      expiresAt: slot.currentExpiresAt.toISOString(),
      ttlSec:    Math.round(ttlMs / 1000),
    });
    try {
      const session = await slot.refresher.getNew();
      slot.currentUrl       = session.url;
      slot.currentSocks5Url = session.socks5Url;
      slot.currentExpiresAt = session.expiresAt;
      logger.info('[ProxyManager] Proactive proxy rotation done', {
        apiKey: slot.apiKey.slice(0, 8) + '…', publicIp: session.publicIp,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (err) {
      logger.error('[ProxyManager] Proactive rotation failed (proceeding with current IP)', {
        apiKey: slot.apiKey.slice(0, 8) + '…', err: (err as Error).message,
      });
    }
    return true;
  }

  markHealthy(url: string): void {
    // Mode C: IPRoyal
    const iproyalSlot = this.iproyalSlots.find(s => s.httpUrl === url || s.socks5Url === url);
    if (iproyalSlot) {
      iproyalSlot.failed = false;
      return;
    }

    this.failed.delete(url);
    for (const slot of this.slots) slot.failedUrls.delete(url);
  }

  /**
   * Lightweight TCP probe to check if a proxy is reachable before committing to a sync.
   *
   * Opens a TCP connection to the proxy host:port and waits for the socket to connect.
   * Does NOT send any HTTP/SOCKS data — just checks the TCP layer.
   *
   * Returns true if the proxy TCP port is reachable within timeoutMs.
   * Returns false on timeout, ECONNREFUSED, EHOSTUNREACH, or any other connection error.
   *
   * A successful TCP connect does NOT guarantee the proxy will authenticate correctly,
   * but it eliminates the most common failure (proxy server down / wrong port / blocked IP).
   *
   * Usage before sync:
   *   if (proxyUrl && !await proxyManager.probe(proxyUrl)) {
   *     proxyManager.markFailed(proxyUrl);
   *     throw new Error('Proxy health check failed — aborting sync');
   *   }
   */
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
        // unparseable proxy URL — treat as failed
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

  /**
   * Chờ đến khi ít nhất một slot TMProxy có currentUrl !== null.
   * Gọi khi khởi động server để tránh sync chạy trước khi proxy sẵn sàng.
   * Không áp dụng cho IPRoyal (luôn sẵn sàng) hoặc static pool.
   */
  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    if (this.slots.length === 0) return; // IPRoyal / static pool — luôn sẵn sàng
    const deadline = Date.now() + timeoutMs;
    const POLL_MS  = 300;
    while (Date.now() < deadline) {
      if (this.slots.some(s => s.currentUrl !== null)) {
        const readyCount = this.slots.filter(s => s.currentUrl !== null).length;
        const deadCount  = this.slots.length - readyCount;
        if (deadCount > 0) {
          logger.warn('[ProxyManager] Một số slot proxy bị lỗi — bot chạy với proxy bị suy giảm', {
            readySlots: readyCount,
            deadSlots:  deadCount,
            totalSlots: this.slots.length,
            hint: 'Kiểm tra TMProxy key hết hạn hoặc lỗi API',
          });
        } else {
          logger.info('[ProxyManager] Tất cả slot proxy đã sẵn sàng');
        }
        return;
      }
      await new Promise<void>(r => setTimeout(r, POLL_MS));
    }
    logger.warn('[ProxyManager] Chờ proxy quá thời gian — tiếp tục không có proxy sẵn sàng', {
      timeoutMs,
    });
    // Không throw — graceful degradation
  }

  get size(): number {
    if (this.iproyalSlots.length > 0) return this.iproyalSlots.length;
    return this.slots.length > 0 ? this.slots.length : this.proxies.length;
  }
  get failedCount(): number { return this.failed.size; }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Hash chuỗi → chỉ số trong [0, len) — FNV-1a, phân bố đều hơn djb2 cho UUID */
  private _hashToIndex(s: string, len: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (Math.imul(h, 0x01000193)) >>> 0;
    }
    return h % len;
  }

  /**
   * Phân bố company theo slot — dùng cho admin dashboard / giám sát.
   * companyCount = 0 ở đây; caller tự populate từ DB:
   *   SELECT proxy_slot_idx, count(*) FROM gdt_bot_configs GROUP BY proxy_slot_idx
   */
  getSlotDistribution(): Array<{ apiKey: string; companyCount: number; publicIp: string | null }> {
    return this.slots.map(slot => {
      let publicIp: string | null = null;
      if (slot.currentUrl) {
        try { publicIp = new URL(slot.currentUrl).hostname; } catch { /* URL không hợp lệ */ }
      }
      return {
        apiKey:       slot.apiKey.slice(0, 8) + '…',
        publicIp,
        companyCount: 0,
      };
    });
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
        // Check if the error message indicates an expired/cancelled package (code=6).
        // These are permanent failures — no point retrying this key ever.
        const msg = (err as Error).message ?? '';
        if (msg.includes('code=6') || msg.includes('Hết hạn') || msg.includes('Gói Hết hạn')) {
          slot.permanentlyDead = true;
          logger.error('[ProxyManager] TMProxy key hết hạn — slot bị loại khỏi vòng xúy', {
            apiKey: slot.apiKey.slice(0, 8) + '…',
            hint:   'Gia hạn hoặc thay API key mới tại tmproxy.com',
          });
        }
        throw err;
      }
    }
    slot.currentUrl       = session.url;
    slot.currentSocks5Url = session.socks5Url;
    slot.currentExpiresAt = session.expiresAt;
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
        slot.currentExpiresAt = session.expiresAt;
        logger.info('[ProxyManager] TMProxy slot rotated', {
          apiKey: slot.apiKey.slice(0, 8) + '…', publicIp: session.publicIp,
        });
        this.emit('proxyRotated', session.url);
      })
      .catch(err => {
        const msg = (err as Error).message ?? '';
        // code=6 = gói hết hạn / key bị huỷ — đánh dấu permanentlyDead để ngừng retry tức thì.
        // _startDeadSlotRetryTimer() sẽ thử lại mỗi 30 phút khi người dùng gia hạn.
        if (msg.includes('code=6') || msg.includes('Hết hạn') || msg.includes('Gói Hết hạn')) {
          slot.permanentlyDead = true;
          logger.error('[ProxyManager] TMProxy key hết hạn khi xoay IP — slot bị loại khỏi vòng quay', {
            apiKey: slot.apiKey.slice(0, 8) + '…',
            hint:   'Gia hạn tại tmproxy.com → bot tự phục hồi trong vòng 30 phút',
          });
        } else {
          logger.error('[ProxyManager] Xoay IP thất bại — slot sẽ được thử lại qua timer', {
            apiKey: slot.apiKey.slice(0, 8) + '…',
            error:  msg,
          });
        }
        slot.currentUrl       = null;
        slot.currentSocks5Url = null;
      })
      .finally(() => { slot.refreshing = false; });
  }

  /**
   * Chạy một timer mỗi 30 phút để thử khôi phục các slot bị permanentlyDead.
   * Khi người dùng gia hạn gói TMProxy (cùng API key), slot sẽ tự phục hồi
   * mà không cần restart bot.
   */
  private _startDeadSlotRetryTimer(): void {
    const RETRY_INTERVAL_MS = 30 * 60 * 1000; // 30 phút
    setInterval(async () => {
      const deadSlots = this.slots.filter(s => s.permanentlyDead);
      if (deadSlots.length === 0) return;
      logger.info('[ProxyManager] Kiểm tra slot hết hạn — thử khôi phục', {
        count: deadSlots.length,
      });
      for (const slot of deadSlots) {
        try {
          slot.permanentlyDead = false; // tạm thời mở để thử
          await this._initSlot(slot);
          logger.info('[ProxyManager] Slot đã phục hồi sau khi gia hạn', {
            apiKey: slot.apiKey.slice(0, 8) + '…',
          });
        } catch {
          slot.permanentlyDead = true; // vẫn chết — giữ nguyên
        }
      }
    }, RETRY_INTERVAL_MS);
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
    // CRITICAL: auth must be passed separately so axios auto-sets Proxy-Authorization header
    // Condition checks username OR password — handles edge cases where only one is present
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

