```
## PROJECT CONTEXT
HĐĐT SaaS platform — Vietnamese e-invoice management system.
Stack: Next.js 14, Node.js, PostgreSQL (local, no Docker), Redis + BullMQ,
       Playwright, 2Captcha, Axios, Google Gemini.
Data source: hoadondientu.gdt.gov.vn:30000 REST API (GDT — Vietnamese Tax Authority).
Files to modify:
  - gdt-direct-api.service.ts   (GdtDirectApiService: Axios, FIQL, pagination)
  - sync_worker.ts              (processGdtSync, BullMQ workers, upsert loop)
  - proxy-tunnel.ts             (HTTP CONNECT + SOCKS5 tunnel agents)
  - crawler_recipes table       (PostgreSQL JSONB — Crawler-as-Interpreter config)

All responses and comments in Vietnamese.
All variable names, function names, type names in English.

---

## PHASE 1 — CRITICAL BUG FIXES (implement in this exact order)

### BUG-1 — Missing paramsSerializer causes immediate WAF TCP-reset [HIGHEST PRIORITY]

Evidence from production log:
  06:20:59 WARN [GdtDirect] Retrying after error {"url":"/query/invoices/sold","attempt":0,"status":0}
  06:21:18 ERROR [SyncWorker] Job failed {"error":"stream has been aborted"}
  Pattern: status:0 within 1 second = GDT WAF TCP RST on encoded FIQL characters.

Root cause: Axios default URLSearchParams encodes FIQL string
  tdlap=ge=01/03/2026T00:00:00;tdlap=le=31/03/2026T23:59:59
  → tdlap%3Dge%3D01%2F03%2F2026T00%3A00%3A00%3Btdlap%3Dle...
  GDT WAF treats %3D/%3B as injection → immediate TCP RST, no HTTP response.

Fix: In GdtDirectApiService constructor, add paramsSerializer to BOTH
     this.http AND this.binaryHttp axios.create() calls:

paramsSerializer: (params: Record<string, unknown>) =>
  Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${v}`)
    .join('&')

Rule: encode KEY only (prevent key collisions).
      do NOT encode VALUE (FIQL requires raw =, ;, / characters).
      sort parameter tdlap:desc must remain raw (colon unencoded).

### BUG-2 — Stale socket reuse after login

Fix: In login() method, add to the POST /security-taxpayer/authenticate call:
  headers: { 'Connection': 'close' }
Forces a fresh TCP socket for the first API call after login.
Prevents "stream has been aborted" from reusing a server-half-closed socket.

---

## PHASE 2 — RELIABILITY FIXES FOR LARGE VOLUME (100k+ invoices/month)

Context: A company with 100k invoices/month = 2000 pages to fetch.
         At avg 4.5s/page = 2.5 hours fetch time.
         GDT JWT expires in ~30–45 minutes → job always fails mid-run without these fixes.

### FIX-1 — Mid-run token refresh

Problem: token obtained once at login, no refresh mechanism.
         At page 600/2000 token expires → throw → _failRun() → consecutive_failures++
         → auto-block after 3 failures → company locked for 2 hours.

Implementation in GdtDirectApiService:
  - Add private fields: _loginUsername: string | null, _loginPassword: string | null
  - Add private field: _reloginAttempted = false
  - In login(): store username/password to private fields, reset _reloginAttempted = false
  - In _getWithRetry(): when status === 401 AND _reloginAttempted === false:
      set _reloginAttempted = true
      await this.login(this._loginUsername!, this._loginPassword!)
      decrement attempt (attempt--) so this does not count as a retry
      continue retry loop with fresh token
  - If status === 401 AND _reloginAttempted === true: throw immediately

### FIX-2 — Pagination checkpoint via Redis

Problem: any network failure at page 1500/2000 loses all progress.
         Next retry restarts from page 0.

Implementation in GdtDirectApiService:
  - Add companyId: string as constructor parameter (needed for checkpoint key)
  - Checkpoint key format: gdt:ckpt:{companyId}:{endpoint}:{fromYYYYMM}
    example: gdt:ckpt:uuid-123:sold:202603
  - At START of _fetchAllPages():
      read checkpoint key from Redis
      if found: set page = savedPage, skip already-fetched invoices count
      log: '[GdtDirect] Resuming from checkpoint page {page}'
  - AFTER each successful page append to all[]:
      write { page, fetched: all.length } to checkpoint key, TTL = 86400s
      wrap in try/catch — checkpoint failure must never abort sync
  - On _fetchAllPages() SUCCESS: delete checkpoint key

### FIX-3 — Bot lock heartbeat

Problem: BOT_LOCK_TTL = 45 minutes.
         100k invoice job runs 2–30 hours → lock expires → second job acquires lock
         → two workers upsert same company simultaneously → DB race condition.

Implementation in processGdtSync():
  - Immediately after acquireCompanyLock() returns true:
    const lockHeartbeat = setInterval(
      () => _lockRedis.expire(`${BOT_LOCK_PREFIX}${companyId}`, BOT_LOCK_TTL).catch(() => {}),
      10 * 60_000
    )
  - In the OUTER finally block (after try containing all sync logic):
    clearInterval(lockHeartbeat)   // BEFORE releaseCompanyLock()
    await releaseCompanyLock(companyId)

### FIX-4 — Remove pointless jitter from DB upsert loop

Problem: jitteredDelay() (3.5–6.5s) and readPause() (10–30s) fire on every
         10th and 32nd invoice respectively during the DB upsert loop.
         For 100k invoices: 10,000 jitters × 5s = 13.9 hours + 3,125 pauses × 20s = 17 hours.
         These delays were designed for GDT API calls, NOT for local DB writes.

Fix in both outputInvoices and inputInvoices for-loops:
  - ONLY call jitteredDelay() AFTER _maybeInsertLineItems() when it returns > 0
    (meaning an actual XML fetch to GDT occurred)
  - REMOVE shouldReadPause() and readPause() entirely from upsert loop
  - Do NOT touch humanDelay between pages inside _fetchAllPages (anti-bot, keep it)
  - Do NOT touch humanDelay between months in fetchOutputInvoices/fetchInputInvoices (keep it)

### FIX-5 — Batch upsert instead of sequential

Problem: 100k invoices × 1 DB round-trip each = severe bottleneck.
         Current: each invoice = 1 INSERT ... ON CONFLICT DO UPDATE.
         Current: each invoice = 1 Redis EXISTS call (sequential).

Implementation:
  a) Batch DB upsert:
     Create _upsertInvoiceBatch(invoices: RawInvoice[], companyId: string, direction: string)
     Use single INSERT ... VALUES ($1,$2,...),($3,$4,...) ON CONFLICT (company_id, invoice_number,
     serial_number, direction) DO UPDATE SET ...
     Batch size = 200 invoices per query
     Return array of inserted invoice IDs for line-item fetching

  b) Batch Redis dedup:
     Before each batch, use Redis pipeline to check all keys at once:
       const pipeline = redis.pipeline()
       batch.forEach(inv => pipeline.sismember(`dedup:${companyId}:${yyyymm}:${direction}`,
         dedup.invoiceKey(inv.invoice_number ?? '', inv.serial_number ?? '')))
       const results = await pipeline.exec()
       const newOnly = batch.filter((_, i) => results[i]![1] === 0)
     Then upsert only newOnly

  c) Replace both for-loops in processGdtSync() with:
     for (let i = 0; i < invoices.length; i += 200) {
       const batch = invoices.slice(i, i + 200)
       await _upsertInvoiceBatch(batch, companyId, direction)
       await job.updateProgress({ ... })
     }

### FIX-6 — Auto-split into weekly chunks for large volumes

Problem: _fetchAllPages handles an entire month even for 100k+ invoices.
         This is too large for a single reliable job run.

Implementation:
  a) Add splitIntoWeeks(from: Date, to: Date): Array<{from: Date; to: Date}>
     Each chunk = 7 calendar days (not week boundaries, just rolling 7-day windows)
     Similar structure to existing splitIntoMonths()

  b) In processGdtSync(), before calling fetchOutputInvoices():
     const lastTotal = (cfg.last_run_output_count ?? 0) + (cfg.last_run_input_count ?? 0)
     const useWeeklyChunks = lastTotal > 10_000
     if (useWeeklyChunks) {
       // pass weekly chunks instead of full month range
       // GdtDirectApiService already handles chunking via _fetchWithChunks()
       // just pass splitIntoWeeks result as chunks parameter
     }

---

## PHASE 3 — LARGE-VOLUME WARNING + TIME ESTIMATE (new feature)

Purpose: detect large invoice volumes BEFORE running full fetch,
         warn user with time estimate, suggest daily/weekly sync splits.

### Step 1 — Pre-flight count via X-Total-Count header

Add to GdtDirectApiService:
  async prefetchCount(endpoint: 'sold' | 'purchase', from: Date, to: Date): Promise<number>
  - Call _getWithRetry with params: { sort:'tdlap:desc', size:1, page:0, search:fiqlString }
  - Read X-Total-Count response header → parseInt → return number
  - On any error: return -1 (unknown, proceed without warning)

### Step 2 — Estimate sync duration

Add pure function estimateSyncDurationMs(outputCount: number, inputCount: number): number
  const total    = outputCount + inputCount
  const pages    = Math.ceil(total / 50)
  const fetchMs  = pages * 4_500          // avg 4.5s per page (HTTP + jitter)
  const upsertMs = total * 50             // ~50ms per invoice with batch upsert
  const xmlMs    = Math.min(total, MAX_XML_FETCHES_PER_RUN) * 3_500
  return fetchMs + upsertMs + xmlMs

### Step 3 — Emit warning via job.updateProgress() BEFORE heavy fetch begins

In processGdtSync(), after login and BEFORE fetchOutputInvoices():
  const outputEst = await runner.prefetchCount('sold', fromDate, toDate)
  const inputEst  = await runner.prefetchCount('purchase', fromDate, toDate)
  const totalEst  = (outputEst >= 0 ? outputEst : 0) + (inputEst >= 0 ? inputEst : 0)

  if (totalEst > 0) {
    const estimatedMs  = estimateSyncDurationMs(outputEst, inputEst)
    const estimatedMin = Math.ceil(estimatedMs / 60_000)

    logger.warn('[SyncWorker] Large volume detected', {
      companyId, estimatedOutput: outputEst, estimatedInput: inputEst,
      estimatedMinutes: estimatedMin,
      recommendation: totalEst > 10_000 ? 'Use weekly chunks' : 'Normal sync',
    })

    if (estimatedMs > 5 * 60_000) {
      const suggestion = totalEst > 50_000
        ? 'Khuyến nghị: Chọn "Lấy từng ngày" để giảm thời gian chờ xuống dưới 5 phút/lần.'
        : 'Quá trình này có thể mất vài phút. Hệ thống sẽ tự cập nhật tiến độ.'

      await job.updateProgress({
        percent: 3,
        statusMessage: `⚠️ Phát hiện ~${totalEst.toLocaleString('vi-VN')} hóa đơn. Ước tính ${estimatedMin} phút.`,
        warning: 'large_volume',
        estimatedMinutes: estimatedMin,
        estimatedOutput:  outputEst,
        estimatedInput:   inputEst,
        suggestion,
      } as Record<string, unknown>)
    }

    // Auto-switch to weekly chunks if very large AND auto job
    if (totalEst > 50_000 && !isManual) {
      logger.info('[SyncWorker] Auto-switching to weekly chunk strategy', { companyId, totalEst })
      // useWeeklyChunks = true (consumed by FIX-6 logic above)
    }
  }

---

## PHASE 4 — ANTI-DETECTION HARDENING

### Rule set — enforce throughout GdtDirectApiService

1. paramsSerializer: raw FIQL values, encoded keys only (already in BUG-1)

2. Request header fingerprint must match real Chrome on Windows:
   Required headers on EVERY request (add to commonHeaders):
     'Accept':           'application/json, text/plain, */*'
     'Accept-Language':  'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
     'Accept-Encoding':  'gzip, deflate, br'
     'Cache-Control':    'no-cache'
     'sec-ch-ua':        '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"'
     'sec-ch-ua-mobile': '?0'
     'sec-fetch-site':   'same-origin'
     'sec-fetch-mode':   'cors'
     'sec-fetch-dest':   'empty'
     'Origin':           'https://hoadondientu.gdt.gov.vn'
     'Referer':          'https://hoadondientu.gdt.gov.vn/'

3. User-Agent rotation:
   - Rotate per GdtDirectApiService instance (per BullMQ job)
   - Pool of 6+ realistic Chrome/Firefox/Edge UA strings on Windows/Mac
   - Never use same UA twice in a row for the same companyId

4. Timing rules (DO NOT CHANGE these values):
   - Login → first fetch: thinkTime 3–15s (isManual: 0.5–2s)
   - Between pages: humanDelay 800–2500ms
   - Between months: humanDelay 4000–8000ms
   - After XML fetch: humanDelay 2500–4500ms
   - Never fixed delays — always randomized within range

5. CAPTCHA strategy:
   - Start 2Captcha solve DURING thinkTime warmup delay (parallel, not sequential)
   - If wrong captcha: wait 2–5s before retry (never immediate retry)
   - If wrong captcha 3 times: rotate proxy session before next attempt
   - Log captcha solve time for monitoring (slow solve = 2Captcha degraded)

---

## PHASE 5 — JOB CONFLICT RESOLUTION (manual vs scheduled, no overlap)

### Problem
A company running both a scheduled auto-sync and a user-triggered manual sync
simultaneously causes: duplicate upserts, dedup cache misses, race conditions on DB.

### Implementation — Smart Enqueue with Mutual Exclusion

Add enqueueSync(companyId: string, type: 'manual' | 'auto', jobData: SyncJobData)
to sync_worker.ts. This replaces direct queue.add() calls everywhere.

Logic:
  1. Check Redis lock: if `bot:sync:lock:{companyId}` exists (job currently RUNNING):
     - if type === 'manual':
         set `bot:priority:{companyId}` = 'manual' with TTL 300s
         return { status: 'notified', message: 'Đang sync, sẽ ưu tiên trong vài giây' }
     - if type === 'auto':
         return { status: 'skipped', message: 'Job đang chạy, bỏ qua lần này' }

  2. Check pending key: if `bot:pending:{companyId}` exists (job WAITING in queue):
     - if type === 'manual':
         get existing jobId from pending key
         move job to manualQueue with higher priority (use BullMQ changePriority)
         return { status: 'promoted', message: 'Đã ưu tiên lên đầu hàng' }
     - if type === 'auto':
         return { status: 'deduplicated', message: 'Job đã trong hàng chờ' }

  3. No conflict: enqueue normally
     set `bot:pending:{companyId}` = jobId with TTL 3600s
     return { status: 'enqueued', jobId }

### Priority yield — running auto-job yields to incoming manual

In processGdtSync(), at the START of each page loop iteration in _fetchAllPages():
  const priorityOverride = await _lockRedis.get(`bot:priority:${companyId}`)
  if (priorityOverride === 'manual' && currentJobType === 'auto') {
    await saveCheckpoint(companyId, endpoint, page, all.length)
    await _lockRedis.del(`bot:priority:${companyId}`)
    throw new Error('YIELD_TO_MANUAL: Auto job yielding — checkpoint saved at page ' + page)
  }
Note: YIELD_TO_MANUAL error must NOT increment consecutive_failures.
Add 'YIELD_TO_MANUAL' to the isSkip check alongside COOLDOWN_SKIP and CANCEL_SKIP.

### Clean up pending key on job completion and failure

In worker completed event AND failed event:
  await _lockRedis.del(`bot:pending:${companyId}`)

---

## PHASE 6 — MANUAL SYNC ABUSE PREVENTION (flexible, not hard-locked)

### Token Bucket Rate Limiter per User (not per company)

Add checkManualRateLimit(userId: string, plan: string): Promise<RateLimitResult>
to sync_worker.ts.

Rate limit config:
  free:       { tokensPerHour: 3,  burstMax: 3  }
  pro:        { tokensPerHour: 10, burstMax: 5  }
  enterprise: { tokensPerHour: 30, burstMax: 10 }

Redis key: ratelimit:manual:{userId}
Value: JSON { tokens: number, lastRefill: number, plan: string }
TTL: 86400s

Algorithm (token bucket with continuous refill):
  1. Read current state from Redis (default: full burst on first call)
  2. Calculate elapsed hours since lastRefill
  3. Add floor(elapsedHours × tokensPerHour) tokens, cap at burstMax
  4. Update lastRefill = now
  5. If tokens <= 0:
       calculate nextRefillMs = (1 / tokensPerHour) × 3_600_000
       return { allowed: false, retryAfterMs: nextRefillMs,
                message: `Bạn đã sync quá nhiều lần. Thử lại sau ${ceil(retryAfterMs/60000)} phút.`,
                suggestion: 'Hệ thống tự động sync mỗi 5–6 giờ. Bạn có thể chờ đợt sync tiếp theo.' }
  6. Decrement tokens, save state
  7. Return { allowed: true, tokensRemaining: tokens }

Admin override (for legitimate bulk imports or first-time setup):
  Redis key: ratelimit:override:{userId}
  If this key exists: skip rate limit check entirely
  Set by admin API: await redis.set(`ratelimit:override:${userId}`, '1', 'EX', 3600)

Apply checkManualRateLimit() at the TOP of enqueueSync() for type === 'manual',
BEFORE lock checks. Return 429-equivalent response if not allowed.

---

## PHASE 7 — GDT STRUCTURAL CHANGE RESILIENCE

### Crawler-as-Interpreter — recipe versioning

The crawler_recipes PostgreSQL table (JSONB) already exists.
Ensure GdtDirectApiService reads recipe from DB at job start, not at service init.
This means: recipe changes take effect on next job run without code deployment.

Add recipe dry-run mode:
  - Add method GdtDirectApiService.dryRun(companyId, recipe): Promise<DryRunResult>
  - Fetches first page only (size=1) using the candidate recipe
  - Returns { success, sampleInvoice, fieldsMapped, fieldsMissing, error }
  - Used by admin UI before activating a new recipe version

Add recipe version audit:
  - On every job start, log: { companyId, recipeId, recipeVersion }
  - If job fails with field mapping error (invoice_number null for > 50% of batch):
      emit GdtStructuralError with recipe version info
      Circuit breaker counts this toward trip threshold

### Canary health check (add as separate BullMQ job, runs every 15 minutes)

Add 'gdt-health-check' queue and worker:
  - Uses a dedicated test company account (configured in env: GDT_CANARY_COMPANY_ID)
  - Runs prefetchCount() only (no full fetch, no DB write)
  - If count === -1 (error): increment Redis key gdt:health:failures, TTL 3600s
  - If failures >= 5 in 1 hour: emit admin alert via sync-notifications queue
  - If count === 0 when last known count > 0: possible GDT structural change, alert admin
  - Reset failure counter on successful check

---

## PHASE 8 — PROGRESSIVE STREAMING TO FRONTEND

Purpose: user sees invoices appearing incrementally instead of waiting for full sync.

### Convert _fetchAllPages to async generator

Rename current _fetchAllPages to _fetchAllPagesBuffered (keep for compatibility).
Add new method:
  private async *_streamPages(
    endpoint: string, fromDate: Date, toDate: Date,
    extraFilter?: string, overridePath?: string
  ): AsyncGenerator<RawInvoice[]>

Same logic as _fetchAllPages but:
  yield batch after each page append
  instead of accumulating all and returning at end

Add to public API:
  async *fetchOutputInvoicesStream(from: Date, to: Date): AsyncGenerator<RawInvoice[]>
  async *fetchInputInvoicesStream(from: Date, to: Date):  AsyncGenerator<RawInvoice[]>

### Update processGdtSync to use streaming

Replace:
  const outputInvoices = await runner.fetchOutputInvoices(fromDate, toDate)
  for (let i = 0; i < outputInvoices.length; i++) { ... }

With:
  for await (const batch of runner.fetchOutputInvoicesStream(fromDate, toDate)) {
    const newBatch = await filterNewInvoices(batch, companyId, 'output', yyyymm)
    await _upsertInvoiceBatch(newBatch, companyId, 'output')
    outputCount += newBatch.length
    await job.updateProgress({
      percent: calculateProgress(outputCount, inputCount, outputEst, inputEst),
      invoicesFetched: outputCount + inputCount,
      statusMessage: `Đang tải HĐ đầu ra: ${outputCount.toLocaleString('vi-VN')} hóa đơn...`,
      batchSize: newBatch.length,
    } as Record<string, unknown>)
  }

### SSE endpoint in Next.js API route

Create /app/api/sync/progress/[companyId]/route.ts:
  - GET handler with headers: Content-Type: text/event-stream, Cache-Control: no-cache
  - Subscribe to BullMQ job progress events via Redis pub/sub
  - Forward progress events as SSE: data: {percent, invoicesFetched, statusMessage}\n\n
  - Send heartbeat every 15s to keep connection alive
  - Close stream when job completes or fails

---

## MANDATORY CONSTRAINTS (apply to ALL phases)

1. TypeScript strict mode throughout — no `any`, use `unknown` with type guards
2. All Redis operations in try/catch — cache failures are non-fatal, never block sync
3. All phases backward compatible — behavior unchanged for < 10k invoice companies
4. Preserve ALL existing anti-detection: humanDelay between pages, UA rotation,
   CAPTCHA jitter, proxy sticky sessions
5. Never change interfaces: RawInvoice, SyncJobData, GdtInvoiceRaw, CrawlerRecipe
6. Non-fatal operations (quota, metrics, notifications, checkpoint write) must use
   .catch(() => {}) or try/catch and never throw into the main sync flow
7. YIELD_TO_MANUAL, COOLDOWN_SKIP, CANCEL_SKIP must NOT increment consecutive_failures
8. All log messages in Vietnamese for operational clarity

---

## IMPLEMENTATION ORDER (strict — each phase unblocks the next)

Phase 1:  BUG-1 paramsSerializer          ← UNBLOCKS ALL FETCHES
Phase 1:  BUG-2 Connection: close
Phase 2:  FIX-3 Lock heartbeat            ← PREVENT RACE CONDITIONS FIRST
Phase 2:  FIX-1 Mid-run token refresh     ← THEN ENABLE LONG RUNS
Phase 2:  FIX-2 Pagination checkpoint     ← THEN MAKE LONG RUNS RESUMABLE
Phase 2:  FIX-4 Remove upsert jitter      ← UNBLOCKS TIMING ESTIMATES
Phase 2:  FIX-5 Batch upsert             ← REQUIRED BEFORE STREAMING
Phase 2:  FIX-6 Weekly chunks
Phase 3:  Large-volume warning + estimate
Phase 4:  Anti-detection hardening
Phase 5:  Job conflict resolution
Phase 6:  Rate limit abuse prevention
Phase 7:  Recipe versioning + canary
Phase 8:  Progressive streaming (implement last — depends on all above)
```