/**
 * TMProxy Auto-Refresh Service
 *
 * Wraps the tmproxy.com REST API to fetch and rotate residential proxy sessions.
 *
 * API docs: https://docs.tmproxy.com/guide/dev/tmproxy-apis/
 *
 * Endpoints used:
 *   POST https://tmproxy.com/api/proxy/get-current-proxy  → active session (no rotation)
 *   POST https://tmproxy.com/api/proxy/get-new-proxy      → rotate to a fresh IP
 *
 * Response field `next_request` (seconds) tells us the minimum cooldown between
 * get-new-proxy calls. For the "Đổi IP" plan this is 4 minutes (240 s).
 */

import axios from 'axios';
import { logger } from './logger';

const TMPROXY_API = 'https://tmproxy.com/api/proxy';

/**
 * Thrown when TMProxy returns code=27: no active proxy session exists for the key.
 * The key is valid (subscription active) but getCurrent() has nothing to return
 * because getNew() has never been called on this key.
 * ProxyManager._initSlot() catches this and automatically calls getNew().
 */
export class TmproxyNoSessionError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`TMProxy API error (code=${code}): ${message}`);
    this.name  = 'TmproxyNoSessionError';
    this.code  = code;
  }
}
const DEFAULT_COOLDOWN_MS = 4 * 60 * 1000; // 4 min fallback

// ── API response shapes ────────────────────────────────────────────────────────

interface TmproxyData {
  ip_allow:       string;
  username:       string;
  password:       string;
  public_ip:      string;
  isp_name?:      string;
  location_name?: string;
  /** "IP:PORT" format — used for both socks5 and https */
  socks5:         string;
  https:          string;
  /** Seconds until this session expires */
  timeout:        number;
  /** Minimum seconds before next get-new-proxy is allowed */
  next_request:   number;
  /** ISO datetime when the session expires */
  expired_at:     string;
}

interface TmproxyResponse {
  code:    number;   // 0 = ok
  message: string;
  data:    TmproxyData;
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface ProxySession {
  /** Full http:// URL: "http://user:pass@IP:PORT" — for HTTP CONNECT tunnel (JSON API calls) */
  url:          string;
  /**
   * Full socks5:// URL: "socks5://user:pass@IP:PORT" — for binary downloads (ZIP/XLSX).
   * SOCKS5 is a transparent TCP relay: no content inspection, no port filtering.
   * null if the TMProxy plan does not include a SOCKS5 endpoint.
   */
  socks5Url:    string | null;
  publicIp:     string;
  expiresAt:    Date;
  /** Minimum ms before we can call getNew() again */
  minRefreshMs: number;
}

// ── Service ────────────────────────────────────────────────────────────────────

export class TmproxyRefresher {
  private readonly apiKey: string;
  private lastRefreshAt: Date | null = null;
  private minRefreshMs               = DEFAULT_COOLDOWN_MS;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Return the currently-active proxy session without rotating the IP.
   * Safe to call at startup — does NOT consume the "change IP" quota.
   */
  async getCurrent(): Promise<ProxySession> {
    const res = await axios.post<TmproxyResponse>(
      `${TMPROXY_API}/get-current-proxy`,
      { api_key: this.apiKey },
      { headers: postHeaders(), timeout: 12_000 },
    );
    return this._parse(res.data);
  }

  /**
   * Request a new proxy IP (rotates the session).
   *
   * Respects the `next_request` cooldown returned by the API; if called too soon
   * it waits automatically instead of failing with a rate-limit error.
   *
   * @param idLocation  0 = any location  (see https://docs.tmproxy.com/tmproxy-apis/location/)
   * @param idIsp       0 = any ISP       (see https://docs.tmproxy.com/tmproxy-apis/isp/)
   */
  async getNew(idLocation = 0, idIsp = 0): Promise<ProxySession> {
    // Enforce cooldown between rotations
    if (this.lastRefreshAt) {
      const elapsed = Date.now() - this.lastRefreshAt.getTime();
      const waitMs  = this.minRefreshMs - elapsed;
      if (waitMs > 0) {
        logger.info('[TmproxyRefresher] Cooldown — waiting before rotate', {
          waitSec: Math.ceil(waitMs / 1000),
        });
        await sleep(waitMs);
      }
    }

    const res = await axios.post<TmproxyResponse>(
      `${TMPROXY_API}/get-new-proxy`,
      { api_key: this.apiKey, id_location: idLocation, id_isp: idIsp },
      { headers: postHeaders(), timeout: 12_000 },
    );

    this.lastRefreshAt = new Date();
    const session      = this._parse(res.data);
    // Store API-reported cooldown for next call
    this.minRefreshMs  = session.minRefreshMs;
    logger.info('[TmproxyRefresher] New IP obtained', {
      publicIp:  session.publicIp,
      url:       redactUrl(session.url),
      expiresAt: session.expiresAt.toISOString(),
    });
    return session;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _parse(body: TmproxyResponse): ProxySession {
    if (body.code !== 0) {
      // code=27 = no active session (key valid, but getNew() was never called)
      if (body.code === 27) throw new TmproxyNoSessionError(body.code, body.message);
      throw new Error(`TMProxy API error (code=${body.code}): ${body.message}`);
    }
    const d = body.data;
    // Build http:// URL from the "https" field (which is "IP:PORT") + credentials
    const url       = `http://${d.username}:${d.password}@${d.https}`;
    // SOCKS5 URL — pure TCP relay, no binary filtering
    const socks5Url = d.socks5?.trim()
      ? `socks5://${d.username}:${d.password}@${d.socks5}`
      : null;
    return {
      url,
      socks5Url,
      publicIp:     d.public_ip,
      expiresAt:    parseExpiredAt(d.expired_at),
      minRefreshMs: (d.next_request ?? 240) * 1000,
    };
  }
}

// ── Module helpers ─────────────────────────────────────────────────────────────

function postHeaders() {
  return {
    'accept':       'application/json',
    'Content-Type': 'application/json',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Mask password in URL for safe logging */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(invalid url)';
  }
}

/**
 * Parse tmproxy expired_at string to Date.
 * TMProxy returns "HH:MM:SS DD/MM/YYYY" (Vietnam local time, UTC+7).
 * Falls back to standard Date parsing if format is unrecognised.
 */
function parseExpiredAt(raw: string): Date {
  // "12:47:32 28/03/2026"
  const m = /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw?.trim() ?? '');
  if (m) {
    const [, HH, MM, SS, dd, mm, yyyy] = m;
    // Treat as Vietnam local time (UTC+7) → subtract 7 hours for UTC
    const utcMs = Date.UTC(
      parseInt(yyyy!), parseInt(mm!) - 1, parseInt(dd!),
      parseInt(HH!) - 7, parseInt(MM!), parseInt(SS!),
    );
    return new Date(utcMs);
  }
  // Fallback: try new Date() directly (ISO / RFC formats)
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;
  // Last resort: return far future so we don't break if format is unknown
  logger.warn('[TmproxyRefresher] Could not parse expired_at', { raw });
  return new Date(Date.now() + 60 * 60 * 1000);
}
