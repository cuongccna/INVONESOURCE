/**
 * TmproxyHelper — lightweight TMProxy client for the backend process.
 *
 * Returns an axios-compatible proxy config for outbound HTTP requests
 * (used by CompanyVerificationService to route tracuunnt.gdt.gov.vn
 * lookups through a residential proxy instead of the bare server IP).
 *
 * Reads TMPROXY_API_KEYS from env (first key is used).
 * Caches the proxy session in-memory until it expires — no external state.
 * Safe to call on every request; actual TMProxy API calls happen only on
 * startup and when the session expires (~45 min intervals).
 */

import axios from 'axios';
import { env } from '../config/env';

const TMPROXY_API = 'https://tmproxy.com/api/proxy';

interface TmproxyData {
  username:    string;
  password:    string;
  https:       string;   // "IP:PORT"
  timeout:     number;   // seconds until session expires
  expired_at:  string;   // ISO datetime
}

interface TmproxyResponse {
  code:    number;
  message: string;
  data:    TmproxyData;
}

export interface ProxyConfig {
  protocol: 'http';
  host:     string;
  port:     number;
  auth:     { username: string; password: string };
}

class TmproxyHelper {
  private _cached:    ProxyConfig | null = null;
  private _expiresAt: Date | null        = null;
  // Reuse api-key (first key from comma-separated list)
  private readonly apiKey: string | null;

  constructor() {
    const keys = env.TMPROXY_API_KEYS;
    this.apiKey = keys ? (keys.split(',')[0]?.trim() ?? null) : null;
  }

  /**
   * Returns an axios proxy config object, or null when TMPROXY_API_KEYS is not set.
   * Fetches a fresh session automatically when the cached one expires.
   */
  async getProxyConfig(): Promise<ProxyConfig | null> {
    if (!this.apiKey) return null;

    // Use cached session if still valid (with 60s buffer)
    if (this._cached && this._expiresAt && this._expiresAt.getTime() - Date.now() > 60_000) {
      return this._cached;
    }

    return this._fetchCurrent();
  }

  private async _fetchCurrent(): Promise<ProxyConfig | null> {
    try {
      const res = await axios.post<TmproxyResponse>(
        `${TMPROXY_API}/get-current-proxy`,
        { api_key: this.apiKey },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      );

      if (res.data.code !== 0) {
        // code=27 = no session yet — request a new one
        if (res.data.code === 27) return this._fetchNew();
        console.warn(`[TmproxyHelper] API error code=${res.data.code}: ${res.data.message}`);
        return null;
      }

      return this._cacheSession(res.data.data);
    } catch (err) {
      console.warn('[TmproxyHelper] getCurrent failed:', (err as Error).message);
      return null;
    }
  }

  private async _fetchNew(): Promise<ProxyConfig | null> {
    try {
      const res = await axios.post<TmproxyResponse>(
        `${TMPROXY_API}/get-new-proxy`,
        { api_key: this.apiKey },
        { timeout: 12_000, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      );

      if (res.data.code !== 0) {
        console.warn(`[TmproxyHelper] getNew error code=${res.data.code}: ${res.data.message}`);
        return null;
      }

      return this._cacheSession(res.data.data);
    } catch (err) {
      console.warn('[TmproxyHelper] getNew failed:', (err as Error).message);
      return null;
    }
  }

  private _cacheSession(data: TmproxyData): ProxyConfig | null {
    // Parse "IP:PORT"
    const parts = (data.https ?? '').split(':');
    if (parts.length < 2) {
      console.warn('[TmproxyHelper] Unexpected proxy format:', data.https);
      return null;
    }
    const host = parts[0]!;
    const port = parseInt(parts[1]!, 10);
    if (!host || isNaN(port)) return null;

    const config: ProxyConfig = {
      protocol: 'http',
      host,
      port,
      auth: { username: data.username, password: data.password },
    };

    this._cached    = config;
    this._expiresAt = new Date(data.expired_at);

    console.info(`[TmproxyHelper] Session cached — IP: ${host}, expires: ${data.expired_at}`);
    return config;
  }
}

export const tmproxyHelper = new TmproxyHelper();
