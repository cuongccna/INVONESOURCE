/**
 * PROMPT 5 — Module 3: GDT Circuit Breaker (standalone)
 *
 * Per-tenant circuit breaker backed by Redis.
 *
 * Failure classification:
 *   Network drops (status:0, stream aborted) → NOT counted (proxy error)
 *   HTTP 429 / 403                          → counted → OPEN after threshold
 *   HTTP 401 invalid credentials            → UnrecoverableError, permanent OPEN
 */

import type { Redis } from 'ioredis';
import { logger } from './logger';

export enum CircuitState {
  CLOSED    = 'CLOSED',
  OPEN      = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitData {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  openUntil: number;
  permanentOpen: boolean;
}

const KEY_PREFIX = 'cb:';
const KEY_TTL    = 24 * 3600; // 24h auto-expire stale keys

const DEFAULTS = {
  failureThreshold: 3,
  cooldownMs:       2 * 60_000, // 2 minutes
  halfOpenTimeout:  30_000,
};

export class GdtCircuitBreaker {
  private readonly key: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly tenantId: string,
    opts: Partial<typeof DEFAULTS> = {},
  ) {
    this.key              = `${KEY_PREFIX}${tenantId}`;
    this.failureThreshold = opts.failureThreshold ?? DEFAULTS.failureThreshold;
    this.cooldownMs       = opts.cooldownMs ?? DEFAULTS.cooldownMs;
  }

  /**
   * Check if a request is allowed through the circuit breaker.
   */
  async canRequest(): Promise<boolean> {
    const data = await this.load();
    if (!data) return true;

    if (data.permanentOpen) {
      logger.debug('[CircuitBreaker] Permanently OPEN', { tenantId: this.tenantId });
      return false;
    }

    if (data.state === CircuitState.CLOSED) return true;

    if (data.state === CircuitState.OPEN) {
      if (Date.now() >= data.openUntil) {
        await this.save({ ...data, state: CircuitState.HALF_OPEN, openUntil: 0 });
        logger.info('[CircuitBreaker] OPEN → HALF_OPEN', { tenantId: this.tenantId });
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow probe request
    return true;
  }

  /**
   * Record a successful GDT request. Resets to CLOSED.
   */
  async recordSuccess(): Promise<void> {
    const data = await this.load();
    if (!data) return;
    if (data.permanentOpen) return;

    if (data.failures > 0 || data.state !== CircuitState.CLOSED) {
      logger.info('[CircuitBreaker] → CLOSED (success)', {
        tenantId: this.tenantId,
        prevState: data.state,
        prevFailures: data.failures,
      });
    }

    await this.save({
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailureAt: data.lastFailureAt,
      openUntil: 0,
      permanentOpen: false,
    });
  }

  /**
   * Record a failed GDT request.
   *
   * @param error - The error that occurred
   *
   * Network errors (proxy) are NOT counted.
   * Invalid credentials → permanent OPEN.
   * HTTP 429/403 → counted toward threshold.
   */
  async recordFailure(error: unknown): Promise<void> {
    // Network drops: proxy fail, NOT GDT
    if (isNetworkLevelError(error)) return;

    // Invalid credentials → permanent block
    if (isInvalidCredentials(error)) {
      await this.save({
        state: CircuitState.OPEN,
        failures: this.failureThreshold,
        lastFailureAt: Date.now(),
        openUntil: Date.now() + 365 * 24 * 3600_000,
        permanentOpen: true,
      });
      logger.error('[CircuitBreaker] Permanently OPEN — invalid credentials', {
        tenantId: this.tenantId,
      });
      return;
    }

    const data    = await this.load() ?? this.empty();
    const newFail = data.failures + 1;

    if (newFail >= this.failureThreshold || data.state === CircuitState.HALF_OPEN) {
      await this.save({
        state: CircuitState.OPEN,
        failures: newFail,
        lastFailureAt: Date.now(),
        openUntil: Date.now() + this.cooldownMs,
        permanentOpen: false,
      });
      logger.warn('[CircuitBreaker] → OPEN', {
        tenantId: this.tenantId,
        failures: newFail,
        cooldownSec: Math.round(this.cooldownMs / 1000),
      });
    } else {
      await this.save({ ...data, failures: newFail, lastFailureAt: Date.now() });
    }
  }

  async getState(): Promise<CircuitState> {
    const data = await this.load();
    return data?.state ?? CircuitState.CLOSED;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async load(): Promise<CircuitData | null> {
    try {
      const raw = await this.redis.get(this.key);
      return raw ? (JSON.parse(raw) as CircuitData) : null;
    } catch { return null; }
  }

  private async save(data: CircuitData): Promise<void> {
    try {
      await this.redis.set(this.key, JSON.stringify(data), 'EX', KEY_TTL);
    } catch { /* non-fatal */ }
  }

  private empty(): CircuitData {
    return {
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailureAt: 0,
      openUntil: 0,
      permanentOpen: false,
    };
  }
}

// ─── Network Error Classification ────────────────────────────────────────────

const NETWORK_ERROR_PATTERNS = [
  'stream has been aborted',
  'econnreset',
  'socket hang up',
  'econnrefused',
  'ECONNABORTED',
  'ERR_STREAM_DESTROYED',
  'ETIMEDOUT',
  'EPIPE',
];

/**
 * Detect if an error is a network-level failure (proxy/infra issue).
 *
 * These are NOT counted against the circuit breaker because they indicate
 * proxy failure, not GDT rejection.
 */
export function isNetworkLevelError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const axiosError = error as {
    isAxiosError?: boolean;
    response?: unknown;
    message?: string;
    code?: string;
  };

  // Must be an axios error with NO response (network layer, not HTTP)
  if (!axiosError.isAxiosError) return false;
  if (axiosError.response !== undefined) return false;

  const msg  = (axiosError.message ?? '').toLowerCase();
  const code = (axiosError.code ?? '').toLowerCase();

  return NETWORK_ERROR_PATTERNS.some(p =>
    msg.includes(p.toLowerCase()) || code.includes(p.toLowerCase())
  );
}

/**
 * Detect if an error is a GDT rate limit (HTTP 429 or 403).
 * These ARE counted against the circuit breaker.
 */
export function isGdtRateLimit(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const axiosError = error as { response?: { status?: number } };
  const status = axiosError.response?.status;
  return status === 429 || status === 403;
}

/**
 * Detect if an error indicates invalid credentials.
 * Triggers permanent circuit open — no retry.
 */
export function isInvalidCredentials(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const axiosError = error as {
    response?: { status?: number; data?: unknown };
    message?: string;
  };

  // HTTP 401
  if (axiosError.response?.status === 401) return true;

  // GDT-specific error message (Vietnamese)
  const msg = String(axiosError.message ?? '');
  const dataStr = typeof axiosError.response?.data === 'string'
    ? axiosError.response.data
    : JSON.stringify(axiosError.response?.data ?? '');

  const combined = msg + dataStr;
  if (combined.includes('Tên đăng nhập hoặc mật khẩu không đúng')) return true;
  if (combined.includes('sai mật khẩu') || combined.includes('wrong password')) return true;

  return false;
}
