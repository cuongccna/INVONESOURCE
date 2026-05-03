/**
 * ConfigStore — Singleton live-config reader/writer.
 *
 * Values are stored in PostgreSQL `system_settings` table and cached in:
 *   1. Redis Hash  `system:config`   (fast distributed cache)
 *   2. In-process  Map<string,string> (zero-overhead synchronous reads)
 *
 * Flow:
 *   init()  → load Redis Hash → fallback to DB → populate in-process Map
 *   set()   → write DB → HSET Redis → PUBLISH system:config:updated
 *   subscribe() → listen PUBLISH → update in-process Map live (no restart needed)
 *
 * Usage (hot path — synchronous, zero async cost):
 *   cfg.number('bot.max_concurrent_per_proxy_ip', 3)
 *   cfg.string('gdt.page_size', '50')
 *   cfg.boolean('feature.some_flag', false)
 */

import type { Pool } from 'pg';
import type Redis from 'ioredis';

const REDIS_HASH_KEY = 'system:config';
const PUBSUB_CHANNEL = 'system:config:updated';

interface SettingRow {
  key: string;
  value: string;
}

class ConfigStore {
  private cache = new Map<string, string>();
  private _pool: Pool | null = null;
  private _redis: Redis | null = null;
  private _initialized = false;

  /**
   * Load all settings into the in-process cache.
   * Call once during application startup BEFORE workers start.
   *
   * @param redis  - Main Redis connection (read/write)
   * @param pool   - PostgreSQL pool (fallback when Redis is empty)
   */
  async init(redis: Redis, pool: Pool): Promise<void> {
    this._redis = redis;
    this._pool = pool;

    // 1. Try Redis Hash first (fast, avoids DB on every restart)
    try {
      const hash = await redis.hgetall(REDIS_HASH_KEY);
      if (hash && Object.keys(hash).length > 0) {
        for (const [key, value] of Object.entries(hash)) {
          this.cache.set(key, value);
        }
        console.log(`[ConfigStore] Loaded ${this.cache.size} settings from Redis`);
        this._initialized = true;
        return;
      }
    } catch (err) {
      console.warn('[ConfigStore] Redis load failed, falling back to DB:', err instanceof Error ? err.message : err);
    }

    // 2. Fallback to DB — populate Redis Hash for next startup
    try {
      const { rows } = await pool.query<SettingRow>('SELECT key, value FROM system_settings');
      const pipeline = redis.pipeline();
      for (const row of rows) {
        this.cache.set(row.key, row.value);
        pipeline.hset(REDIS_HASH_KEY, row.key, row.value);
      }
      await pipeline.exec();
      console.log(`[ConfigStore] Loaded ${rows.length} settings from DB → wrote to Redis Hash`);
    } catch (err) {
      console.warn('[ConfigStore] DB load failed — will use hardcoded fallbacks:', err instanceof Error ? err.message : err);
    }

    this._initialized = true;
  }

  /**
   * Subscribe to live updates via Redis Pub/Sub.
   * Pass a DEDICATED subscriber Redis connection (cannot share with main connection
   * once subscribe() is called, the connection enters subscriber mode).
   *
   * @param subscriberRedis - Dedicated Redis connection for subscribe()
   */
  subscribe(subscriberRedis: Redis): void {
    subscriberRedis.subscribe(PUBSUB_CHANNEL, (err) => {
      if (err) {
        console.error('[ConfigStore] Failed to subscribe to config updates:', err.message);
      } else {
        console.log(`[ConfigStore] Subscribed to ${PUBSUB_CHANNEL} for live updates`);
      }
    });

    subscriberRedis.on('message', (_channel: string, message: string) => {
      // message format: "key=value"
      const eqIdx = message.indexOf('=');
      if (eqIdx === -1) return;
      const key = message.slice(0, eqIdx);
      const value = message.slice(eqIdx + 1);
      this.cache.set(key, value);
      console.log(`[ConfigStore] Live update: ${key} = ${value}`);
    });
  }

  /**
   * Update a setting: writes to DB + Redis Hash + publishes live update.
   * All running processes receive the change within milliseconds.
   */
  async set(key: string, value: string, updatedBy?: string): Promise<void> {
    if (!this._pool || !this._redis) {
      throw new Error('[ConfigStore] Not initialized — call init() first');
    }

    // Validate key exists
    const { rowCount } = await this._pool.query(
      'SELECT 1 FROM system_settings WHERE key = $1',
      [key],
    );
    if (!rowCount) throw new Error(`Unknown config key: ${key}`);

    // Write to DB
    await this._pool.query(
      `UPDATE system_settings
          SET value = $1, updated_at = NOW(), updated_by = $2
        WHERE key = $3`,
      [value, updatedBy ?? null, key],
    );

    // Write to Redis Hash
    await this._redis.hset(REDIS_HASH_KEY, key, value);

    // Publish live update (format: "key=value")
    await this._redis.publish(PUBSUB_CHANNEL, `${key}=${value}`);

    // Update own cache immediately (don't wait for pub/sub round-trip)
    this.cache.set(key, value);
  }

  /**
   * Reset a setting to its DB default_value.
   */
  async reset(key: string, updatedBy?: string): Promise<void> {
    if (!this._pool || !this._redis) {
      throw new Error('[ConfigStore] Not initialized — call init() first');
    }

    const { rows } = await this._pool.query<{ default_value: string }>(
      'SELECT default_value FROM system_settings WHERE key = $1',
      [key],
    );
    if (!rows.length) throw new Error(`Unknown config key: ${key}`);

    await this.set(key, rows[0]!.default_value, updatedBy);
  }

  // ─── Synchronous getters (zero async overhead — reads from in-process Map) ──

  /**
   * Get a numeric config value.
   * @param key       - Setting key, e.g. 'bot.max_concurrent_per_proxy_ip'
   * @param fallback  - Value to use if key not found or not yet initialized
   */
  number(key: string, fallback: number): number {
    const raw = this.cache.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  /**
   * Get a string config value.
   */
  string(key: string, fallback: string): string {
    return this.cache.get(key) ?? fallback;
  }

  /**
   * Get a boolean config value ('true' / '1' → true, everything else → false).
   */
  boolean(key: string, fallback: boolean): boolean {
    const raw = this.cache.get(key);
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /** For admin API — returns all keys and current values */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }
}

/** Singleton — imported by all modules that need config values */
export const cfg = new ConfigStore();
