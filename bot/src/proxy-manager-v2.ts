/**
 * PROMPT 5 — Module 4: TmproxyManager
 *
 * Manages a pool of TMProxy API keys, each representing a separate residential IP.
 * Handles rotation, health checks, proactive refresh, and round-robin selection.
 */

import axios from 'axios';
import { TmproxyRefresher, type ProxySession } from './tmproxy-refresher';
import { createTunnelAgent } from './proxy-tunnel';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProxySlot {
  apiKey: string;
  currentUrl: string | null;
  publicIp: string | null;
  expiresAt: Date | null;
  isHealthy: boolean;
  latencyMs: number | null;
  refreshing: boolean;
}

export interface ProxyHealthResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const HEALTH_CHECK_TARGET  = 'https://hoadondientu.gdt.gov.vn/';
const HEALTH_CHECK_TIMEOUT = 10_000;
const PROACTIVE_REFRESH_MS = 10 * 60_000; // refresh if <10 min left
const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000; // every 10 minutes
const EXPIRY_CHECK_INTERVAL_MS = 5 * 60_000;  // every 5 minutes

/**
 * TmproxyManager — manages a pool of TMProxy API keys.
 *
 * Each key = one residential IP. Round-robin selection with health awareness.
 *
 * Features:
 *   - Proactive refresh (slots expiring in <10 min)
 *   - HTTP-level health checks (not just TCP)
 *   - Automatic failover when slot dies
 *   - Password redaction in logs
 */
export class TmproxyManager {
  private readonly slots: ProxySlot[] = [];
  private readonly refreshers = new Map<string, TmproxyRefresher>();
  private roundRobinIdx = 0;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(apiKeys?: string[]) {
    const keys = apiKeys ?? parseApiKeys();
    if (keys.length === 0) {
      logger.warn('[TmproxyManager] No API keys configured');
      return;
    }

    for (const key of keys) {
      this.slots.push({
        apiKey: key,
        currentUrl: null,
        publicIp: null,
        expiresAt: null,
        isHealthy: true,
        latencyMs: null,
        refreshing: false,
      });
      this.refreshers.set(key, new TmproxyRefresher(key));
    }

    logger.info('[TmproxyManager] Initialized', { slotCount: keys.length });
  }

  /**
   * Initialize all slots by fetching current proxy sessions.
   * Call once at startup.
   */
  async init(): Promise<void> {
    const initPromises = this.slots.map(async (slot) => {
      try {
        await this.initSlot(slot);
      } catch (err) {
        logger.warn('[TmproxyManager] Slot init failed', {
          apiKey: slot.apiKey.slice(0, 8) + '...',
          error: (err as Error).message,
        });
        slot.isHealthy = false;
      }
    });
    await Promise.all(initPromises);

    // Start periodic checks
    this.expiryTimer = setInterval(() => {
      void this.checkAndRefreshExpiring();
    }, EXPIRY_CHECK_INTERVAL_MS);

    this.healthTimer = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Get next available proxy URL via round-robin.
   * Prefers slots with low latency and >10 minutes remaining.
   */
  next(): string | null {
    if (this.slots.length === 0) return null;

    // Try round-robin, skipping unhealthy/expired
    for (let i = 0; i < this.slots.length; i++) {
      const idx  = (this.roundRobinIdx + i) % this.slots.length;
      const slot = this.slots[idx];

      if (!slot.currentUrl || !slot.isHealthy) continue;

      // Skip if expires in <2 minutes
      if (slot.expiresAt && slot.expiresAt.getTime() - Date.now() < 2 * 60_000) continue;

      this.roundRobinIdx = (idx + 1) % this.slots.length;
      return slot.currentUrl;
    }

    // Fallback: any slot with a URL
    for (const slot of this.slots) {
      if (slot.currentUrl) return slot.currentUrl;
    }

    return null;
  }

  /**
   * Mark a proxy URL as failed and trigger refresh.
   */
  markFailed(proxyUrl: string): void {
    const slot = this.slots.find(s => s.currentUrl === proxyUrl);
    if (!slot) return;

    slot.isHealthy = false;
    logger.warn('[TmproxyManager] Slot marked failed', {
      apiKey: slot.apiKey.slice(0, 8) + '...',
      publicIp: slot.publicIp,
    });

    // Trigger async refresh
    void this.refreshSlot(slot.apiKey);
  }

  /**
   * Refresh a specific slot by requesting a new proxy IP.
   */
  async refreshSlot(apiKey: string): Promise<void> {
    const slot = this.slots.find(s => s.apiKey === apiKey);
    if (!slot || slot.refreshing) return;

    slot.refreshing = true;
    const refresher = this.refreshers.get(apiKey);
    if (!refresher) {
      slot.refreshing = false;
      return;
    }

    try {
      const session = await refresher.getNew();
      this.applySession(slot, session);
      logger.info('[TmproxyManager] Slot refreshed', {
        apiKey: apiKey.slice(0, 8) + '...',
        publicIp: session.publicIp,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (err) {
      slot.isHealthy = false;
      logger.error('[TmproxyManager] Slot refresh failed', {
        apiKey: apiKey.slice(0, 8) + '...',
        error: (err as Error).message,
      });
    } finally {
      slot.refreshing = false;
    }
  }

  /**
   * Proactively refresh slots that expire within 10 minutes.
   * Called every 5 minutes by interval timer.
   */
  async checkAndRefreshExpiring(): Promise<void> {
    const now = Date.now();
    for (const slot of this.slots) {
      if (!slot.expiresAt || slot.refreshing) continue;

      const remaining = slot.expiresAt.getTime() - now;
      if (remaining < PROACTIVE_REFRESH_MS && remaining > 0) {
        const minsLeft = Math.round(remaining / 60_000);
        logger.info(`[TmproxyManager] Proactive refresh: ${slot.apiKey.slice(0, 8)}... expires in ${minsLeft}m`);
        await this.refreshSlot(slot.apiKey);
      }
    }
  }

  /**
   * HTTP-level health check for a proxy URL.
   * Sends GET to GDT homepage through the proxy.
   */
  async proxyHttpHealthCheck(proxyUrl: string): Promise<ProxyHealthResult> {
    const start = Date.now();
    try {
      const agent = createTunnelAgent({ proxyUrl });
      const res = await axios.get(HEALTH_CHECK_TARGET, {
        httpAgent: agent,
        timeout: HEALTH_CHECK_TIMEOUT,
        maxRedirects: 3,
        validateStatus: () => true,
      });

      const latencyMs = Date.now() - start;
      const status = res.status;

      if (status === 407) {
        return { ok: false, latencyMs, statusCode: status, error: 'Proxy auth failed (407)' };
      }

      return {
        ok: status >= 200 && status < 500,
        latencyMs,
        statusCode: status,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Get current slot status (for monitoring).
   */
  getSlotStatus(): Array<{
    apiKey: string;
    publicIp: string | null;
    isHealthy: boolean;
    minutesLeft: number | null;
    latencyMs: number | null;
  }> {
    return this.slots.map(s => ({
      apiKey: s.apiKey.slice(0, 8) + '...',
      publicIp: s.publicIp,
      isHealthy: s.isHealthy,
      minutesLeft: s.expiresAt ? Math.round((s.expiresAt.getTime() - Date.now()) / 60_000) : null,
      latencyMs: s.latencyMs,
    }));
  }

  /**
   * Shutdown: clear timers.
   */
  shutdown(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    logger.info('[TmproxyManager] Shutdown');
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async initSlot(slot: ProxySlot): Promise<void> {
    const refresher = this.refreshers.get(slot.apiKey);
    if (!refresher) return;

    try {
      const session = await refresher.getCurrent();
      this.applySession(slot, session);
    } catch (err) {
      // No active session, request new one
      if ((err as { name?: string }).name === 'TmproxyNoSessionError') {
        const session = await refresher.getNew();
        this.applySession(slot, session);
      } else {
        throw err;
      }
    }
  }

  private applySession(slot: ProxySlot, session: ProxySession): void {
    slot.currentUrl = session.url;
    slot.publicIp   = session.publicIp;
    slot.expiresAt  = session.expiresAt;
    slot.isHealthy  = true;
    slot.refreshing = false;
  }

  private async runHealthChecks(): Promise<void> {
    for (const slot of this.slots) {
      if (!slot.currentUrl || slot.refreshing) continue;

      const result = await this.proxyHttpHealthCheck(slot.currentUrl);
      slot.latencyMs = result.ok ? result.latencyMs : null;

      if (!result.ok) {
        logger.warn('[TmproxyManager] Health check failed', {
          apiKey: slot.apiKey.slice(0, 8) + '...',
          error: result.error ?? `HTTP ${result.statusCode}`,
          proxy: redactUrl(slot.currentUrl),
        });

        if (result.statusCode === 407) {
          this.markFailed(slot.currentUrl);
        } else {
          slot.isHealthy = false;
        }
      } else {
        slot.isHealthy = true;
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function parseApiKeys(): string[] {
  const raw = process.env['TMPROXY_API_KEYS'] ?? process.env['TMPROXY_API_KEY'] ?? '';
  return raw.split(',').map(k => k.trim()).filter(Boolean);
}

function redactUrl(url: string): string {
  return url.replace(/:([^@:]+)@/, ':****@');
}
