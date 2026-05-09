/**
 * MKVN Rotating Proxy Provider — Plugin
 *
 * Session-based rotating proxy từ proxy.mkvn.net (SP07 API).
 * Session được lưu Redis để chia sẻ giữa sync.worker, detail.worker, manual sync
 * chạy trong các process riêng biệt mà không cần gọi get_new trùng lặp.
 *
 * Rotation rules:
 *  - Tự động renew khi session còn < SESSION_EXPIRE_BUFFER_MS
 *  - Không rotate quá 1 lần / MIN_ROTATION_MS (enforce qua Redis key)
 *  - forceRotate() dùng sau khi GDT báo lỗi proxy (vẫn tuân thủ min rotation)
 *
 * Env: MKVN_PROXY_TOKEN — nếu không set, provider không hoạt động (no-op)
 */
import type IORedis from 'ioredis';
import axios from 'axios';
import { logger } from '../logger';

interface MkvnApiResponse {
  status:              string;
  statusCode:          number;
  token:               string;
  proxy:               string;  // "HOST:PORT:USER:PASS"
  proxy_socks:         string;  // "HOST:PORT:USER:PASS"
  ip_real:             string;
  country:             string;
  type:                string;
  time_seconds_to_die: string;
}

interface MkvnSession {
  proxy:       string;  // "HOST:PORT:USER:PASS"
  proxy_socks: string;
  ip_real:     string;
  fetchedAt:   number;  // ms
  expiresAt:   number;  // ms
}

const API_BASE               = 'https://proxy.mkvn.net/sp07api';
const MIN_ROTATION_MS        = 65_000;   // 62s API minimum + 3s buffer
const SESSION_EXPIRE_BUFFER  = 90_000;   // renew session 90s before expiry
const FETCH_TIMEOUT_MS       = 12_000;
const REDIS_SESSION_PREFIX   = 'mkvn:proxy:session:';
const REDIS_ROTATED_PREFIX   = 'mkvn:proxy:rotated:';

export class MkvnRotatingProxyProvider {
  private readonly redis:      IORedis;
  private readonly token:      string;
  private readonly sessionKey: string;
  private readonly rotateKey:  string;

  constructor(token: string, redis: IORedis) {
    this.token      = token;
    this.redis      = redis;
    // Key uses first 12 chars so logs don't expose full token
    const prefix    = token.slice(0, 12);
    this.sessionKey = `${REDIS_SESSION_PREFIX}${prefix}`;
    this.rotateKey  = `${REDIS_ROTATED_PREFIX}${prefix}`;
  }

  /** HTTP proxy URL (http://user:pass@host:port). Creates/renews session as needed. */
  async getHttpProxyUrl(): Promise<string> {
    const s = await this._getOrRefreshSession();
    return _toHttpUrl(s.proxy);
  }

  /** SOCKS5 proxy URL. Creates/renews session as needed. */
  async getSocks5ProxyUrl(): Promise<string> {
    const s = await this._getOrRefreshSession();
    return _toSocks5Url(s.proxy_socks);
  }

  /**
   * Force rotate to a new IP — call after confirmed proxy failure.
   * Still enforces MIN_ROTATION_MS to comply with provider constraints.
   */
  async forceRotate(): Promise<string> {
    const s = await this._fetchNewSession(true);
    return _toHttpUrl(s.proxy);
  }

  /** Current session metadata for logging. Returns null if no active session. */
  async getSessionInfo(): Promise<{ ip_real: string; proxyHost: string; expiresAt: Date } | null> {
    try {
      const raw = await this.redis.get(this.sessionKey);
      if (!raw) return null;
      const s = JSON.parse(raw) as MkvnSession;
      const [host] = s.proxy.split(':');
      return { ip_real: s.ip_real, proxyHost: host ?? '', expiresAt: new Date(s.expiresAt) };
    } catch {
      return null;
    }
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private async _getOrRefreshSession(): Promise<MkvnSession> {
    try {
      const raw = await this.redis.get(this.sessionKey);
      if (raw) {
        const s = JSON.parse(raw) as MkvnSession;
        if (s.expiresAt - Date.now() > SESSION_EXPIRE_BUFFER) {
          return s;
        }
        logger.debug('[MKVN] Session expiring soon — refreshing', {
          ttlSec: Math.round((s.expiresAt - Date.now()) / 1000),
        });
      }
    } catch {
      // Redis read error or corrupted JSON — fall through to fetch new
    }
    return this._fetchNewSession(false);
  }

  private async _fetchNewSession(forced: boolean): Promise<MkvnSession> {
    // Enforce min rotation interval across processes via Redis
    try {
      const lastRaw = await this.redis.get(this.rotateKey);
      if (lastRaw) {
        const elapsed = Date.now() - parseInt(lastRaw, 10);
        if (elapsed < MIN_ROTATION_MS) {
          const wait = MIN_ROTATION_MS - elapsed;
          logger.debug('[MKVN] Waiting for min rotation interval', { waitMs: wait, forced });
          await new Promise<void>(r => setTimeout(r, wait));
        }
      }
    } catch { /* non-fatal — continue */ }

    // Write rotate timestamp before network call to prevent parallel races
    await this.redis.set(this.rotateKey, String(Date.now()), 'EX', 120).catch(() => {});

    logger.info('[MKVN] Requesting new proxy session', {
      forced,
      token: this.token.slice(0, 8) + '...',
    });

    let data: MkvnApiResponse;
    try {
      const resp = await axios.get<MkvnApiResponse>(
        `${API_BASE}/get_new?token=${encodeURIComponent(this.token)}`,
        { timeout: FETCH_TIMEOUT_MS },
      );
      data = resp.data;
    } catch (err) {
      throw new Error(`MKVN API request failed: ${(err as Error).message}`);
    }

    if (data.status !== 'SUCCESS' || !data.proxy) {
      throw new Error(`MKVN API returned error: status=${data.status} code=${data.statusCode}`);
    }

    const ttlMs = parseInt(data.time_seconds_to_die, 10) * 1_000;
    const session: MkvnSession = {
      proxy:       data.proxy,
      proxy_socks: data.proxy_socks,
      ip_real:     data.ip_real,
      fetchedAt:   Date.now(),
      expiresAt:   Date.now() + ttlMs,
    };

    // Persist with TTL = session lifetime minus 30s buffer
    const redisTtl = Math.max(60, Math.floor(ttlMs / 1000) - 30);
    await this.redis.set(this.sessionKey, JSON.stringify(session), 'EX', redisTtl).catch(() => {});

    const [proxyHost, proxyPort] = data.proxy.split(':');
    logger.info('[MKVN] New proxy session acquired', {
      ip_real:  data.ip_real,
      proxy:    `${proxyHost}:${proxyPort}`,
      country:  data.country,
      ttlMin:   Math.round(ttlMs / 60_000),
    });

    return session;
  }
}

// ── URL formatting helpers ────────────────────────────────────────────────────

function _toHttpUrl(field: string): string {
  const [host, port, user, pass] = field.split(':');
  return `http://${encodeURIComponent(user ?? '')}:${encodeURIComponent(pass ?? '')}@${host ?? ''}:${port ?? ''}`;
}

function _toSocks5Url(field: string): string {
  const [host, port, user, pass] = field.split(':');
  return `socks5://${encodeURIComponent(user ?? '')}:${encodeURIComponent(pass ?? '')}@${host ?? ''}:${port ?? ''}`;
}

// ── Singleton registry ────────────────────────────────────────────────────────

const _instances = new Map<string, MkvnRotatingProxyProvider>();

/**
 * Get (or create) singleton provider for a given token.
 * Safe to call from multiple workers — Redis deduplicates session fetches.
 */
export function getMkvnProvider(token: string, redis: IORedis): MkvnRotatingProxyProvider {
  if (!_instances.has(token)) {
    _instances.set(token, new MkvnRotatingProxyProvider(token, redis));
  }
  return _instances.get(token)!;
}

/**
 * Create provider only if MKVN_PROXY_TOKEN env var is set.
 * Returns null when not configured (no-op, falls through to static pool).
 */
export function createMkvnProviderFromEnv(redis: IORedis): MkvnRotatingProxyProvider | null {
  const token = process.env['MKVN_PROXY_TOKEN'];
  if (!token) return null;
  return getMkvnProvider(token, redis);
}
