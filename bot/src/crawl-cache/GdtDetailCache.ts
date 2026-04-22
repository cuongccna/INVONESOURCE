/**
 * BOT-CACHE-01 — GdtDetailCache
 *
 * Redis cache for GDT invoice detail API responses.
 * Prevents redundant detail fetches when the same invoice is re-synced
 * within the same day (e.g. re-sync of the same date range).
 *
 * Cache key: gdt:detail:{nbmst}:{khhdon}:{shdon}
 * TTL: 24 hours — covers intra-day re-syncs without serving stale data.
 *
 * The cache stores the raw GdtInvoiceDetail JSON.
 * On HIT: returns parsed object immediately — no GDT API call.
 * On MISS: caller fetches from GDT, then calls set() to populate cache.
 *
 * Invalidation: explicit del() when an invoice is cancelled or replaced.
 * This class is a pure cache layer — it never calls GDT itself.
 *
 * All methods are non-fatal: errors are logged and silently swallowed.
 */
import type { Redis } from 'ioredis';
import { logger } from '../logger';

const DETAIL_CACHE_TTL_SECONDS = 24 * 3600; // 24 hours
const KEY_PREFIX = 'gdt:detail:';

export class GdtDetailCache {
  constructor(private readonly redis: Redis) {}

  private _key(nbmst: string, khhdon: string, shdon: string | number): string {
    return `${KEY_PREFIX}${nbmst}:${khhdon}:${String(shdon)}`;
  }

  /** Returns cached detail JSON object, or null on MISS / error. */
  async get(
    nbmst:  string,
    khhdon: string,
    shdon:  string | number,
  ): Promise<Record<string, unknown> | null> {
    try {
      const raw = await this.redis.get(this._key(nbmst, khhdon, shdon));
      if (!raw) return null;
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      logger.warn('[GdtDetailCache] get() error (non-fatal)', {
        nbmst, khhdon, shdon,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Store detail JSON in cache. Non-fatal on error. */
  async set(
    nbmst:   string,
    khhdon:  string,
    shdon:   string | number,
    detail:  Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.redis.set(
        this._key(nbmst, khhdon, shdon),
        JSON.stringify(detail),
        'EX',
        DETAIL_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      logger.warn('[GdtDetailCache] set() error (non-fatal)', {
        nbmst, khhdon, shdon,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Invalidate cache for a specific invoice (e.g. when cancelled/replaced). */
  async del(nbmst: string, khhdon: string, shdon: string | number): Promise<void> {
    try {
      await this.redis.del(this._key(nbmst, khhdon, shdon));
    } catch { /* non-fatal */ }
  }
}
