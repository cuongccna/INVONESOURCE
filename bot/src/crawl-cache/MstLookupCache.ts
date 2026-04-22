/**
 * BOT-CACHE-03B — MstLookupCache
 *
 * Redis cache for GDT MST (mã số thuế) validity lookup results.
 * Prevents N+1 GDT MST lookup calls for the same tax code within a sync cycle.
 *
 * Cache key: gdt:mst:{mst}
 * TTL: 24 hours — MST validity status is stable intra-day.
 *
 * All methods are non-fatal: errors silently return null/empty.
 */
import type { Redis } from 'ioredis';

const MST_CACHE_PREFIX = 'gdt:mst:';
const MST_CACHE_TTL    = 24 * 3600;

export interface MstCacheEntry {
  valid:     boolean;
  name:      string | null;
  checkedAt: string;
}

export class MstLookupCache {
  constructor(private readonly redis: Redis) {}

  async get(mst: string): Promise<MstCacheEntry | null> {
    try {
      const raw = await this.redis.get(`${MST_CACHE_PREFIX}${mst}`);
      return raw ? JSON.parse(raw) as MstCacheEntry : null;
    } catch { return null; }
  }

  async set(mst: string, entry: MstCacheEntry): Promise<void> {
    try {
      await this.redis.set(
        `${MST_CACHE_PREFIX}${mst}`,
        JSON.stringify(entry),
        'EX', MST_CACHE_TTL,
      );
    } catch { /* non-fatal */ }
  }

  /**
   * Bulk pre-warm: look up multiple MSTs at once via Redis MGET.
   * Returns a Map of mst → entry for all cache hits.
   */
  async mget(msts: string[]): Promise<Map<string, MstCacheEntry>> {
    const result = new Map<string, MstCacheEntry>();
    if (!msts.length) return result;
    try {
      const keys   = msts.map(m => `${MST_CACHE_PREFIX}${m}`);
      const values = await this.redis.mget(...keys);
      for (let i = 0; i < msts.length; i++) {
        const raw = values[i];
        if (raw) result.set(msts[i]!, JSON.parse(raw) as MstCacheEntry);
      }
    } catch { /* non-fatal */ }
    return result;
  }
}
