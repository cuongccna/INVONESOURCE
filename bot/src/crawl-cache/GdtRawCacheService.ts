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

const PAGE_CACHE_KEY_MAX_LEN = 100;

function sha1Hex(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function normalizePageCacheEndpoint(endpoint: string): string {
  const normalized = endpoint.trim();
  const basePath = normalized.split('?')[0] || normalized;
  const digest = sha1Hex(normalized);
  const suffix = `#${digest}`;
  const keepBaseChars = Math.max(0, PAGE_CACHE_KEY_MAX_LEN - suffix.length);
  return `${basePath.slice(0, keepBaseChars)}${suffix}`;
}

function buildPageCacheInvoiceId(companyId: string, endpoint: string, period: string, page: number): string {
  return `page:${sha1Hex(`${companyId}:${endpoint}:${period}:${page}`)}`;
}

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
    const cacheEndpoint = normalizePageCacheEndpoint(params.endpoint);
    try {
      const json = JSON.stringify(params.rawJson);
      const hash = createHash('md5').update(json).digest('hex');
      const cacheMst = createHash('sha1').update(params.companyId).digest('hex').slice(0, 20);
      const cacheInvoiceId = buildPageCacheInvoiceId(params.companyId, params.endpoint, params.period, params.page);
      // period is 'YYYY-MM' — extract year for the NOT NULL period_year column
      const periodYear = parseInt(params.period.substring(0, 4), 10);
      // invoice_type CHECK constraint: only 'purchase' or 'sale'
      const invoiceType = params.endpoint.includes('purchase') ? 'purchase' : 'sale';

      // FIX: EXCLUDED is not accessible in RETURNING clause (only in DO UPDATE SET).
      // Detect content change by comparing the stored hash before upserting.
      // Use xmax trick: xmax=0 → fresh INSERT (always changed), xmax≠0 → UPDATE.
      // For UPDATEs we compare old vs new hash via a pre-fetch CTE.
      const res = await pool.query<{ old_hash: string | null }>(
        `WITH old AS (
           SELECT content_hash FROM gdt_raw_cache
           WHERE company_id = $1::uuid AND endpoint = $2::text
             AND page = $3::int AND period = $4::text
             AND company_id IS NOT NULL AND endpoint IS NOT NULL
             AND page IS NOT NULL AND period IS NOT NULL
         )
         INSERT INTO gdt_raw_cache
           (company_id, endpoint, page, period, content_hash, raw_json, fetched_at,
            mst, invoice_type, ma_hoa_don, period_year)
         VALUES ($1::uuid, $2::text, $3::int, $4::text, $5::text, $6::jsonb, NOW(),
                 $8::text, $9::text, $10::text, $7::smallint)
         ON CONFLICT (company_id, endpoint, page, period)
           WHERE company_id IS NOT NULL AND endpoint IS NOT NULL
             AND page IS NOT NULL AND period IS NOT NULL
         DO UPDATE
           SET content_hash = EXCLUDED.content_hash,
               raw_json     = EXCLUDED.raw_json,
               fetched_at   = EXCLUDED.fetched_at
         RETURNING (SELECT content_hash FROM old) AS old_hash`,
        [
          params.companyId,
          cacheEndpoint,
          params.page,
          params.period,
          hash,
          json,
          periodYear,
          cacheMst,
          invoiceType,
          cacheInvoiceId,
        ],
      );
      const oldHash = res.rows[0]?.old_hash ?? null;
      return oldHash === null || oldHash !== hash; // null = fresh insert (changed)
    } catch (err) {
      logger.warn('[GdtRawCache] upsertPage failed (non-fatal)', {
        companyId: params.companyId,
        endpoint:  params.endpoint,
        cacheEndpoint,
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
      const cacheEndpoint = normalizePageCacheEndpoint(params.endpoint);
      const res = await pool.query<{ raw_json: unknown }>(
        `SELECT raw_json FROM gdt_raw_cache
         WHERE company_id = $1 AND endpoint = $2 AND page = $3 AND period = $4
           AND fetched_at > NOW() - INTERVAL '25 hours'`,
        [params.companyId, cacheEndpoint, params.page, params.period],
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
