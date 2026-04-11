/**
 * gdtRawCacheService.ts
 *
 * All read/write operations on the `gdt_raw_cache` table.
 * This is the single source of truth for GDT cached invoice data.
 *
 * Two-level change detection strategy:
 *   Level 1: gdt_tthai / gdt_ttxly comparison (no detail fetch needed)
 *   Level 2: MD5 hash of full XML (after detail fetch)
 *
 * Business logic reads from this cache via gdtDataBridge.ts.
 * Never calls GDT directly.
 */

import { pool } from '../db/pool';
import { GdtInvoiceJson } from './gdtXmlParser';

export type ChangeStatus = 'insert' | 'update' | 'skip';

// ─── 1. Change detection ─────────────────────────────────────────────────────

/**
 * Check whether an invoice needs to be inserted/updated in the cache.
 *
 * Returns:
 *   'insert' — not in cache yet
 *   'update' — in cache but hash is different (content changed)
 *   'skip'   — in cache with identical hash (no change, proxy saved)
 */
export async function checkChangeStatus(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  maHoaDon: string,
  newHash: string,
): Promise<ChangeStatus> {
  const res = await pool.query<{ content_hash: string }>(
    `SELECT content_hash
     FROM gdt_raw_cache
     WHERE mst = $1 AND invoice_type = $2 AND ma_hoa_don = $3
     LIMIT 1`,
    [mst, invoiceType, maHoaDon],
  );

  if (res.rowCount === 0) return 'insert';
  return res.rows[0].content_hash === newHash ? 'skip' : 'update';
}

// ─── 2. Upsert ───────────────────────────────────────────────────────────────

/**
 * Insert or update a cached invoice entry.
 * Only call this when checkChangeStatus returns 'insert' or 'update'.
 */
export async function upsertRawCache(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null,
  parsedJson: GdtInvoiceJson,
  contentHash: string,
  rawXmlSize: number,
  gdtTthai?: number,
  gdtTtxly?: number,
): Promise<void> {
  const maHoaDon  = parsedJson.ma_cqt || null;
  const soHoaDon  = parsedJson.shdon || null;
  const kyHieuMau = parsedJson.khmshhdon || null;
  const kyHieuHd  = parsedJson.khhdon || null;
  // ngay_lap is ISO date string or empty; convert to Date or null
  const ngayLap   = parsedJson.ngay_lap ? parsedJson.ngay_lap : null;
  const mstNban   = parsedJson.nban.mst || null;
  const mstNmua   = parsedJson.nmua.mst || null;

  await pool.query(
    `INSERT INTO gdt_raw_cache (
       mst, invoice_type, ma_hoa_don, so_hoa_don, ky_hieu_mau, ky_hieu_hoa_don,
       ngay_lap, mst_nguoi_ban, mst_nguoi_mua,
       period_year, period_month,
       raw_json, content_hash, fetched_at,
       source_xml_size, gdt_tthai, gdt_ttxly,
       is_deleted, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13, NOW(),
       $14, $15, $16,
       FALSE, NOW(), NOW()
     )
     ON CONFLICT (mst, invoice_type, ma_hoa_don)
     DO UPDATE SET
       so_hoa_don       = EXCLUDED.so_hoa_don,
       ky_hieu_mau      = EXCLUDED.ky_hieu_mau,
       ky_hieu_hoa_don  = EXCLUDED.ky_hieu_hoa_don,
       ngay_lap         = EXCLUDED.ngay_lap,
       mst_nguoi_ban    = EXCLUDED.mst_nguoi_ban,
       mst_nguoi_mua    = EXCLUDED.mst_nguoi_mua,
       period_year      = EXCLUDED.period_year,
       period_month     = EXCLUDED.period_month,
       raw_json         = EXCLUDED.raw_json,
       content_hash     = EXCLUDED.content_hash,
       fetched_at       = NOW(),
       source_xml_size  = EXCLUDED.source_xml_size,
       gdt_tthai        = EXCLUDED.gdt_tthai,
       gdt_ttxly        = EXCLUDED.gdt_ttxly,
       updated_at       = NOW()`,
    [
      mst, invoiceType, maHoaDon, soHoaDon, kyHieuMau, kyHieuHd,
      ngayLap, mstNban, mstNmua,
      periodYear, periodMonth,
      JSON.stringify(parsedJson), contentHash,
      rawXmlSize, gdtTthai ?? null, gdtTtxly ?? null,
    ],
  );
}

// ─── 3. Read for business logic ──────────────────────────────────────────────

/**
 * Read cached invoices for a given MST, type, and period.
 * This is the bridge method — old logic calls this instead of GDT directly.
 * Returns only non-deleted entries.
 */
export async function getRawCacheForPeriod(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number,
): Promise<GdtInvoiceJson[]> {
  const params: unknown[] = [mst, invoiceType, periodYear];
  let monthClause = '';
  if (periodMonth !== undefined && periodMonth !== null) {
    params.push(periodMonth);
    monthClause = `AND period_month = $${params.length}`;
  }

  const res = await pool.query<{ raw_json: GdtInvoiceJson }>(
    `SELECT raw_json
     FROM gdt_raw_cache
     WHERE mst = $1
       AND invoice_type = $2
       AND period_year = $3
       ${monthClause}
       AND is_deleted = FALSE
     ORDER BY ngay_lap DESC, id DESC`,
    params,
  );

  return res.rows.map((r) => r.raw_json as GdtInvoiceJson);
}

// ─── 4. Cache freshness info ─────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface CacheMeta {
  lastFetchedAt: Date | null;
  totalInvoices: number;
  isStale: boolean;
}

/**
 * Get freshness metadata for a given MST + period.
 * isStale = true if last fetch was more than 4 hours ago (or never fetched).
 */
export async function getCacheMeta(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number,
): Promise<CacheMeta> {
  const params: unknown[] = [mst, invoiceType, periodYear];
  let monthClause = '';
  if (periodMonth !== undefined && periodMonth !== null) {
    params.push(periodMonth);
    monthClause = `AND period_month = $${params.length}`;
  }

  const res = await pool.query<{ last_fetched: string | null; total: string }>(
    `SELECT MAX(fetched_at) AS last_fetched, COUNT(*) AS total
     FROM gdt_raw_cache
     WHERE mst = $1
       AND invoice_type = $2
       AND period_year = $3
       ${monthClause}
       AND is_deleted = FALSE`,
    params,
  );

  const row = res.rows[0];
  const lastFetchedAt = row.last_fetched ? new Date(row.last_fetched) : null;
  const totalInvoices = parseInt(row.total, 10);
  const isStale = !lastFetchedAt || Date.now() - lastFetchedAt.getTime() > STALE_THRESHOLD_MS;

  return { lastFetchedAt, totalInvoices, isStale };
}

// ─── 5. Batch hash check ─────────────────────────────────────────────────────

/**
 * Load existing hashes for batch dedup before fetching invoice details.
 * Returns a Map<maHoaDon, existingHash> for O(1) lookup during sync.
 */
export async function getBatchHashes(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number,
): Promise<Map<string, string>> {
  const params: unknown[] = [mst, invoiceType, periodYear];
  let monthClause = '';
  if (periodMonth !== undefined && periodMonth !== null) {
    params.push(periodMonth);
    monthClause = `AND period_month = $${params.length}`;
  }

  const res = await pool.query<{ ma_hoa_don: string; content_hash: string; gdt_tthai: number | null; gdt_ttxly: number | null }>(
    `SELECT ma_hoa_don, content_hash, gdt_tthai, gdt_ttxly
     FROM gdt_raw_cache
     WHERE mst = $1
       AND invoice_type = $2
       AND period_year = $3
       ${monthClause}
       AND is_deleted = FALSE`,
    params,
  );

  const map = new Map<string, string>();
  for (const row of res.rows) {
    if (row.ma_hoa_don) {
      map.set(row.ma_hoa_don, row.content_hash);
    }
  }
  return map;
}

/**
 * Load existing gdt_tthai + gdt_ttxly for Level-1 change detection.
 * Avoids fetching invoice detail XML when only status fields unchanged.
 */
export async function getBatchStatusMap(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number,
): Promise<Map<string, { tthai: number | null; ttxly: number | null }>> {
  const params: unknown[] = [mst, invoiceType, periodYear];
  let monthClause = '';
  if (periodMonth !== undefined && periodMonth !== null) {
    params.push(periodMonth);
    monthClause = `AND period_month = $${params.length}`;
  }

  const res = await pool.query<{ ma_hoa_don: string; gdt_tthai: number | null; gdt_ttxly: number | null }>(
    `SELECT ma_hoa_don, gdt_tthai, gdt_ttxly
     FROM gdt_raw_cache
     WHERE mst = $1
       AND invoice_type = $2
       AND period_year = $3
       ${monthClause}
       AND is_deleted = FALSE`,
    params,
  );

  const map = new Map<string, { tthai: number | null; ttxly: number | null }>();
  for (const row of res.rows) {
    if (row.ma_hoa_don) {
      map.set(row.ma_hoa_don, { tthai: row.gdt_tthai, ttxly: row.gdt_ttxly });
    }
  }
  return map;
}

/**
 * Update only the status columns (tthai/ttxly) for an invoice.
 * Used when Level-1 detection shows status changed but XML content did not.
 */
export async function updateStatusOnly(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  maHoaDon: string,
  gdtTthai: number | null,
  gdtTtxly: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE gdt_raw_cache
     SET gdt_tthai = $4, gdt_ttxly = $5, updated_at = NOW()
     WHERE mst = $1 AND invoice_type = $2 AND ma_hoa_don = $3`,
    [mst, invoiceType, maHoaDon, gdtTthai, gdtTtxly],
  );
}
