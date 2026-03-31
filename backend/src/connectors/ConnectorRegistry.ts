import { ConnectorPlugin, CircuitBreakerState } from './types';

const CIRCUIT_OPEN_THRESHOLD = 3;        // 3 consecutive failures → OPEN
const CIRCUIT_COOLDOWN_MS    = 60_000;   // 60 seconds before HALF_OPEN (transient errors)
const CIRCUIT_AUTH_COOLDOWN  = 24 * 60 * 60_000; // 24 hours for auth failures

/**
 * ConnectorRegistry — manages all provider plugins with per-plugin circuit breakers.
 * One plugin crashing must NEVER affect others.
 */
export class ConnectorRegistry {
  private plugins = new Map<string, ConnectorPlugin>();
  private circuitBreakers = new Map<string, CircuitBreakerState>();

  /**
   * Register a new provider plugin
   */
  register(plugin: ConnectorPlugin): void {
    this.plugins.set(plugin.id, plugin);
    this.circuitBreakers.set(plugin.id, {
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedAt: null,
      halfOpenAt: null,
    });
  }

  /**
   * Remove a provider plugin (graceful — zero changes to core engine)
   */
  unregister(id: string): void {
    this.plugins.delete(id);
    this.circuitBreakers.delete(id);
  }

  /**
   * Get a plugin by id — never throws, returns undefined if not found
   */
  get(id: string): ConnectorPlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get all enabled plugins
   */
  getAll(): ConnectorPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.isEnabled());
  }

  /**
   * Get circuit breaker state for a plugin
   */
  getCircuitState(id: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(id);
  }

  /**
   * Check if the circuit is CLOSED (can make calls) for a plugin.
   * Handles OPEN → HALF_OPEN transition after cooldown.
   */
  canCall(id: string): boolean {
    const cb = this.circuitBreakers.get(id);
    if (!cb) return false;

    if (cb.state === 'CLOSED') return true;

    if (cb.state === 'OPEN') {
      const now = Date.now();
      if (cb.openedAt && now - cb.openedAt.getTime() >= CIRCUIT_COOLDOWN_MS) {
        // Transition to HALF_OPEN — allow 1 probe request
        cb.state = 'HALF_OPEN';
        cb.halfOpenAt = new Date();
        return true;
      }
      return false;
    }

    // HALF_OPEN — allow the probe request
    if (cb.state === 'HALF_OPEN') return true;

    return false;
  }

  /**
   * Record a successful call — resets circuit to CLOSED
   */
  recordSuccess(id: string): void {
    const cb = this.circuitBreakers.get(id);
    if (!cb) return;
    cb.state = 'CLOSED';
    cb.consecutiveFailures = 0;
    cb.openedAt = null;
    cb.halfOpenAt = null;
  }

  /**
   * Record a failed call — increments failure count, may open circuit
   * Returns true if circuit just transitioned to OPEN
   */
  recordFailure(id: string): boolean {
    const cb = this.circuitBreakers.get(id);
    if (!cb) return false;

    cb.consecutiveFailures += 1;

    if (cb.state === 'HALF_OPEN') {
      // Probe failed — back to OPEN
      cb.state = 'OPEN';
      cb.openedAt = new Date();
      return true;
    }

    if (
      cb.state === 'CLOSED' &&
      cb.consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD
    ) {
      cb.state = 'OPEN';
      cb.openedAt = new Date();
      return true;
    }

    return false;
  }

  /**
   * Record an authentication failure — opens circuit for 24 hours.
   * Auth errors cannot self-recover; the connector needs manual credential update.
   */
  recordAuthFailure(id: string): void {
    const cb = this.circuitBreakers.get(id);
    if (!cb) return;
    cb.state = 'OPEN';
    cb.consecutiveFailures += 1;
    // Set openedAt 24h in the past so canCall() requires a manual resetCircuit() call
    // (or the connector being re-enabled in DB) before retrying.
    const farFuture = new Date(Date.now() - CIRCUIT_AUTH_COOLDOWN);
    cb.openedAt = farFuture;
  }

  /**
   * Force reset a plugin's circuit breaker (for admin manual override)
   */
  resetCircuit(id: string): void {
    const cb = this.circuitBreakers.get(id);
    if (!cb) return;
    cb.state = 'CLOSED';
    cb.consecutiveFailures = 0;
    cb.openedAt = null;
    cb.halfOpenAt = null;
  }
}

// Singleton instance
export const registry = new ConnectorRegistry();
