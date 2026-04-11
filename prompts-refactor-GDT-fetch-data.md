```
GDT XML → parse → JSON → gdt_raw_cache → logic cũ đọc y hệt trước
```

Cơ chế change detection dùng **content hash (MD5)** của XML payload — nếu hash không đổi thì skip, không fetch detail, tiết kiệm proxy tối đa.

---

## Prompt cho GitHub Copilot

```
# PROMPT GROUP 42: GDT Raw Cache Layer — Background Pre-fetch Architecture

## Context
We have an existing invoice sync system that:
1. Crawls GDT portal (hoadondientu.gdt.gov.vn) using Playwright
2. Receives XML invoice data from GDT
3. Parses XML → stores into `invoices` and `invoice_items` tables
4. Business logic reads from `invoices` table

## Goal
Introduce a new `gdt_raw_cache` table as a "GDT Local Mirror". The bot will:
- Fetch XML from GDT
- Parse XML → JSON (preserving full structure)
- Store into `gdt_raw_cache` with MD5 hash for change detection
- Skip detail fetch if hash unchanged (saves proxy bandwidth)
- Old business logic reads from this cache instead of calling GDT directly

Do NOT modify existing `invoices`, `invoice_items` tables or any existing parser logic.

---

## PROMPT 42.1 — Database Migration: gdt_raw_cache table

Create migration file: `migrations/042_create_gdt_raw_cache.sql`

```sql
-- GDT Local Mirror: stores raw invoice data as JSON, parsed from GDT XML
-- Bot writes here. Business logic reads from here.
CREATE TABLE gdt_raw_cache (
  id                BIGSERIAL PRIMARY KEY,
  
  -- Identity
  mst               VARCHAR(20)   NOT NULL,
  invoice_type      VARCHAR(10)   NOT NULL CHECK (invoice_type IN ('purchase', 'sale')),
  
  -- GDT invoice identifiers (from XML fields)
  ma_hoa_don        VARCHAR(100),          -- MCCQT from GDT (mã cơ quan thuế)
  so_hoa_don        VARCHAR(50),           -- SHDon
  ky_hieu_mau       VARCHAR(20),           -- KHMSHDon
  ky_hieu_hoa_don   VARCHAR(20),           -- KHHDon
  ngay_lap          DATE,                  -- NLap
  
  -- MST seller/buyer for quick lookup
  mst_nguoi_ban     VARCHAR(20),           -- NBan.MST
  mst_nguoi_mua     VARCHAR(20),           -- NMua.MST

  -- Period for batch queries
  period_year       SMALLINT      NOT NULL,
  period_month      SMALLINT,              -- NULL if quarterly/yearly query

  -- The full parsed JSON (from GDT XML, all fields preserved)
  raw_json          JSONB         NOT NULL,

  -- Change detection: MD5 hash of raw XML string before parsing
  -- If hash unchanged on re-fetch → skip update, no proxy wasted
  content_hash      VARCHAR(32)   NOT NULL,

  -- Sync metadata
  fetched_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  source_xml_size   INT,                   -- bytes of original XML (monitoring)
  gdt_tthai         SMALLINT,             -- trạng thái hóa đơn từ GDT list (1=hợp lệ, 2=thay thế...)
  gdt_ttxly         SMALLINT,             -- trạng thái xử lý
  
  -- Soft status for business logic
  is_deleted        BOOLEAN       NOT NULL DEFAULT FALSE,
  
  CONSTRAINT uq_gdt_raw_cache 
    UNIQUE (mst, invoice_type, ma_hoa_don)
);

-- Primary lookup: business logic reads by mst + type + period
CREATE INDEX idx_raw_cache_period 
  ON gdt_raw_cache (mst, invoice_type, period_year, period_month);

-- Change detection lookup  
CREATE INDEX idx_raw_cache_hash 
  ON gdt_raw_cache (mst, invoice_type, content_hash);

-- Freshness check
CREATE INDEX idx_raw_cache_fetched 
  ON gdt_raw_cache (fetched_at DESC);

-- JSONB index for common query fields
CREATE INDEX idx_raw_cache_json_ngay_lap 
  ON gdt_raw_cache ((raw_json->>'ngay_lap'));

-- Sync job dedup tracking
CREATE TABLE gdt_sync_queue_log (
  id              BIGSERIAL PRIMARY KEY,
  mst             VARCHAR(20)  NOT NULL,
  invoice_type    VARCHAR(10)  NOT NULL,
  period_year     SMALLINT     NOT NULL,
  period_month    SMALLINT,
  job_id          VARCHAR(100),            -- BullMQ job ID
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending', 
                  -- pending | running | done | failed | skipped
  triggered_by    VARCHAR(20)  NOT NULL DEFAULT 'scheduler',
                  -- scheduler | user | retry
  enqueued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  invoices_found  INT,
  invoices_updated INT,
  invoices_skipped INT,         -- hash unchanged, skipped
  error_message   TEXT,
  
  CONSTRAINT uq_sync_queue_active
    UNIQUE (mst, invoice_type, period_year, period_month, status)
    WHERE status IN ('pending', 'running')  -- only one active job per period
);
```

---

## PROMPT 42.2 — XML to JSON Parser Service

Create file: `src/services/gdtXmlParser.ts`

Parse GDT XML invoice format (HDon/DLHDon structure) into a clean JSON object.
Preserve ALL fields from the XML — do not filter anything out.

```typescript
// Input: raw XML string from GDT (HDon format per Thông tư 78/2021)
// Output: structured JSON preserving full GDT data hierarchy

interface GdtInvoiceJson {
  // TTChung (Thông tin chung)
  pban: string              // Phiên bản
  ten_hdon: string          // Tên hóa đơn (THDon)
  khmshhdon: string         // Ký hiệu mẫu số
  khhdon: string            // Ký hiệu hóa đơn
  shdon: string             // Số hóa đơn
  ngay_lap: string          // NLap (ISO date)
  dvt_te: string            // Đơn vị tiền tệ
  tgia: number              // Tỷ giá
  htt_toan: string          // Hình thức thanh toán
  mst_tcgp: string          // MST tổ chức cấp phép
  hdcttchinh: number        // Hóa đơn chứa thông tin chính
  tt_khac_chung: GdtTTKhac[]

  // NBan (Người bán)
  nban: {
    ten: string
    mst: string
    dchi: string
    sdthoai: string
    dctdtu: string
    stk_nhang: string
    ten_nhang: string
    tt_khac: GdtTTKhac[]
  }

  // NMua (Người mua)
  nmua: {
    ten: string
    mst: string
    dchi: string
    mk_hang: string
    sdthoai: string
    dctdtu: string
    hvtn_mhang: string
    stk_nhang: string
    ten_nhang: string
    tt_khac: GdtTTKhac[]
  }

  // DSHHDVu (Danh sách hàng hóa dịch vụ)
  ds_hhdvu: Array<{
    tchat: number           // Tính chất (1=hàng hóa, 2=dịch vụ...)
    stt: number
    mhhdvu: string
    thhdvu: string          // Tên hàng hóa dịch vụ
    dvtinh: string
    sluong: number
    dgia: number
    tl_ckhau: string
    st_ckhau: number
    th_tien: number         // Thành tiền chưa thuế
    tsuat: string           // Thuế suất
    t_thue: number          // Tiền thuế
    tt_khac: GdtTTKhac[]
  }>

  // TToan (Thanh toán)
  ttoan: {
    thttt_ltsuat: Array<{ tsuat: string; t_thue: number; th_tien: number }>
    tgt_cthue: number       // Tổng giá trị chưa thuế
    tgt_thue: number        // Tổng giá trị thuế
    ttcktmai: number        // Tiền chiết khấu thương mại
    tgtttt_bso: number      // Tổng tiền thanh toán bằng số
    tgtttt_bchu: string     // Tổng tiền thanh toán bằng chữ
    tt_khac: GdtTTKhac[]
  }

  // MCCQT — mã cơ quan thuế (quan trọng: đây là unique ID của GDT)
  ma_cqt: string

  // Signing timestamps
  thoi_gian_ky_nban: string  // Người bán ký
  thoi_gian_ky_cqt: string   // CQT ký (xác nhận)
}

interface GdtTTKhac {
  ttruong: string   // Tên trường
  dlieu: string     // Dữ liệu
  kdlieu: string    // Kiểu dữ liệu
}

export function parseGdtXmlToJson(xmlString: string): GdtInvoiceJson
export function extractContentHash(xmlString: string): string  // MD5 of xmlString
export function extractMaCqt(xmlString: string): string        // Quick extract MCCQT without full parse
```

Implementation requirements:
- Use `fast-xml-parser` library (already in project or install it)
- Handle missing/empty fields gracefully (return empty string, not throw)
- `extractContentHash`: use Node.js built-in `crypto.createHash('md5')`
- `extractMaCqt`: extract just the MCCQT value for quick dedup check before full parse
- Export a type `GdtInvoiceJson` for use in other services

---

## PROMPT 42.3 — GDT Raw Cache Service

Create file: `src/services/gdtRawCacheService.ts`

Handles all read/write operations on `gdt_raw_cache` table.

```typescript
// Key methods to implement:

// 1. Check if invoice needs update (change detection)
// SELECT content_hash FROM gdt_raw_cache 
// WHERE mst=$1 AND invoice_type=$2 AND ma_hoa_don=$3
// Compare with new hash → return 'insert' | 'update' | 'skip'
async function checkChangeStatus(
  mst: string,
  invoiceType: 'purchase' | 'sale', 
  maHoaDon: string,
  newHash: string
): Promise<'insert' | 'update' | 'skip'>

// 2. Upsert raw cache entry
// ON CONFLICT (mst, invoice_type, ma_hoa_don) DO UPDATE
// SET raw_json=$4, content_hash=$5, fetched_at=NOW(), ...
// Only called when checkChangeStatus returns 'insert' or 'update'
async function upsertRawCache(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null,
  parsedJson: GdtInvoiceJson,
  contentHash: string,
  rawXmlSize: number,
  gdtTthai?: number,
  gdtTtxly?: number
): Promise<void>

// 3. Read cache for business logic (replaces GDT direct call)
// Returns same structure that old parser returned from GDT
// This is the BRIDGE METHOD — old logic calls this instead of GDT
async function getRawCacheForPeriod(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number
): Promise<GdtInvoiceJson[]>

// 4. Get cache freshness info (for staleness indicator in UI)
async function getCacheMeta(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number
): Promise<{
  lastFetchedAt: Date | null
  totalInvoices: number
  isStale: boolean  // true if lastFetchedAt > 4 hours ago
}>

// 5. Batch check hashes (for list-level dedup before fetching details)
// SELECT ma_hoa_don, content_hash FROM gdt_raw_cache
// WHERE mst=$1 AND invoice_type=$2 AND period_year=$3
// Returns Map<maHoaDon, existingHash>
async function getBatchHashes(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth?: number
): Promise<Map<string, string>>
```

---

## PROMPT 42.4 — Sync Queue Dedup Guard

Create file: `src/services/syncQueueGuard.ts`

Prevent duplicate jobs from being enqueued for same MST + period.

```typescript
// Uses gdt_sync_queue_log table + Redis SET for fast in-memory check

// Key methods:

// 1. Try to acquire sync lock
// Check Redis first (fast path): key = `sync_lock:${mst}:${type}:${year}:${month}`
// If Redis miss, check DB for status IN ('pending','running')
// If already active → return { acquired: false, existingJobId }
// If free → INSERT into gdt_sync_queue_log + SET Redis key (TTL 30min)
// Returns { acquired: true, logId }
async function tryAcquireSyncLock(
  mst: string,
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null,
  triggeredBy: 'scheduler' | 'user' | 'retry'
): Promise<{ acquired: boolean; logId?: number; existingJobId?: string }>

// 2. Update job status (called by BullMQ worker at each stage)
async function updateSyncStatus(
  logId: number,
  status: 'running' | 'done' | 'failed' | 'skipped',
  stats?: { found?: number; updated?: number; skipped?: number; error?: string }
): Promise<void>

// 3. Release lock on completion/failure
// DELETE Redis key + UPDATE DB status
async function releaseSyncLock(
  logId: number,
  mst: string,
  invoiceType: string,
  periodYear: number,
  periodMonth: number | null,
  finalStatus: 'done' | 'failed' | 'skipped'
): Promise<void>

// 4. Get active sync status for UI (user can see "đang đồng bộ...")
async function getActiveSyncStatus(
  mst: string
): Promise<Array<{
  invoiceType: string
  periodYear: number
  periodMonth: number | null
  status: string
  enqueuedAt: Date
  triggeredBy: string
}>>
```

---

## PROMPT 42.5 — BullMQ Worker: GDT Raw Cache Sync Job

Create file: `src/workers/gdtRawCacheWorker.ts`

Worker that processes sync jobs. Implements the full pipeline with change detection.

```typescript
// Job payload interface
interface GdtRawCacheSyncJob {
  mst: string
  invoiceType: 'purchase' | 'sale'
  periodYear: number
  periodMonth: number | null
  triggeredBy: 'scheduler' | 'user' | 'retry'
  logId: number          // gdt_sync_queue_log.id
  priority: 'high' | 'normal' | 'low'
}

// Worker pipeline (in order):
// 
// STEP 1: Acquire lock via syncQueueGuard.tryAcquireSyncLock()
//         If not acquired → log and exit immediately (duplicate guard)
//
// STEP 2: Update status → 'running'
//
// STEP 3: Call CrawlerEngine to get invoice LIST from GDT
//         List contains: ma_hoa_don, so_hdon, ngay_lap, tong_tien, tthai, ttxly
//         Do NOT fetch XML detail yet
//
// STEP 4: Load existing hashes from gdt_raw_cache via getBatchHashes()
//         Build a Map<maHoaDon, existingHash>
//
// STEP 5: For each invoice in list:
//         a. Quick-extract maHoaDon from list item
//         b. Check if maHoaDon exists in existingHashes map
//         c. If exists AND tthai/ttxly unchanged → SKIP (no detail fetch)
//         d. If new OR status changed → enqueue detail fetch sub-job
//
// STEP 6: Process detail fetch sub-jobs (with human-like delays):
//         - Random delay 2000-5000ms between each invoice detail request
//         - Fetch XML from GDT for invoice detail
//         - Compute MD5 hash of raw XML
//         - Compare with existing hash → if same → skip upsert
//         - If different → parseGdtXmlToJson() → upsertRawCache()
//         - Track: found/updated/skipped counts
//
// STEP 7: Update gdt_sync_queue_log with final stats
//         Release sync lock via releaseSyncLock()
//
// Error handling:
// - On proxy 407 error → retry with different proxy, max 3 attempts
// - On GDT rate limit (429 or CAPTCHA) → exponential backoff, re-enqueue with delay
// - On partial failure → mark log status='failed', preserve already-fetched data

// Human-like delay helper
function humanDelay(minMs = 2000, maxMs = 5000): Promise<void>
// Returns random delay between min and max with slight gaussian distribution
// Use: Math.random() * (max - min) + min + gaussian jitter ±500ms
```

---

## PROMPT 42.6 — Scheduler: Background Pre-fetch Trigger

Create file: `src/schedulers/gdtRawCacheScheduler.ts`

Schedules background sync jobs for all active MSTs with jitter.

```typescript
// Runs every 15 minutes (master tick)
// For each active MST × invoice_type × current_period:
//   1. Check last fetched_at from gdt_raw_cache
//   2. If fetched_at < (NOW - refresh_interval) → enqueue sync job
//   3. Add random jitter ±10min to spread load
//
// Refresh intervals by trigger type:
//   - user-triggered: immediate (priority=high queue)
//   - scheduled current month: every 4 hours  
//   - scheduled previous months: every 24 hours (data rarely changes)
//   - historical (>3 months ago): every 72 hours
//
// Queue configuration:
//   - BullMQ queue name: 'gdt-raw-cache-sync'
//   - Priority: high=1, normal=5, low=10
//   - removeOnComplete: 100 (keep last 100 completed jobs)
//   - removeOnFail: 200
//   - attempts: 3
//   - backoff: { type: 'exponential', delay: 30000 }
//
// Anti-pattern detection:
//   - Never enqueue more than 3 jobs per MST simultaneously
//   - If proxy health < 30% → pause scheduler, alert admin
//   - Stagger MST processing: process max 10 MSTs per tick

async function scheduleSyncForAllActiveMsts(): Promise<void>
async function scheduleImmediateSync(
  mst: string, 
  invoiceType: 'purchase' | 'sale',
  periodYear: number,
  periodMonth: number | null
): Promise<{ jobId: string }>  // called when user manually triggers sync
```

---

## PROMPT 42.7 — Bridge: Old Logic Reads from Cache

Create file: `src/services/gdtDataBridge.ts`

This is the ONLY file that needs to change in old business logic.
Replace direct GDT calls with cache reads. Interface is identical.

```typescript
// OLD code (before):
// const invoices = await gdtClient.fetchInvoices(mst, type, year, month)
//
// NEW code (after):
// const invoices = await GdtDataBridge.fetchInvoices(mst, type, year, month)
//
// Interface is IDENTICAL — old business logic sees no difference

export class GdtDataBridge {
  
  // Main method: replaces direct GDT fetch
  // Reads from gdt_raw_cache, returns GdtInvoiceJson[]
  // If cache is empty or stale → triggers background sync + returns empty/stale data
  // Never blocks waiting for sync to complete
  static async fetchInvoices(
    mst: string,
    invoiceType: 'purchase' | 'sale',
    periodYear: number,
    periodMonth?: number
  ): Promise<{ 
    data: GdtInvoiceJson[]
    meta: { 
      fromCache: true
      lastFetchedAt: Date | null
      isStale: boolean
      staleSince?: string    // "2 giờ trước" for UI display
    }
  }>

  // Returns staleness info for UI badge
  // "Cập nhật lúc 14:32 · 23 phút trước" 
  static async getStalenessLabel(
    mst: string,
    invoiceType: 'purchase' | 'sale',
    periodYear: number,
    periodMonth?: number
  ): Promise<string>

  // Force sync trigger (user clicks "Làm mới ngay")
  // Enqueues high-priority job, returns jobId for SSE tracking
  static async triggerForceSync(
    mst: string,
    invoiceType: 'purchase' | 'sale', 
    periodYear: number,
    periodMonth?: number
  ): Promise<{ jobId: string; alreadyRunning: boolean }>
}
```

---

## PROMPT 42.8 — API Endpoint: Sync Status & Force Trigger

Add to existing router file or create `src/routes/syncRoutes.ts`

```typescript
// GET /api/sync/status/:mst
// Returns cache freshness for all periods of this MST
// Response: { periods: [{ type, year, month, lastFetchedAt, isStale, invoiceCount }] }

// POST /api/sync/trigger
// Body: { mst, invoiceType, periodYear, periodMonth }
// Triggers immediate high-priority sync
// Response: { jobId, alreadyRunning, message }
// If alreadyRunning=true → return existing jobId for SSE tracking

// GET /api/sync/job/:jobId/status  (SSE endpoint)
// Server-Sent Events stream
// Emits: { event: 'progress', data: { step, count, total } }
// Emits: { event: 'complete', data: { updated, skipped, duration } }
// Emits: { event: 'error', data: { message } }
// Use Redis pub/sub: worker publishes, SSE endpoint subscribes
// Auto-close stream after 'complete' or 'error' event

// Middleware:
// - Require valid JWT (mst must belong to authenticated user's org)
// - Rate limit force-trigger: max 2 per MST per hour
```

---

## Implementation Notes

1. Install dependency: `npm install fast-xml-parser`

2. `content_hash` strategy:
   - Hash the raw XML string BEFORE parsing
   - Use `crypto.createHash('md5').update(xmlString).digest('hex')`
   - Two invoices with identical XML will always have identical hash
   - If GDT only changes `tthai` (trạng thái) in the list without changing XML → 
     catch this via `gdt_tthai` column comparison, not hash

3. Two-level change detection:
   - Level 1 (fast, no detail fetch): compare `gdt_tthai` + `gdt_ttxly` from invoice list
   - Level 2 (after detail fetch): compare MD5 hash of full XML
   - Only proceed to Level 2 if Level 1 shows change

4. Proxy cost optimization:
   - Each skipped invoice = 1 saved proxy request
   - Typical scenario: 90%+ invoices unchanged on re-sync → 90% proxy savings
   - Log skip rate in `gdt_sync_queue_log.invoices_skipped` for monitoring

5. Do NOT modify these files:
   - `invoices` table schema
   - `invoice_items` table schema  
   - Any existing parser/transformer that reads from `invoices`
   - Only change: replace `gdtClient.fetchInvoices()` → `GdtDataBridge.fetchInvoices()`
```

---