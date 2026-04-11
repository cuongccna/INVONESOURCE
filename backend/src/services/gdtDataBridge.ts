/**
 * gdtDataBridge.ts
 *
 * THE ONLY file that business logic needs to change when migrating from
 * direct GDT calls to the new cache layer.
 *
 * OLD code:
 *   const invoices = await gdtClient.fetchInvoices(mst, type, year, month)
 *
 * NEW code:
 *   const result = await GdtDataBridge.fetchInvoices(mst, type, year, month)
 *   const invoices = result.data
 *
 * Interface is identical in terms of data shape.
 * Added meta.fromCache, meta.isStale, meta.lastFetchedAt for UI indicators.
 *
 * If cache is empty or stale → triggers background sync (non-blocking).
 * Never blocks waiting for sync to complete.
 * Never calls GDT directly.
 *
 * Does NOT modify invoices, invoice_items, or any existing logic.
 */

import { getCacheMeta, getRawCacheForPeriod } from './gdtRawCacheService';
import { scheduleImmediateSync } from '../jobs/GdtRawCacheScheduler';
import { pool } from '../db/pool';
import type { GdtInvoiceJson } from './gdtXmlParser';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FetchResult {
  data: GdtInvoiceJson[];
  meta: {
    fromCache:     true;
    lastFetchedAt: Date | null;
    isStale:       boolean;
    staleSince?:   string;   // Human-readable: "2 giờ trước"
    totalCached:   number;
  };
}

export interface TriggerResult {
  jobId:          string;
  alreadyRunning: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatStaleSince(lastFetchedAt: Date | null): string | undefined {
  if (!lastFetchedAt) return undefined;
  const diffMs      = Date.now() - lastFetchedAt.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours   = Math.floor(diffMinutes / 60);
  const diffDays    = Math.floor(diffHours / 24);

  if (diffDays > 0)    return `${diffDays} ngày trước`;
  if (diffHours > 0)   return `${diffHours} giờ trước`;
  return `${diffMinutes} phút trước`;
}

function formatLabel(lastFetchedAt: Date | null): string {
  if (!lastFetchedAt) return 'Chưa cập nhật';
  const hh = lastFetchedAt.getHours().toString().padStart(2, '0');
  const mm  = lastFetchedAt.getMinutes().toString().padStart(2, '0');
  const since = formatStaleSince(lastFetchedAt);
  return `Cập nhật lúc ${hh}:${mm}${since ? ` · ${since}` : ''}`;
}

async function getCompanyIdForMst(mst: string): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM companies WHERE tax_code = $1 AND deleted_at IS NULL LIMIT 1`,
    [mst],
  );
  return res.rows[0]?.id ?? null;
}

// ─── GdtDataBridge ───────────────────────────────────────────────────────────

export class GdtDataBridge {

  /**
   * Fetch invoices from the GDT raw cache.
   *
   * If cache is empty or stale:
   *   - Triggers a background sync (non-blocking)
   *   - Returns currently cached data (even if stale/empty)
   *
   * Never blocks on the sync. Caller gets stale data immediately with
   * meta.isStale=true to show a UI indicator.
   */
  static async fetchInvoices(
    mst: string,
    invoiceType: 'purchase' | 'sale',
    periodYear: number,
    periodMonth?: number,
  ): Promise<FetchResult> {
    // Read cache
    const [data, meta] = await Promise.all([
      getRawCacheForPeriod(mst, invoiceType, periodYear, periodMonth),
      getCacheMeta(mst, invoiceType, periodYear, periodMonth),
    ]);

    // If stale or empty, trigger background sync (fire-and-forget)
    if (meta.isStale || data.length === 0) {
      GdtDataBridge.triggerForceSync(mst, invoiceType, periodYear, periodMonth)
        .catch((err: Error) => {
          console.warn(
            `[GdtDataBridge] Background sync trigger failed for ${mst}/${invoiceType}:`,
            err.message,
          );
        });
    }

    return {
      data,
      meta: {
        fromCache:     true,
        lastFetchedAt: meta.lastFetchedAt,
        isStale:       meta.isStale,
        staleSince:    meta.isStale ? formatStaleSince(meta.lastFetchedAt) : undefined,
        totalCached:   meta.totalInvoices,
      },
    };
  }

  /**
   * Get a human-readable staleness label for UI display.
   * e.g. "Cập nhật lúc 14:32 · 23 phút trước"
   */
  static async getStalenessLabel(
    mst: string,
    invoiceType: 'purchase' | 'sale',
    periodYear: number,
    periodMonth?: number,
  ): Promise<string> {
    const meta = await getCacheMeta(mst, invoiceType, periodYear, periodMonth);
    return formatLabel(meta.lastFetchedAt);
  }

  /**
   * Force an immediate high-priority sync for this MST + period.
   * Called when user clicks "Làm mới ngay".
   *
   * Returns jobId for SSE tracking + alreadyRunning flag.
   * If sync is already running, returns the existing jobId.
   */
  static async triggerForceSync(
    mst: string,
    invoiceType: 'purchase' | 'sale',
    periodYear: number,
    periodMonth?: number,
  ): Promise<TriggerResult> {
    // Resolve companyId from MST
    const companyId = await getCompanyIdForMst(mst);
    if (!companyId) {
      return { jobId: '', alreadyRunning: false };
    }

    const result = await scheduleImmediateSync(
      mst,
      companyId,
      invoiceType,
      periodYear,
      periodMonth ?? null,
      'user',
    );

    return {
      jobId:          result.jobId,
      alreadyRunning: result.alreadyRunning,
    };
  }

  /**
   * Get sync status summary for all periods of this MST.
   * Used by the status API endpoint.
   */
  static async getPeriodSummary(
    mst: string,
    periodYear: number,
  ): Promise<Array<{
    invoiceType:   'purchase' | 'sale';
    periodMonth:   number | null;
    lastFetchedAt: Date | null;
    isStale:       boolean;
    invoiceCount:  number;
    stalenessLabel: string;
  }>> {
    const invoiceTypes = ['purchase', 'sale'] as const;
    const months       = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, null];

    const results = await Promise.all(
      invoiceTypes.flatMap((invoiceType) =>
        months.map(async (periodMonth) => {
          const meta = await getCacheMeta(mst, invoiceType, periodYear, periodMonth ?? undefined);
          if (!meta.lastFetchedAt && meta.totalInvoices === 0) return null;
          return {
            invoiceType,
            periodMonth,
            lastFetchedAt:  meta.lastFetchedAt,
            isStale:        meta.isStale,
            invoiceCount:   meta.totalInvoices,
            stalenessLabel: formatLabel(meta.lastFetchedAt),
          };
        }),
      ),
    );

    return results.filter(<T>(v: T | null): v is T => v !== null);
  }
}
