/**
 * BOT-CACHE-02 — GdtRawCacheService (bot-side)
 *
 * Data lake pattern for GDT list API page responses.
 * Stores raw GDT page JSON in gdt_raw_cache BEFORE parsing, enabling:
 *   - Replay parsing without re-hitting GDT (regulatory change → re-parse old data)
 *   - Debugging: inspect what GDT returned for any sync session
 *   - Change detection: MD5 hash comparison to skip unchanged pages
 *
 * Uses the existing gdt_raw_cache table with page-level columns added by migration 040.
 * Existing invoice-level rows are unaffected (they have company_id IS NULL).
 *
 * All methods are non-fatal: errors are logged and silently swallowed.
 */
import { pool } from '../db';
import { createHash } from 'crypto';
import { logger } from '../logger';

export class GdtRawCacheService {
  /**
   * Upsert one page of raw GDT API response.
   * Uses ON CONFLICT DO UPDATE — idempotent, safe to call on retry.
   * Returns true if content changed (hash mismatch → re-parse needed),
   * false if content is identical to cached version.
   * Non-fatal: never throws.
   */
  async upsertPage(params: {
    companyId: string;
    endpoint:  string;   // e.g. '/query/invoices/sold'
    page:      number;   // 0-indexed
    period:    string;   // 'YYYY-MM'
    rawJson:   unknown;  // full GDT page response object
  }): Promise<boolean> {
    try {
      const json = JSON.stringify(params.rawJson);
      const hash = createHash('md5').update(json).digest('hex');

      const res = await pool.query<{ changed: boolean }>(
        `INSERT INTO gdt_raw_cache
           (company_id, endpoint, page, period, content_hash, raw_json, fetched_at,
            mst, invoice_type, ma_hoa_don)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(),
                 'page_cache', 'page', $2 || ':' || $3 || ':' || $4)
         ON CONFLICT (company_id, endpoint, page, period)
           WHERE company_id IS NOT NULL AND endpoint IS NOT NULL
             AND page IS NOT NULL AND period IS NOT NULL
         DO UPDATE
           SET content_hash = EXCLUDED.content_hash,
               raw_json     = EXCLUDED.raw_json,
               fetched_at   = EXCLUDED.fetched_at
         RETURNING (gdt_raw_cache.content_hash IS DISTINCT FROM $5) AS changed`,
        [params.companyId, params.endpoint, params.page, params.period, hash, json],
      );
      return res.rows[0]?.changed ?? true;
    } catch (err) {
      logger.warn('[GdtRawCache] upsertPage failed (non-fatal)', {
        companyId: params.companyId,
        endpoint:  params.endpoint,
        page:      params.page,
        err:       err instanceof Error ? err.message : String(err),
      });
      return true; // treat as changed on error (safe: triggers re-parse)
    }
  }

  /**
   * Retrieve a cached page for a given company/endpoint/page/period.
   * Only returns rows fetched within the last 25 hours.
   * Returns null on MISS or error.
   */
  async getPage(params: {
    companyId: string;
    endpoint:  string;
    page:      number;
    period:    string;
  }): Promise<unknown | null> {
    try {
      const res = await pool.query<{ raw_json: unknown }>(
        `SELECT raw_json FROM gdt_raw_cache
         WHERE company_id = $1 AND endpoint = $2 AND page = $3 AND period = $4
           AND fetched_at > NOW() - INTERVAL '25 hours'`,
        [params.companyId, params.endpoint, params.page, params.period],
      );
      return res.rows[0]?.raw_json ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Purge page-level entries older than retentionDays.
   * Call from a scheduled maintenance job (e.g. daily at 3 AM).
   * Only purges rows that have company_id (page-level rows) to avoid
   * touching legacy invoice-level rows.
   */
  async purgeOld(retentionDays = 90): Promise<number> {
    try {
      const res = await pool.query<{ count: string }>(
        `WITH deleted AS (
           DELETE FROM gdt_raw_cache
           WHERE company_id IS NOT NULL
             AND fetched_at < NOW() - ($1 || ' days')::INTERVAL
           RETURNING 1
         ) SELECT COUNT(*)::text AS count FROM deleted`,
        [String(retentionDays)],
      );
      const n = parseInt(res.rows[0]?.count ?? '0', 10);
      if (n > 0) logger.info('[GdtRawCache] Purged old page cache entries', { count: n, retentionDays });
      return n;
    } catch {
      return 0;
    }
  }
}

/** Singleton instance shared across the bot process. */
export const gdtRawCacheService = new GdtRawCacheService();
