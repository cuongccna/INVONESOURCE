/**
 * GdtRawCacheSyncWorker.ts
 *
 * BullMQ worker that reads from the `invoices` table (populated by the bot)
 * and populates `gdt_raw_cache` with parsed JSON + MD5 hash for change detection.
 *
 * Pipeline:
 *   STEP 1  — Already acquired lock before enqueue (syncQueueGuard)
 *   STEP 2  — Update status → 'running'
 *   STEP 3  — Query invoices for MST + type + period (invoice list from DB)
 *   STEP 4  — Load existing hashes via getBatchHashes() (batch dedup)
 *   STEP 5  — For each invoice: Level-1 check (tthai/ttxly from DB vs cache)
 *   STEP 6  — For changed invoices: compute hash from raw_xml, parse JSON, upsert
 *   STEP 7  — Update gdt_sync_queue_log with stats, release lock
 *
 * Human-like delay: randomised 200–800ms between invoice processing to avoid
 * hammering the database in bursts.
 *
 * Does NOT call GDT API directly. Uses invoices.raw_xml (already fetched by bot).
 * Does NOT modify invoices, invoice_items, or any existing table.
 */

import { Queue, Worker, Job } from 'bullmq';
import { pool } from '../db/pool';
import { env } from '../config/env';
import {
  parseGdtXmlToJson,
  extractContentHash,
  extractMaCqt,
} from '../services/gdtXmlParser';
import {
  upsertRawCache,
  getBatchHashes,
  getBatchStatusMap,
  updateStatusOnly,
} from '../services/gdtRawCacheService';
import {
  updateSyncStatus,
  releaseSyncLock,
  setJobId,
} from '../services/syncQueueGuard';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GdtRawCacheSyncJobPayload {
  mst:          string;
  companyId:    string;
  invoiceType:  'purchase' | 'sale';
  periodYear:   number;
  periodMonth:  number | null;
  triggeredBy:  'scheduler' | 'user' | 'retry';
  logId:        number;     // gdt_sync_queue_log.id — already created by syncQueueGuard
  priority:     'high' | 'normal' | 'low';
}

// ─── Queue ───────────────────────────────────────────────────────────────────

export const RAW_CACHE_QUEUE_NAME = 'gdt-raw-cache-sync';

export const gdtRawCacheSyncQueue = new Queue<GdtRawCacheSyncJobPayload>(RAW_CACHE_QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    attempts:         3,
    backoff:          { type: 'exponential', delay: 30_000 }, // 30s → 60s → 120s
    removeOnComplete: 100,
    removeOnFail:     200,
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Human-like delay between invoice processing to avoid DB burst writes.
 * Range: 200–800ms with slight jitter.
 */
function humanDelay(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 600) + Math.floor(Math.random() * 100 - 50);
  return new Promise((resolve) => setTimeout(resolve, Math.max(50, ms)));
}

/** Map invoice direction to cache invoice_type */
function directionToType(direction: string): 'purchase' | 'sale' {
  return direction === 'input' ? 'purchase' : 'sale';
}

/** Map invoice status string to numeric gdt_tthai (1=hợp lệ, 2=thay thế, 3=điều chỉnh, 4=xoá bỏ) */
function statusToTthai(status: string): number {
  switch (status) {
    case 'valid':      return 1;
    case 'replaced':   return 2;
    case 'adjusted':   return 3;
    case 'cancelled':  return 4;
    default:           return 1;
  }
}

// ─── Invoice row type read from DB ───────────────────────────────────────────

interface InvoiceRow {
  id:              string;
  direction:       string;
  invoice_number:  string;
  serial_number:   string | null;
  invoice_date:    string;
  seller_tax_code: string | null;
  seller_name:     string | null;
  buyer_tax_code:  string | null;
  buyer_name:      string | null;
  subtotal:        string;
  vat_rate:        string;
  vat_amount:      string;
  total_amount:    string;
  currency:        string;
  payment_method:  string | null;
  status:          string;
  raw_xml:         string | null;
  external_id:     string | null;
}

// ─── Core pipeline ───────────────────────────────────────────────────────────

async function processRawCacheSync(job: Job<GdtRawCacheSyncJobPayload>): Promise<void> {
  const {
    mst,
    companyId,
    invoiceType,
    periodYear,
    periodMonth,
    logId,
  } = job.data;

  // ── STEP 1: Register BullMQ job ID in log row (was created before enqueue) ──
  await setJobId(logId, mst, invoiceType, periodYear, periodMonth, job.id ?? `job-${logId}`);

  // ── STEP 2: Mark as running ───────────────────────────────────────────────
  await updateSyncStatus(logId, 'running');

  // ── STEP 3: Fetch invoice list from DB ───────────────────────────────────
  const direction = invoiceType === 'purchase' ? 'input' : 'output';
  const params: unknown[] = [companyId, direction, periodYear];
  let monthClause = '';
  if (periodMonth !== null && periodMonth !== undefined) {
    params.push(periodMonth);
    monthClause = `AND EXTRACT(MONTH FROM invoice_date) = $${params.length}`;
  }

  const listRes = await pool.query<InvoiceRow>(
    `SELECT id, direction, invoice_number, serial_number, invoice_date,
            seller_tax_code, seller_name, buyer_tax_code, buyer_name,
            subtotal, vat_rate, vat_amount, total_amount, currency,
            payment_method, status, raw_xml, external_id
     FROM invoices
     WHERE company_id = $1
       AND direction = $2
       AND EXTRACT(YEAR FROM invoice_date) = $3
       ${monthClause}
       AND deleted_at IS NULL
     ORDER BY invoice_date DESC`,
    params,
  );

  const invoiceList = listRes.rows;
  const totalFound  = invoiceList.length;

  if (totalFound === 0) {
    await releaseSyncLock(logId, mst, invoiceType, periodYear, periodMonth, 'done', {
      found: 0, updated: 0, skipped: 0,
    });
    return;
  }

  // ── STEP 4: Load existing hashes and status map ───────────────────────────
  const existingHashes    = await getBatchHashes(mst, invoiceType, periodYear, periodMonth ?? undefined);
  const existingStatusMap = await getBatchStatusMap(mst, invoiceType, periodYear, periodMonth ?? undefined);

  // ── STEP 5 + 6: Process each invoice ─────────────────────────────────────
  let updated = 0;
  let skipped = 0;
  let errors  = 0;

  for (const inv of invoiceList) {
    try {
      // Determine the unique GDT ID: use external_id (MCCQT) if present, fall back to invoice_number
      const maHoaDon = inv.external_id
        ? inv.external_id
        : inv.invoice_number;

      if (!maHoaDon) {
        skipped++;
        continue;
      }

      const currentTthai = statusToTthai(inv.status);
      const currentTtxly: number | null = null; // Not tracked separately in invoices table

      // Level-1 check: if tthai unchanged and invoice already cached → consider for skip
      const cachedStatus = existingStatusMap.get(maHoaDon);
      const tthaiChanged = !cachedStatus || cachedStatus.tthai !== currentTthai;

      // Compute content hash from raw_xml (optimal) or from invoice fields (fallback)
      let contentHash: string;
      let rawXmlSize: number | null = null;
      let parsedJson;

      if (inv.raw_xml) {
        // Level-2: hash from original XML string
        contentHash  = extractContentHash(inv.raw_xml);
        rawXmlSize   = Buffer.byteLength(inv.raw_xml, 'utf8');

        // Check against existing hash — if same and tthai also unchanged → skip
        const existingHash = existingHashes.get(maHoaDon);
        if (existingHash === contentHash && !tthaiChanged) {
          skipped++;
          continue;
        }

        // Parse XML to GdtInvoiceJson
        try {
          parsedJson = parseGdtXmlToJson(inv.raw_xml);
          // Ensure ma_cqt is set (MCCQT from XML or fallback to external_id)
          if (!parsedJson.ma_cqt && inv.external_id) {
            parsedJson = { ...parsedJson, ma_cqt: inv.external_id };
          }
        } catch {
          // If XML parse fails, fall through to JSON-based fallback
          parsedJson = null;
        }
      } else {
        contentHash = '';
      }

      if (!parsedJson) {
        // Fallback: construct GdtInvoiceJson from invoices table columns
        parsedJson = buildJsonFromInvoiceRow(inv, mst);
        // Hash from JSON content (not XML)
        contentHash = extractContentHash(JSON.stringify(parsedJson));
        rawXmlSize  = null;

        // Check existing hash
        const existingHashFallback = existingHashes.get(maHoaDon);
        if (existingHashFallback === contentHash && !tthaiChanged) {
          skipped++;
          continue;
        }
      }

      // If only status changed (no XML change), do lightweight status update
      if (!tthaiChanged && existingHashes.has(maHoaDon) && existingHashes.get(maHoaDon) === contentHash) {
        await updateStatusOnly(mst, invoiceType, maHoaDon, currentTthai, currentTtxly);
        updated++;
        continue;
      }

      // Upsert full cache entry
      await upsertRawCache(
        mst,
        invoiceType,
        periodYear,
        periodMonth,
        parsedJson,
        contentHash,
        rawXmlSize ?? 0,
        currentTthai,
        currentTtxly ?? undefined,
      );
      updated++;

      // Gentle pacing: add small delay between writes
      if (updated % 10 === 0) {
        await humanDelay();
      }
    } catch (err) {
      errors++;
      console.warn(
        `[GdtRawCacheSync] Error processing invoice ${inv.invoice_number} for ${mst}:`,
        (err as Error).message,
      );
    }
  }

  // ── STEP 7: Finalize ─────────────────────────────────────────────────────
  const finalStatus = errors === totalFound ? 'failed' : 'done';

  await releaseSyncLock(logId, mst, invoiceType, periodYear, periodMonth, finalStatus, {
    found:   totalFound,
    updated,
    skipped,
    error:   errors > 0 ? `${errors} invoice(s) failed to process` : undefined,
  });

  console.info(
    `[GdtRawCacheSync] Done: mst=${mst} type=${invoiceType} ${periodYear}/${periodMonth ?? '*'}` +
    ` found=${totalFound} updated=${updated} skipped=${skipped} errors=${errors}`,
  );
}

// ─── Fallback JSON builder ────────────────────────────────────────────────────

/**
 * When raw_xml is unavailable, build a GdtInvoiceJson from the invoices table columns.
 * Preserves all required fields with available data; missing GDT-specific fields return "".
 */
function buildJsonFromInvoiceRow(inv: InvoiceRow, mst: string) {
  const isOutput = inv.direction === 'output';
  const vatRateStr = `${Number(inv.vat_rate || 0)}%`;

  // Normalize invoice_date into ISO YYYY-MM-DD to avoid DB parse issues
  function normalizeDate(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date && !isNaN(value.getTime())) {
      return value.toISOString().split('T')[0];
    }
    const s = String(value).trim();
    // If already ISO-like
    const m = s.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
  }

  const isoDate = normalizeDate(inv.invoice_date);

  return {
    pban: '',
    ten_hdon: '',
    khmshhdon: inv.serial_number?.substring(0, 2) ?? '',
    khhdon: inv.serial_number ?? '',
    shdon: inv.invoice_number,
    ngay_lap: isoDate ?? '',
    dvt_te: inv.currency || 'VND',
    tgia: 1,
    htt_toan: inv.payment_method ?? '',
    mst_tcgp: '',
    hdcttchinh: 0,
    tt_khac_chung: [],
    nban: {
      ten:       isOutput ? '' : (inv.seller_name ?? ''),
      mst:       isOutput ? mst : (inv.seller_tax_code ?? ''),
      dchi:      '',
      sdthoai:   '',
      dctdtu:    '',
      stk_nhang: '',
      ten_nhang: '',
      tt_khac:   [],
    },
    nmua: {
      ten:        isOutput ? (inv.buyer_name ?? '') : '',
      mst:        isOutput ? (inv.buyer_tax_code ?? '') : mst,
      dchi:       '',
      mk_hang:    '',
      sdthoai:    '',
      dctdtu:     '',
      hvtn_mhang: '',
      stk_nhang:  '',
      ten_nhang:  '',
      tt_khac:    [],
    },
    ds_hhdvu: [],  // Line items not available without XML
    ttoan: {
      thttt_ltsuat: [{
        tsuat:   vatRateStr,
        t_thue:  Number(inv.vat_amount ?? 0),
        th_tien: Number(inv.subtotal ?? 0),
      }],
      tgt_cthue:    Number(inv.subtotal ?? 0),
      tgt_thue:     Number(inv.vat_amount ?? 0),
      ttcktmai:     0,
      tgtttt_bso:   Number(inv.total_amount ?? 0),
      tgtttt_bchu:  '',
      tt_khac:      [],
    },
    ma_cqt:             inv.external_id ?? '',
    thoi_gian_ky_nban:  '',
    thoi_gian_ky_cqt:   '',
  };
}

// ─── Worker (auto-started on import) ─────────────────────────────────────────

export const gdtRawCacheSyncWorker = new Worker<GdtRawCacheSyncJobPayload>(
  RAW_CACHE_QUEUE_NAME,
  processRawCacheSync,
  {
    connection:  { url: env.REDIS_URL },
    concurrency: 3,   // Process up to 3 companies in parallel
  },
);

gdtRawCacheSyncWorker.on('failed', (job, err) => {
  if (job) {
    console.error(
      `[GdtRawCacheSync] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 3}):`,
      err.message,
    );
    // On final attempt failure, ensure lock is released
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      const { logId, mst, invoiceType, periodYear, periodMonth } = job.data;
      releaseSyncLock(logId, mst, invoiceType, periodYear, periodMonth, 'failed', {
        error: err.message,
      }).catch((releaseErr: Error) => {
        console.error('[GdtRawCacheSync] Failed to release lock on job failure:', releaseErr.message);
      });
    }
  }
});
