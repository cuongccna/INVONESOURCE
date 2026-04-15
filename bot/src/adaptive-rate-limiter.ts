/**
 * Adaptive Rate Limiter — GDT Crawler Bot
 *
 * Exports:
 *   GdtCircuitBreaker   — per-company circuit breaker (Redis-backed)
 *   AdaptiveDelayManager — P95 sliding-window delay controller
 *   Semaphore           — generic concurrent task limiter
 *   proxyHealthCheck    — HTTP-level proxy health check (not just TCP)
 *   recordLoginAt       — track real login timestamp (vs session reuse)
 *   recordSyncAt        — track last sync timestamp
 *   getLoginCooldownMs  — return remaining cooldown for scheduled vs manual jobs
 */

import axios from 'axios';
import type { Redis } from 'ioredis';
import { createTunnelAgent } from './proxy-tunnel';
import { logger } from './logger';

// ── Part 1: Circuit Breaker ─────────────────────────────────────────────────

export enum CircuitState {
  CLOSED    = 'CLOSED',    // Normal — requests allowed
  OPEN      = 'OPEN',      // Blocking — reject all requests during cooldown
  HALF_OPEN = 'HALF_OPEN', // Testing — allow one probe request
}

interface CircuitData {
  state:         CircuitState;
  failures:      number;
  lastFailureAt: number;    // Unix ms
  openUntil:     number;    // Unix ms — 0 when CLOSED/HALF_OPEN
  permanentOpen: boolean;   // true for 401 invalid-credentials (never auto-recover)
}

interface CircuitBreakerOptions {
  failureThreshold: number;       // consecutive failures before OPEN
  cooldownMs:       number;       // how long to stay OPEN before HALF_OPEN
  halfOpenTimeout:  number;       // ms to wait for probe result before re-OPEN
}

const CB_KEY_PREFIX = 'cb:';
const CB_KEY_TTL    = 24 * 3600; // 24h — stale keys auto-expire

const CB_DEFAULTS: CircuitBreakerOptions = {
  failureThreshold: 3,
  cooldownMs:       2 * 60_000,  // 2 minutes (not 2 hours)
  halfOpenTimeout:  30_000,
};

/**
 * Per-company circuit breaker backed by Redis.
 *
 * Failure classification:
 *   Network drops (status:0, stream aborted) → NOT counted (proxy error, not GDT)
 *   HTTP 429 / 503                          → counted → OPEN after threshold
 *   HTTP 401 invalid credentials            → permanentOpen (never auto-recover)
 *
 * Usage:
 *   const cb = new GdtCircuitBreaker(redis, companyId);
 *   if (!await cb.isAllowed()) return; // circuit open
 *   try {
 *     await doGdtRequest();
 *     await cb.recordSuccess();
 *   } catch (err) {
 *     await cb.recordFailure(err);
 *     throw err;
 *   }
 */
export class GdtCircuitBreaker {
  private readonly key:  string;
  private readonly opts: CircuitBreakerOptions;

  constructor(
    private readonly redis:     Redis,
    private readonly companyId: string,
    opts: Partial<CircuitBreakerOptions> = {},
  ) {
    this.key  = `${CB_KEY_PREFIX}${companyId}`;
    this.opts = { ...CB_DEFAULTS, ...opts };
  }

  /** Returns true if a request should be allowed through. */
  async isAllowed(): Promise<boolean> {
    const data = await this._load();
    if (!data) return true;                       // no state = CLOSED

    if (data.permanentOpen) {
      logger.debug('[CircuitBreaker] Permanently OPEN (invalid credentials)', { companyId: this.companyId });
      return false;
    }

    if (data.state === CircuitState.CLOSED) return true;

    if (data.state === CircuitState.OPEN) {
      if (Date.now() >= data.openUntil) {
        // Transition to HALF_OPEN — allow one probe
        await this._save({ ...data, state: CircuitState.HALF_OPEN, openUntil: 0 });
        logger.info('[CircuitBreaker] OPEN → HALF_OPEN (probe allowed)', { companyId: this.companyId });
        return true;
      }
      const secsLeft = Math.ceil((data.openUntil - Date.now()) / 1000);
      logger.debug('[CircuitBreaker] OPEN — rejecting request', { companyId: this.companyId, secsLeft });
      return false;
    }

    // HALF_OPEN — allow the probe
    return true;
  }

  /** Call after a successful GDT request. Resets failure count → CLOSED. */
  async recordSuccess(): Promise<void> {
    const data = await this._load();
    if (!data) return;
    if (data.permanentOpen) return;    // credentials wrong — don't auto-reset
    if (data.failures > 0 || data.state !== CircuitState.CLOSED) {
      logger.info('[CircuitBreaker] CLOSED (success after failures)', {
        companyId:    this.companyId,
        prevState:    data.state,
        prevFailures: data.failures,
      });
    }
    await this._save({
      state:         CircuitState.CLOSED,
      failures:      0,
      lastFailureAt: data.lastFailureAt,
      openUntil:     0,
      permanentOpen: false,
    });
  }

  /**
   * Call after a failed GDT request.
   *
   * @param isInvalidCredentials Pass true for HTTP 401 wrong password — opens permanently.
   * @param isNetworkError       Pass true for TCP drops (proxy error) — NOT counted.
   */
  async recordFailure(
    isInvalidCredentials = false,
    isNetworkError       = false,
  ): Promise<void> {
    // Network drops are proxy infrastructure failures, not GDT API failures
    if (isNetworkError) return;

    if (isInvalidCredentials) {
      await this._save({
        state:         CircuitState.OPEN,
        failures:      this.opts.failureThreshold,
        lastFailureAt: Date.now(),
        openUntil:     Date.now() + 365 * 24 * 3600_000, // effectively forever
        permanentOpen: true,
      });
      logger.error('[CircuitBreaker] Permanently OPEN — invalid credentials', { companyId: this.companyId });
      return;
    }

    const data    = await this._load() ?? this._empty();
    const newFail = data.failures + 1;

    if (newFail >= this.opts.failureThreshold || data.state === CircuitState.HALF_OPEN) {
      const openUntil = Date.now() + this.opts.cooldownMs;
      await this._save({
        state:         CircuitState.OPEN,
        failures:      newFail,
        lastFailureAt: Date.now(),
        openUntil,
        permanentOpen: false,
      });
      logger.warn('[CircuitBreaker] OPEN after failures', {
        companyId: this.companyId,
        failures:  newFail,
        cooldownSec: Math.round(this.opts.cooldownMs / 1000),
      });
    } else {
      await this._save({ ...data, failures: newFail, lastFailureAt: Date.now() });
    }
  }

  async getState(): Promise<CircuitState> {
    const data = await this._load();
    return data?.state ?? CircuitState.CLOSED;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _load(): Promise<CircuitData | null> {
    try {
      const raw = await this.redis.get(this.key);
      return raw ? (JSON.parse(raw) as CircuitData) : null;
    } catch { return null; }
  }

  private async _save(data: CircuitData): Promise<void> {
    try {
      await this.redis.set(this.key, JSON.stringify(data), 'EX', CB_KEY_TTL);
    } catch { /* non-fatal */ }
  }

  private _empty(): CircuitData {
    return { state: CircuitState.CLOSED, failures: 0, lastFailureAt: 0, openUntil: 0, permanentOpen: false };
  }
}

// ── Part 2: Adaptive Delay Manager ─────────────────────────────────────────

const SLIDING_WINDOW_SIZE = 10;  // keep last N samples per endpoint

/**
 * Observes GDT response times and adjusts inter-request delay automatically.
 *
 * When GDT is slow (P95 > 20s) it usually means the server is under load.
 * Backing off reduces the chance of further timeouts or rate-limiting.
 *
 * Usage:
 *   const adm = new AdaptiveDelayManager();
 *   adm.recordResponseTime('/query/invoices/sold', responseMs);
 *   await adm.delay('/query/invoices/sold');
 *   const slow = adm.isEndpointSlow('/query/invoices/sold'); // reduce concurrency?
 */
export class AdaptiveDelayManager {
  /** endpoint → circular buffer of last N response times (ms) */
  private readonly samples = new Map<string, number[]>();

  recordResponseTime(endpoint: string, ms: number): void {
    const buf = this.samples.get(endpoint) ?? [];
    buf.push(ms);
    if (buf.length > SLIDING_WINDOW_SIZE) buf.shift();
    this.samples.set(endpoint, buf);
  }

  /** P95 of the sliding window for an endpoint (or 0 if no data). */
  p95(endpoint: string): number {
    const buf = this.samples.get(endpoint);
    if (!buf || buf.length === 0) return 0;
    const sorted = [...buf].sort((a, b) => a - b);
    const idx    = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)] ?? 0;
  }

  /**
   * Returns the recommended delay in ms before the next request to this endpoint.
   *
   * P95 < 5s  → 500ms  (fast — normal rate)
   * P95 < 15s → 2s     (normal)
   * P95 < 30s → 5s     (slow — reduce rate)
   * P95 ≥ 30s → 10s    (GDT overloaded — back off hard)
   */
  getDelay(endpoint: string): number {
    const p = this.p95(endpoint);
    if (p === 0)    return 500;
    if (p < 5_000)  return 500;
    if (p < 15_000) return 2_000;
    if (p < 30_000) return 5_000;
    return 10_000;
  }

  /** Returns true when the endpoint is slow enough to warrant reducing concurrency. */
  isEndpointSlow(endpoint: string): boolean {
    return this.p95(endpoint) > 20_000;
  }

  /** Await the recommended delay for this endpoint. */
  async delay(endpoint: string): Promise<void> {
    const ms = this.getDelay(endpoint);
    await new Promise<void>(r => setTimeout(r, ms));
  }
}

// Shared singleton — one instance per process
export const adaptiveDelay = new AdaptiveDelayManager();

// ── Part 3: Login Cooldown Fix ──────────────────────────────────────────────

const LAST_LOGIN_KEY_PREFIX = 'last_login_at:';
const LAST_SYNC_KEY_PREFIX  = 'last_sync_at:';
const COOLDOWN_TTL_SEC      = 24 * 3600;

/**
 * Record a real GDT login (captcha + auth).
 * Distinct from session-cache reuse — only real logins update this timestamp.
 */
export async function recordLoginAt(redis: Redis, companyId: string): Promise<void> {
  try {
    await redis.set(`${LAST_LOGIN_KEY_PREFIX}${companyId}`, String(Date.now()), 'EX', COOLDOWN_TTL_SEC);
  } catch { /* non-fatal */ }
}

/** Record any sync activity (including session-reuse runs). */
export async function recordSyncAt(redis: Redis, companyId: string): Promise<void> {
  try {
    await redis.set(`${LAST_SYNC_KEY_PREFIX}${companyId}`, String(Date.now()), 'EX', COOLDOWN_TTL_SEC);
  } catch { /* non-fatal */ }
}

/**
 * Returns remaining cooldown in ms (0 = no cooldown, proceed).
 *
 * Cooldown rules:
 *   Scheduled jobs: check last_sync_at,  cooldown = 5 minutes
 *   Manual jobs:    check last_login_at, cooldown = 2 minutes
 *   Session reuse:  skip cooldown entirely (no GDT login consumed)
 */
export async function getLoginCooldownMs(
  redis:       Redis,
  companyId:   string,
  jobType:     'scheduled' | 'manual',
  isSessionReuse = false,
): Promise<number> {
  if (isSessionReuse) return 0;

  const SCHEDULED_COOLDOWN = 5 * 60_000;
  const MANUAL_COOLDOWN    = 2 * 60_000;

  try {
    const key  = jobType === 'manual'
      ? `${LAST_LOGIN_KEY_PREFIX}${companyId}`
      : `${LAST_SYNC_KEY_PREFIX}${companyId}`;
    const raw  = await redis.get(key);
    if (!raw) return 0;
    const last    = parseInt(raw, 10);
    const elapsed = Date.now() - last;
    const cooldown = jobType === 'manual' ? MANUAL_COOLDOWN : SCHEDULED_COOLDOWN;
    return Math.max(0, cooldown - elapsed);
  } catch {
    return 0;
  }
}

// ── Part 4: Generic Semaphore ───────────────────────────────────────────────

/**
 * Generic counting semaphore for controlling concurrency.
 *
 * Usage:
 *   const sem = new Semaphore(3);
 *   const release = await sem.acquire();
 *   try { await doWork(); }
 *   finally { release(); }
 */
export class Semaphore {
  private _active = 0;
  private _queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  acquire(): Promise<() => void> {
    return new Promise(resolve => {
      const tryAcquire = () => {
        if (this._active < this.maxConcurrency) {
          this._active++;
          resolve(() => {
            this._active--;
            const next = this._queue.shift();
            if (next) next();
          });
        } else {
          this._queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  get activeCount(): number  { return this._active; }
  get queuedCount(): number  { return this._queue.length; }
}

// ── Part 5: HTTP-level Proxy Health Check ───────────────────────────────────

export interface ProxyHealthResult {
  ok:         boolean;
  latencyMs:  number;
  statusCode?: number;
  error?:     string;
}

const PROXY_CHECK_TARGET  = 'https://hoadondientu.gdt.gov.vn/';
const PROXY_CHECK_TIMEOUT = 10_000;  // 10 seconds
const PROXY_SLOW_MS       = 5_000;   // mark proxy "slow" above this latency

/**
 * HTTP-level proxy health check — more reliable than TCP probe alone.
 *
 * Sends a real HTTP GET through the proxy to GDT's homepage.
 * This validates:
 *   1. TCP connectivity to proxy (same as probe)
 *   2. Proxy authentication (catches 407 immediately)
 *   3. Proxy can reach GDT (catches IP bans, routing issues)
 *   4. Measures actual HTTP latency (not just TCP handshake)
 *
 * HTTP 200 or 3xx → ok=true (redirect from GDT is expected/fine)
 * HTTP 407        → proxy auth failed → mark failed immediately
 * Timeout         → ok=false (proxy too slow or dead)
 */
export async function proxyHealthCheck(proxyUrl: string): Promise<ProxyHealthResult> {
  const start = Date.now();
  try {
    const httpAgent = createTunnelAgent({ proxyUrl });
    const res = await axios.get(PROXY_CHECK_TARGET, {
      httpAgent,
      timeout:      PROXY_CHECK_TIMEOUT,
      maxRedirects: 3,
      // Don't decompress — we only care about reachability
      decompress: false,
      validateStatus: (s) => s < 500,  // 2xx, 3xx, 4xx all treated as "reached"
    });
    const latencyMs = Date.now() - start;

    if (res.status === 407) {
      return { ok: false, latencyMs, statusCode: 407, error: 'Proxy authentication failed (407)' };
    }

    const ok = res.status < 400 || res.status === 403;  // 403 is fine — GDT blocks without auth
    if (!ok) {
      return { ok: false, latencyMs, statusCode: res.status, error: `Unexpected status ${res.status}` };
    }
    if (latencyMs > PROXY_SLOW_MS) {
      logger.warn('[ProxyHealthCheck] Proxy is slow', {
        proxyUrl: proxyUrl.replace(/:([^@:]+)@/, ':****@').slice(0, 50),
        latencyMs,
      });
    }
    return { ok: true, latencyMs, statusCode: res.status };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message   = err instanceof Error ? err.message : String(err);
    return { ok: false, latencyMs, error: message.slice(0, 120) };
  }
}
