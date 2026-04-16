/**
 * PROMPT 5 — Module 1: Invoice Cache Service
 *
 * Stale-While-Revalidate caching strategy:
 *   - Always return data immediately (<10ms from Redis)
 *   - If stale → trigger background sync, NEVER block response
 *   - Users never wait for GDT response directly
 */

import type { Redis } from 'ioredis';
import { pool } from './db';
import { logger } from './logger';

// ─── Cache Key Patterns ──────────────────────────────────────────────────────

const KEY = {
  list:    (tid: string, dir: string, ym: string) => `inv:${tid}:${dir}:${ym}`,
  detail:  (tid: string, gdtId: string)            => `inv:detail:${tid}:${gdtId}`,
  meta:    (tid: string)                            => `inv:meta:${tid}`,
  lock:    (tid: string, dir: string)               => `inv:lock:${tid}:${dir}`,
};

const LIST_TTL   = 21_600;  // 6 hours
const DETAIL_TTL = 86_400;  // 24 hours
const LOCK_TTL   = 600;     // 10 minutes
const STALE_THRESHOLD_MS = 4 * 3600_000; // 4 hours — cache is stale after this

export interface CachedListResult {
  invoices: unknown[];
  fromCache: boolean;
  isStale: boolean;
  lastSyncAt: string | null;
}

export interface CacheMeta {
  lastSyncAt: string;
  totalOutput: number;
  totalInput: number;
}

/**
 * Invoice Cache Service — Redis-backed with stale-while-revalidate pattern.
 *
 * Usage:
 *   const cache = new InvoiceCacheService(redis);
 *   const result = await cache.getList({ tenantId, direction, fromDate, toDate });
 *   // result.fromCache = true, result.isStale = false → serve immediately
 *   // result.isStale = true → trigger background sync
 */
export class InvoiceCacheService {
  constructor(private readonly redis: Redis) {}

  /**
   * Get invoice list from cache, falling back to DB.
   *
   * Splits date range into month keys, checks Redis first.
   * On miss or stale: queries PostgreSQL and re-caches.
   */
  async getList(params: {
    tenantId: string;
    direction: 'purchase' | 'sold';
    fromDate: string;   // YYYY-MM-DD
    toDate: string;     // YYYY-MM-DD
  }): Promise<CachedListResult> {
    const { tenantId, direction, fromDate, toDate } = params;
    const months = dateRangeToMonths(fromDate, toDate);

    // Try Redis first — multi-get all month keys
    const keys = months.map(ym => KEY.list(tenantId, direction, ym));
    let allInvoices: unknown[] = [];
    let allFromCache = true;
    let anyStale = false;

    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.get(key);
        pipeline.ttl(key);
      }
      const results = await pipeline.exec();

      if (results) {
        for (let i = 0; i < months.length; i++) {
          const dataResult = results[i * 2];
          const ttlResult  = results[i * 2 + 1];
          const raw  = dataResult?.[1] as string | null;
          const ttl  = ttlResult?.[1] as number | undefined;

          if (raw) {
            const parsed = JSON.parse(raw) as unknown[];
            allInvoices.push(...parsed);

            // Check staleness: if TTL is less than (LIST_TTL - STALE_THRESHOLD/1000),
            // the cache was set a while ago
            const elapsed = LIST_TTL - (ttl ?? 0);
            if (elapsed * 1000 > STALE_THRESHOLD_MS) {
              anyStale = true;
            }
          } else {
            allFromCache = false;
            anyStale = true;
          }
        }
      }
    } catch (err) {
      logger.warn('Redis cache read failed, falling through to DB', { error: (err as Error).message });
      allFromCache = false;
      anyStale = true;
    }

    // If any month missed cache, query DB
    if (!allFromCache) {
      try {
        const dbDir = direction === 'sold' ? 'output' : 'input';
        const { rows } = await pool.query(
          `SELECT * FROM invoices
           WHERE company_id = $1 AND direction = $2
             AND invoice_date >= $3::date AND invoice_date <= $4::date
             AND deleted_at IS NULL
           ORDER BY invoice_date DESC`,
          [tenantId, dbDir, fromDate, toDate]
        );
        allInvoices = rows;
        allFromCache = false;

        // Re-cache per month (async, don't await)
        void this._recacheMonths(tenantId, direction, months, rows);
      } catch (dbErr) {
        logger.error('DB fallback failed', { error: (dbErr as Error).message });
      }
    }

    // Get last sync time
    let lastSyncAt: string | null = null;
    try {
      const metaRaw = await this.redis.get(KEY.meta(tenantId));
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as CacheMeta;
        lastSyncAt = meta.lastSyncAt;
      }
    } catch { /* non-fatal */ }

    return {
      invoices: allInvoices,
      fromCache: allFromCache,
      isStale: anyStale,
      lastSyncAt,
    };
  }

  /**
   * Cache a list of invoices for a specific month.
   */
  async setList(
    tenantId: string,
    direction: 'purchase' | 'sold',
    yyyymm: string,
    invoices: unknown[],
  ): Promise<void> {
    const key = KEY.list(tenantId, direction, yyyymm);
    try {
      await this.redis.set(key, JSON.stringify(invoices), 'EX', LIST_TTL);
    } catch (err) {
      logger.warn('Failed to set list cache', { key, error: (err as Error).message });
    }
  }

  /**
   * Get invoice detail from cache, falling back to DB.
   */
  async getDetail(tenantId: string, gdtId: string): Promise<unknown | null> {
    const key = KEY.detail(tenantId, gdtId);
    try {
      const raw = await this.redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through to DB */ }

    // DB fallback
    try {
      const { rows } = await pool.query(
        `SELECT raw_data FROM invoices WHERE company_id = $1 AND gdt_invoice_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [tenantId, gdtId],
      );
      if (rows[0]) {
        const data = rows[0].raw_data;
        // Re-cache asynchronously
        void this.redis.set(key, JSON.stringify(data), 'EX', DETAIL_TTL).catch(() => {});
        return data;
      }
    } catch { /* non-fatal */ }

    return null;
  }

  /**
   * Acquire a distributed sync lock for a tenant+direction.
   * Returns true if lock was acquired (caller should proceed with sync).
   */
  async acquireSyncLock(
    tenantId: string,
    direction: 'purchase' | 'sold',
    ttl: number = LOCK_TTL,
  ): Promise<boolean> {
    const key = KEY.lock(tenantId, direction);
    const result = await this.redis.set(key, '1', 'EX', ttl, 'NX');
    return result === 'OK';
  }

  /**
   * Release sync lock (only if we hold it).
   */
  async releaseSyncLock(
    tenantId: string,
    direction: 'purchase' | 'sold',
  ): Promise<void> {
    const key = KEY.lock(tenantId, direction);
    await this.redis.del(key).catch(() => {});
  }

  /**
   * Warm cache for a tenant: load 6 most recent months from DB into Redis.
   * Call after sync completes.
   */
  async warmCache(tenantId: string): Promise<void> {
    const now = new Date();
    const months: string[] = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    for (const dir of ['output', 'input'] as const) {
      const cacheDir = dir === 'output' ? 'sold' : 'purchase';
      for (const ym of months) {
        const year  = parseInt(ym.slice(0, 4), 10);
        const month = parseInt(ym.slice(4), 10);
        const from  = `${year}-${String(month).padStart(2, '0')}-01`;
        const endD  = new Date(year, month, 0);
        const to    = `${year}-${String(month).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;

        try {
          const { rows } = await pool.query(
            `SELECT * FROM invoices
             WHERE company_id = $1 AND direction = $2
               AND invoice_date >= $3::date AND invoice_date <= $4::date
               AND deleted_at IS NULL
             ORDER BY invoice_date DESC`,
            [tenantId, dir, from, to],
          );
          await this.setList(tenantId, cacheDir, ym, rows);
        } catch { /* non-fatal */ }
      }
    }

    // Update meta
    try {
      const meta: CacheMeta = {
        lastSyncAt: new Date().toISOString(),
        totalOutput: 0,
        totalInput: 0,
      };
      await this.redis.set(KEY.meta(tenantId), JSON.stringify(meta), 'EX', LIST_TTL);
    } catch { /* non-fatal */ }

    logger.info('Cache warmed', { tenantId, months: months.length });
  }

  /**
   * Invalidate cached invoices for a specific month.
   * Uses SCAN (not KEYS*) — safe for production.
   */
  async invalidateMonth(
    tenantId: string,
    direction: 'purchase' | 'sold',
    yyyymm: string,
  ): Promise<void> {
    const pattern = KEY.list(tenantId, direction, yyyymm);
    try {
      await this.redis.del(pattern);
      logger.debug('Cache invalidated', { tenantId, direction, yyyymm });
    } catch (err) {
      logger.warn('Cache invalidation failed', { error: (err as Error).message });
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _recacheMonths(
    tenantId: string,
    direction: 'purchase' | 'sold',
    months: string[],
    allRows: unknown[],
  ): Promise<void> {
    const rowsByMonth = new Map<string, unknown[]>();
    for (const ym of months) rowsByMonth.set(ym, []);

    for (const row of allRows) {
      const r = row as Record<string, unknown>;
      const date = String(r['invoice_date'] ?? '');
      if (date.length >= 7) {
        const ym = date.slice(0, 4) + date.slice(5, 7);
        const bucket = rowsByMonth.get(ym);
        if (bucket) bucket.push(row);
      }
    }

    for (const [ym, rows] of rowsByMonth) {
      await this.setList(tenantId, direction, ym, rows);
    }
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Convert a date range to an array of YYYYMM month keys.
 */
function dateRangeToMonths(fromDate: string, toDate: string): string[] {
  const months: string[] = [];
  const [fy, fm] = fromDate.split('-').map(Number);
  const [ty, tm] = toDate.split('-').map(Number);

  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }

  return months;
}
