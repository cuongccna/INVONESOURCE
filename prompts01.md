# INVONE — BOT-SCO-FIX-FINAL
# Fix triệt để: dùng total từ GDT body để detect truncation, loại bỏ timezone risk
# File: src/gdt-direct-api.service.ts

---

## Phân tích lỗi hiện tại (từ log 2026-04-24)

```
Log thực tế vs GDT portal:
  GDT probe → total: 608 (cho full tháng 2)
  BOT fetch  → 740 raw → 340 sau dedup → THIẾU 268 HĐ

Lỗi 1 — FALSE POSITIVE truncation detection:
  chunk2 (Feb 2-8): weekResult=350 = 7 pages × 50, KHÔNG truncated
  350 % 50 === 0 → code kích hoạt daily sub-split (SAI)
  daily=390 > weekly=350 → dùng daily → thêm 40 HĐ ranh giới (duplicate)
  Sau DB dedup: ít hơn 350 thực tế

Lỗi 2 — Daily cũng bị truncate, không detect:
  02/02: dayResult=150, 150%50=0 → CŨNG truncated nhưng code không xử lý
  03/02: dayResult=150, tương tự

Lỗi 3 — Weekly truncated nhưng daily cho ít hơn, code dùng truncated weekly:
  chunk3: weekly=100 (truncated), daily=97 → code dùng weekly=100 (sai)
  chunk5: weekly=150 (truncated), daily=111 → code dùng weekly=150 (sai)

Lỗi 4 — Timezone risk từ split theo ngày:
  splitIntoDays dùng setHours(0,0,0,0) — theo local time của server
  Nếu server chạy UTC: 00:00:00 UTC = 07:00:00 VN → bỏ sót HĐ 00:00-07:00 VN
  Invoice tại ranh giới ngày có thể xuất hiện trong BOTH adjacent windows

Lỗi 5 — GdtRawCache SQL type error (parameter $3):
  err: "inconsistent types deduced for parameter $3"
  page (number) bị type conflict với column INT trong SQL
```

**Root cause thực sự:** Dùng `result.length % pageSize === 0` để detect truncation là SAI.
GDT trả `total` chính xác trong response body (screenshot xác nhận: `"total": 608`).
Chỉ cần so sánh `fetched < GDT_reported_total` để biết có truncation hay không.

---

## Giải pháp: Dùng `reportedTotal` từ GDT — loại bỏ hoàn toàn timezone split

**Nguyên tắc:**
```
GDT đã biết chính xác có bao nhiêu HĐ trong window [from, to]
→ Dùng số đó làm ground truth
→ Nếu fetched < GDT_reported_total: THỰC SỰ bị truncate → chia nhỏ window
→ Nếu fetched == GDT_reported_total: ĐẦY ĐỦ → không cần chia
→ Loại bỏ hoàn toàn rủi ro timezone vì không còn tự đoán ranh giới
```

---

## FIX 1: Thay đổi `_fetchAllPagesBuffered` — trả về `reportedTotal`

**Trong `gdt-direct-api.service.ts`**, thay đổi signature của `_fetchAllPagesBuffered`
để trả về object thay vì array thuần:

### Bước 1a: Thêm interface `FetchResult` (đặt sau `GdtPagedResponse` interface)

```typescript
/**
 * Result of _fetchAllPagesBuffered.
 * rows:          actual invoice objects fetched.
 * reportedTotal: total count GDT reported in the FIRST page's response body.
 *                This is the ground truth — used by _fetchScoByWeeks to detect
 *                TRUE truncation (fetched < reportedTotal) vs complete fetch.
 *                -1 if GDT did not return a total field (treat as complete).
 */
interface FetchResult {
  rows:          RawInvoice[];
  reportedTotal: number;   // -1 = unknown (no total in response)
}
```

### Bước 1b: Sửa `_fetchAllPagesBuffered` — capture `reportedTotal` từ page đầu tiên

Tìm method `_fetchAllPagesBuffered` trong file. Thay toàn bộ nội dung bằng:

```typescript
private async _fetchAllPagesBuffered(
  endpoint:     'sold' | 'purchase',
  fromDate:     Date,
  toDate:       Date,
  extraFilter?: string,
  overridePath?: string,
): Promise<FetchResult> {   // ← Return type đổi từ Promise<RawInvoice[]> → Promise<FetchResult>
  if (!this.token) throw new Error('Not authenticated — call login() first');

  const direction: 'output' | 'input' = endpoint === 'sold' ? 'output' : 'input';
  const pageSize    = this.recipe?.api.pagination.pageSize ?? PAGE_SIZE;
  const endpointPath = overridePath
    ?? (endpoint === 'sold'
      ? (this.recipe?.api.endpoints.sold     ?? '/query/invoices/sold')
      : (this.recipe?.api.endpoints.purchase ?? '/query/invoices/purchase'));

  const from   = formatGdtDate(fromDate);
  const to     = formatGdtDate(toDate);
  const search = extraFilter
    ? `tdlap=ge=${from};tdlap=le=${to};${extraFilter}`
    : `tdlap=ge=${from};tdlap=le=${to}`;

  const all: RawInvoice[] = [];
  let total         = Infinity;
  let reportedTotal = -1;    // ← GDT's own reported count, captured on first page

  // Checkpoint resume
  const yyyymm = this._companyId
    ? `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, '0')}`
    : null;
  let page = 0;
  if (this._checkpoint && this._companyId && yyyymm) {
    page = await this._checkpoint.loadStartPage(this._companyId, yyyymm, direction).catch(() => 0);
    if (page > 0) {
      logger.info('[GdtDirect] Resuming from checkpoint', {
        companyId: this._companyId, page, direction,
      });
    }
  }

  logger.info('[GdtDirect] Fetching invoices', {
    endpoint, from, to, filter: extraFilter ?? 'none', startPage: page,
  });

  while (all.length < total) {
    const res = await this._getWithRetry<GdtPagedResponse>(
      endpointPath,
      { sort: 'tdlap:desc', size: pageSize, page, search },
    );

    const rows = res.data.datas ?? res.data.data ?? [];

    // ── Capture GDT's reported total (ground truth) on FIRST page only ──────
    // Subsequent pages may return different/stale total values.
    // First page is most reliable.
    if (reportedTotal === -1) {
      const headerTotal = parseInt(res.headers['x-total-count'] ?? '', 10);
      if (!isNaN(headerTotal) && headerTotal >= 0) {
        reportedTotal = headerTotal;
        total = reportedTotal > 0 ? reportedTotal : Infinity;
      } else if (res.data.total != null && Number(res.data.total) >= 0) {
        reportedTotal = Number(res.data.total);
        total = reportedTotal > 0 ? reportedTotal : Infinity;
      }
      // If reportedTotal still -1: GDT gave no total → loop until empty page
    }

    if (rows.length === 0) break;

    const isSco = overridePath?.includes('sco-query') ?? false;
    const mapped = rows.map(r => mapInvoice(r, direction, {
      ttxlyFilter:      extraFilter,
      isSco,
      fields:           this.recipe?.fields,
      statusMap:        this.recipe?.statusMap,
      xmlAvailableTtxly: this.recipe
        ? new Set(this.recipe.api.query.xmlAvailableTtxly)
        : undefined,
    }));
    all.push(...mapped);

    logger.debug('[GdtDirect] Page fetched', {
      endpoint, page, rows: rows.length, soFar: all.length,
      reportedTotal: reportedTotal === -1 ? 'unknown' : reportedTotal,
    });

    // Raw cache (non-fatal)
    if (this._rawCache && this._companyId) {
      const period = `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, '0')}`;
      void this._rawCache.upsertPage({
        companyId: this._companyId,
        endpoint:  endpointPath,
        page:      page,       // ← Fix bug: pass as number explicitly
        period,
        rawJson:   res.data,
      });
    }

    // Checkpoint (non-fatal)
    if (this._checkpoint && this._companyId && yyyymm) {
      await this._checkpoint.save(this._companyId, yyyymm, direction, page).catch(() => {});
    }

    if (all.length >= total) break;
    if (rows.length < pageSize) break;   // Natural end of stream
    page++;
    await humanDelay(800, 2500);
  }

  logger.info('[GdtDirect] Fetch complete', {
    endpoint,
    fetched: all.length,
    reportedTotal: reportedTotal === -1 ? 'unknown' : reportedTotal,
    complete: reportedTotal === -1 ? 'unknown' : all.length >= reportedTotal,
  });

  // Checkpoint clear on success
  if (this._checkpoint && this._companyId && yyyymm) {
    await this._checkpoint.clear(this._companyId, yyyymm, direction).catch(() => {});
  }

  return { rows: all, reportedTotal };
}
```

---

## FIX 2: Thay toàn bộ `_fetchScoByWeeks` — dùng `reportedTotal` để detect truncation

Thay thế toàn bộ method `_fetchScoByWeeks`:

```typescript
/**
 * Fetch SCO invoices cho một date range với auto-recovery khi bị truncation.
 *
 * STRATEGY (đúng, không còn timezone risk):
 *   1. GDT probe → biết tổng số HĐ trong full range (reportedTotal)
 *   2. Chia range thành weekly chunks → fetch từng chunk
 *   3. Sau mỗi chunk: so sánh fetched vs GDT's own reportedTotal cho CHUNK ĐÓ
 *      - fetched == reportedTotal → HOÀN TOÀN ĐẦY ĐỦ, không cần làm gì thêm
 *      - fetched <  reportedTotal → THỰC SỰ BỊ TRUNCATE (GDT bảo có nhiều hơn)
 *        → chia chunk đó thành daily sub-splits và fetch lại
 *   4. Với daily sub-splits: cũng kiểm tra fetched vs reportedTotal của từng ngày
 *      - Nếu ngày đó vẫn truncated → chia thành 2-hour sub-sub-splits
 *   5. Sau tất cả: dedup theo invoice_number+serial trong bộ nhớ
 *      → loại bỏ duplicate từ boundary overlap trước khi đưa vào DB
 *
 * TIMEZONE SAFETY:
 *   Không tự đoán ranh giới HĐ theo giờ (nguy cơ miss HĐ 00:00-07:00 VN)
 *   Dùng GDT reportedTotal làm ground truth → biết chắc có thiếu không
 *   Khi daily chunk thiếu → split 2h window → GDT bảo đủ → dừng
 *
 * Áp dụng cho /sco-query/invoices/sold và /sco-query/invoices/purchase.
 * Không cần cho /query (pagination thông thường hoạt động đúng).
 */
private async _fetchScoByWeeks(
  endpoint: 'sold' | 'purchase',
  fromDate: Date,
  toDate:   Date,
  scoPath:  string,
): Promise<RawInvoice[]> {
  const pageSize   = this.recipe?.api.pagination.pageSize ?? PAGE_SIZE;
  const weekChunks = splitIntoWeeks(fromDate, toDate);

  // ── Probe: lấy tổng số HĐ GDT report cho full range ────────────────────────
  const probeCount = await this.prefetchCount(endpoint, fromDate, toDate, undefined, scoPath);
  if (probeCount < 0) {
    logger.info('[GdtDirect] SCO probe: no SCO/MTT setup for this company', {
      endpoint, from: formatGdtDate(fromDate), to: formatGdtDate(toDate),
    });
    return [];
  }
  logger.info('[GdtDirect] SCO probe OK', {
    endpoint, probeTotal: probeCount, totalWeekChunks: weekChunks.length,
    from: formatGdtDate(fromDate), to: formatGdtDate(toDate),
  });

  // ── Collect all invoices (raw, may have duplicates from window overlaps) ───
  const seen = new Map<string, RawInvoice>(); // key = invoice_number|serial|seller_tax

  const _deduplicateAndAdd = (invoices: RawInvoice[]): number => {
    let added = 0;
    for (const inv of invoices) {
      // In-memory dedup key: same as DB dedup
      const key = `${inv.invoice_number ?? ''}|${inv.serial_number ?? ''}|${inv.seller_tax_code ?? ''}`;
      if (key !== '||' && !seen.has(key)) {
        seen.set(key, inv);
        added++;
      }
    }
    return added;
  };

  // ── Process weekly chunks ─────────────────────────────────────────────────
  for (let i = 0; i < weekChunks.length; i++) {
    if (i > 0) await humanDelay(2_000, 4_000);
    const { from, to } = weekChunks[i]!;

    try {
      const { rows: weekRows, reportedTotal: weekTotal } =
        await this._fetchAllPagesBuffered(endpoint, from, to, undefined, scoPath);

      // ── Truncation check: dùng GDT's own reportedTotal ──────────────────
      // TRUE truncation: GDT says there are N invoices but we only got M < N
      // FALSE positive (cũ): M%pageSize==0 — SAI vì M=350 & total=350 là đầy đủ
      const isTruncated = weekTotal > 0 && weekRows.length < weekTotal;

      if (!isTruncated) {
        // Hoàn toàn đầy đủ — không cần chia nhỏ
        const added = _deduplicateAndAdd(weekRows);
        logger.debug('[GdtDirect] SCO weekly chunk complete', {
          chunk: i + 1, of: weekChunks.length,
          fetched: weekRows.length, reportedTotal: weekTotal, added,
        });
        continue;
      }

      // ── Chunk bị truncate → thử daily sub-splits ────────────────────────
      logger.warn('[GdtDirect] SCO chunk truncated (GDT confirms) — retrying with daily', {
        endpoint, weekChunk: i + 1,
        fetched: weekRows.length, reportedTotal: weekTotal,
        missing: weekTotal - weekRows.length,
        from: formatGdtDate(from), to: formatGdtDate(to),
      });

      const dayChunks = splitIntoDays(from, to);
      let dailyTotal  = 0;

      for (let d = 0; d < dayChunks.length; d++) {
        if (d > 0) await humanDelay(1_200, 2_500);
        const { from: df, to: dt } = dayChunks[d]!;

        try {
          const { rows: dayRows, reportedTotal: dayTotal } =
            await this._fetchAllPagesBuffered(endpoint, df, dt, undefined, scoPath);

          const isDayTruncated = dayTotal > 0 && dayRows.length < dayTotal;

          if (!isDayTruncated) {
            // Ngày này đầy đủ
            const added = _deduplicateAndAdd(dayRows);
            dailyTotal += dayRows.length;
            logger.debug('[GdtDirect] SCO day chunk complete', {
              day: d + 1, of: dayChunks.length,
              fetched: dayRows.length, reportedTotal: dayTotal, added,
              date: formatGdtDate(df).slice(0, 10),
            });
          } else {
            // ── Day cũng bị truncate → 2-hour sub-sub-splits ──────────────
            // Xảy ra khi 1 ngày có > 50 HĐ (pageSize) và GDT 500 trên page>0
            // Chia 24h thành 12 windows 2h → mỗi window ≤ ~5 HĐ/2h
            logger.warn('[GdtDirect] SCO day chunk truncated — retrying with 2h windows', {
              day: d + 1, fetched: dayRows.length, reportedTotal: dayTotal,
              date: formatGdtDate(df).slice(0, 10),
            });

            const hourChunks = splitIntoHours(df, dt, 2); // 2-hour windows
            for (let h = 0; h < hourChunks.length; h++) {
              if (h > 0) await humanDelay(600, 1_500);
              const { from: hf, to: ht } = hourChunks[h]!;
              try {
                const { rows: hourRows, reportedTotal: hourTotal } =
                  await this._fetchAllPagesBuffered(endpoint, hf, ht, undefined, scoPath);
                _deduplicateAndAdd(hourRows);
                dailyTotal += hourRows.length;

                // Log warning nếu 2h window còn truncated (cực hiếm: >50 HĐ/2h)
                if (hourTotal > 0 && hourRows.length < hourTotal) {
                  logger.error('[GdtDirect] SCO 2h window STILL truncated — data loss possible', {
                    window: `${h+1}/${hourChunks.length}`,
                    fetched: hourRows.length, reportedTotal: hourTotal,
                    from: formatGdtDate(hf), to: formatGdtDate(ht),
                    hint: 'Company has >50 invoices per 2-hour window. Contact admin.',
                  });
                }
              } catch (hourErr) {
                logger.warn('[GdtDirect] SCO 2h window failed (non-fatal)', {
                  window: h + 1, err: hourErr instanceof Error ? hourErr.message : String(hourErr),
                });
              }
            }
          }
        } catch (dayErr) {
          logger.warn('[GdtDirect] SCO day chunk failed (non-fatal)', {
            day: d + 1, date: formatGdtDate(df).slice(0, 10),
            err: dayErr instanceof Error ? dayErr.message : String(dayErr),
          });
        }
      }

      logger.info('[GdtDirect] SCO daily recovery complete', {
        endpoint, weekChunk: i + 1,
        weekReportedTotal: weekTotal, dailyFetched: dailyTotal,
        uniqueSoFar: seen.size,
      });

    } catch (err) {
      logger.warn('[GdtDirect] SCO weekly chunk failed (non-fatal)', {
        chunk: i + 1, of: weekChunks.length,
        from: formatGdtDate(from), to: formatGdtDate(to),
        err: err instanceof Error ? err.message : String(err),
      });
      // fast-fail nếu chunk đầu không có gì (company không có SCO)
      if (seen.size === 0 && i === 0) {
        logger.info('[GdtDirect] SCO fast-fail: first chunk failed with 0 results', { endpoint });
        break;
      }
    }
  }

  const result = Array.from(seen.values());
  logger.info('[GdtDirect] SCO fetch complete', {
    endpoint, total: result.length, probeTotal: probeCount,
    complete: result.length >= probeCount,
    discrepancy: probeCount - result.length,
  });
  return result;
}
```

---

## FIX 3: Thêm hàm `splitIntoHours` (đặt sau `splitIntoDays`)

```typescript
/**
 * Split một day window thành N-hour sub-windows.
 * Dùng khi daily chunk bị truncate (> pageSize HĐ trong 1 ngày).
 * hoursPerChunk=2 → 12 windows/ngày → mỗi window ~2-5 HĐ cho hầu hết công ty.
 *
 * TIMEZONE NOTE: Dùng getHours() — theo local time của process.
 * VPS phải chạy với TZ=Asia/Ho_Chi_Minh để khớp với GDT Vietnam timezone.
 */
function splitIntoHours(
  from:          Date,
  to:            Date,
  hoursPerChunk: number = 2,
): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cur = new Date(from);
  cur.setMinutes(0, 0, 0);

  const end = new Date(to);
  end.setMinutes(59, 59, 999);

  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setHours(chunkEnd.getHours() + hoursPerChunk - 1);
    chunkEnd.setMinutes(59, 59, 999);

    const actualEnd = chunkEnd < end ? chunkEnd : new Date(end);
    chunks.push({ from: new Date(cur), to: actualEnd });

    const next = new Date(cur);
    next.setHours(next.getHours() + hoursPerChunk);
    next.setMinutes(0, 0, 0);
    cur = next;
  }
  return chunks;
}
```

---

## FIX 4: Fix `GdtRawCacheService.upsertPage` — SQL type bug `parameter $3`

**File:** `src/crawl-cache/GdtRawCacheService.ts`

Lỗi: `"inconsistent types deduced for parameter $3"` — PostgreSQL không thể infer type
của `page` parameter khi nó xuất hiện trong cả INSERT và ON CONFLICT...WHERE clause.

**Fix:** Cast `$3` thành `INT` tường minh trong SQL:

```typescript
// Trong method upsertPage(), tìm và thay đổi câu SQL INSERT:

// CŨ (gây lỗi):
const res = await pool.query(
  `INSERT INTO gdt_raw_cache (company_id, endpoint, page, period, content_hash, raw_json, fetched_at)
   VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
   ON CONFLICT (company_id, endpoint, page, period) DO UPDATE
     SET content_hash = EXCLUDED.content_hash,
         raw_json     = EXCLUDED.raw_json,
         fetched_at   = EXCLUDED.fetched_at
   RETURNING (gdt_raw_cache.content_hash IS DISTINCT FROM $5) AS changed`,
  [params.companyId, params.endpoint, params.page, params.period, hash, json],
);

// MỚI (fix type casting):
const res = await pool.query(
  `INSERT INTO gdt_raw_cache (company_id, endpoint, page, period, content_hash, raw_json, fetched_at)
   VALUES ($1::uuid, $2::text, $3::int, $4::text, $5::text, $6::jsonb, NOW())
   ON CONFLICT (company_id, endpoint, page, period) DO UPDATE
     SET content_hash = EXCLUDED.content_hash,
         raw_json     = EXCLUDED.raw_json,
         fetched_at   = EXCLUDED.fetched_at
   RETURNING (gdt_raw_cache.content_hash IS DISTINCT FROM EXCLUDED.content_hash) AS changed`,
  [params.companyId, params.endpoint, params.page, params.period, hash, json],
);

// Lưu ý: RETURNING thay đổi từ "IS DISTINCT FROM $5" → "IS DISTINCT FROM EXCLUDED.content_hash"
// để tránh type inference conflict khi $5 xuất hiện nhiều lần
```

---

## FIX 5: Đảm bảo VPS chạy đúng timezone

**File:** `ecosystem.config.js` — thêm `TZ` env cho tất cả processes:

```javascript
// Thêm TZ vào env của mọi app trong ecosystem.config.js:
env: {
  NODE_ENV:     'production',
  TZ:           'Asia/Ho_Chi_Minh',   // ← THÊM DÒNG NÀY
  REDIS_URL:    process.env.REDIS_URL,
  DATABASE_URL: process.env.DATABASE_URL,
},
```

**Lý do:** `splitIntoHours` và `splitIntoDays` dùng `setHours(0,0,0,0)` theo local time.
Nếu server chạy UTC (không set TZ), "ngày" bắt đầu lúc 17:00 VN (UTC midnight),
gây miss HĐ từ 00:00–17:00 VN trong daily windows.
Với `TZ=Asia/Ho_Chi_Minh`, `setHours(0,0,0,0)` = Vietnam midnight → đúng với GDT.

---

## FIX 6: Update callers của `_fetchAllPagesBuffered` — destructure `rows`

**Tìm tất cả nơi gọi `_fetchAllPagesBuffered` trong file** ngoài `_fetchScoByWeeks`:

```typescript
// Tìm pattern: const xxx = await this._fetchAllPagesBuffered(...)
// Thay bằng destructure:
const { rows: xxx } = await this._fetchAllPagesBuffered(...);

// Ví dụ cụ thể — tìm và thay trong _fetchRangeByMonth:
// CŨ:
const q5 = await this._fetchRangeByMonth('purchase', fromDate, toDate, 'ttxly==5');
const q6 = await this._fetchRangeByMonth('purchase', fromDate, toDate, 'ttxly==6');
// (nếu _fetchRangeByMonth gọi _fetchAllPagesBuffered bên trong, cũng cần update)

// Nếu _fetchRangeByMonth trả về RawInvoice[], thêm unwrap bên trong nó:
// const { rows } = await this._fetchAllPagesBuffered(...);
// return rows;
// Để giữ backward compat: _fetchRangeByMonth vẫn trả RawInvoice[] nhưng dùng rows bên trong
```

**Pattern chính xác để update** — tìm trong file và thay:

```typescript
// TRƯỚC:
const result = await this._fetchAllPagesBuffered(endpoint, from, to, filter, path);
// result là RawInvoice[]

// SAU:
const { rows: result } = await this._fetchAllPagesBuffered(endpoint, from, to, filter, path);
// result vẫn là RawInvoice[], reportedTotal bị bỏ qua (chỉ cần trong _fetchScoByWeeks)
```

---

## Tóm tắt: Tại sao fix này đúng và đủ

```
VẤN ĐỀ CŨ:                          FIX MỚI:
result % pageSize === 0              fetched < GDT_reportedTotal
→ False positive (350%50=0)          → Chỉ trigger khi GDT xác nhận thiếu
→ Trigger khi không cần thiết        → Không bao giờ false positive
→ Daily replace weekly sai           → Weekly kept nếu đầy đủ
→ Timezone risk từ daily splits      → Daily chỉ dùng khi CẦN THIẾT
→ Daily cũng truncated, không xử lý → Daily check lại, xuống 2h nếu cần
→ Duplicates từ boundary overlap     → In-memory dedup Map trước khi return

TIMEZONE:
Cũ: split arbitrary → boundary invoices bị đếm 2 lần
Mới: reportedTotal là ground truth → biết chắc thiếu hay đủ
     In-memory dedup Map → loại bỏ mọi duplicate trước khi return
     TZ=Asia/Ho_Chi_Minh → setHours(0,0,0,0) = Vietnam midnight
```

---

## Deployment

```bash
# 1. Update TZ trong ecosystem.config.js
# 2. Build
npm run build

# 3. Reload sync worker
pm2 reload invone-sync-worker

# 4. Test với tháng 2/2026:
# Expected logs:
#   SCO probe OK probeTotal: 608
#   SCO weekly chunk complete: fetched=350, reportedTotal=350 (chunk2, NOT truncated)
#   SCO weekly chunk complete: fetched=0 (chunk4)
#   SCO chunk truncated (GDT confirms): fetched=50, reportedTotal=150 (chunk có 500 bug)
#     → daily sub-splits...
#   SCO fetch complete: total=608, probeTotal=608, complete=true, discrepancy=0
#
# outputCount trong log Done nên = 608 (hoặc rất gần)

# 5. Monitor GdtRawCache — không còn "inconsistent types" error
pm2 logs invone-sync-worker --lines 200 | grep -E "SCO|RawCache|truncat"
```