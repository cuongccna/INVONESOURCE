# Kế hoạch Đồng bộ Dữ liệu — MISA · Viettel · BKAV
> Tài liệu kỹ thuật đầy đủ: điều kiện · trở ngại · giải pháp · prompts cho Copilot

---

## PHẦN 1 — TỔNG QUAN & THỰC TRẠNG API

### 1.1 MISA meInvoice

| Hạng mục | Thông tin |
|----------|-----------|
| Môi trường Test | `https://testapi.meinvoice.vn` |
| Môi trường Production | `https://api.meinvoice.vn` |
| Auth method | `appid` (MISA cấp) + `taxcode` + `username` + `password` → JWT |
| Token TTL | ~24h (production), ngắn hơn test |
| Tài liệu | `https://doc.meinvoice.vn` |
| Loại API | **Private API** — không public, mỗi khách hàng nhận `appid` riêng |

**Lưu ý quan trọng từ research:**
- MISA **KHÔNG cấp public API key** — mỗi doanh nghiệp phải đăng ký tài khoản meInvoice và nhận `appid` riêng
- API đầu vào (purchase invoice) là **dịch vụ riêng, trả phí thêm**
- Có sandbox mode để test trước khi production

---

### 1.2 Viettel SInvoice

| Hạng mục | Thông tin |
|----------|-----------|
| Môi trường Test | `https://demo-sinvoice.viettel.vn:8443/InvoiceAPI` |
| Môi trường Production | `https://sinvoice.viettel.vn:8443/InvoiceAPI` |
| Auth method | HTTP Basic Auth (username:password → Base64 encode) |
| Demo account | user: `0100109106-215` / pass: `111111a@A` |
| **IP Whitelist** | **BẮT BUỘC** — phải đăng ký IP server trước khi gọi API |
| Datetime format | **Milliseconds** (UNIX timestamp) — KHÔNG phải ISO string |
| Timeout | 90 giây mỗi request |
| Response format | Base64 encoded → cần decode trước khi parse JSON |

**Lưu ý quan trọng từ research:**
- Lỗi `500 Request Fail` xảy ra khi **sai pass HOẶC IP chưa được whitelist** — không phân biệt, rất khó debug
- Viettel có cả API đầu vào (mua vào): `getListInvoiceDataControl`
- Cần đăng ký IP tại: Enterprise management → User management → Update IP

---

### 1.3 BKAV eInvoice

| Hạng mục | Thông tin |
|----------|-----------|
| Auth method | Headers: `PartnerGUID` + `PartnerToken` (stateless) |
| Lấy credentials | Từ tài khoản doanh nghiệp trên portal BKAV |
| GDT validation | Built-in — BKAV tự validate với GDT |
| Tài liệu | Liên hệ BKAV sales để nhận PDF |

---

## PHẦN 2 — ĐIỀU KIỆN TIÊN QUYẾT (Prerequisites Checklist)

### ✅ Checklist trước khi code — Phải có đủ mới build được

#### MISA Prerequisites
```
□ Tài khoản meInvoice đã đăng ký và kích hoạt
□ appid đã nhận từ MISA (liên hệ MISA để được cấp)
□ Đã test login thành công trên testapi.meinvoice.vn
□ Biết username + password của tài khoản meInvoice của từng DN
□ Xác nhận: doanh nghiệp có đăng ký dịch vụ "hóa đơn đầu vào" chưa?
  (nếu chưa: chỉ sync được HĐ đầu ra)
□ Chạy thử curl test để verify appid hoạt động:
  curl -X POST https://testapi.meinvoice.vn/api/integration/auth/token \
    -H "Content-Type: application/json" \
    -d '{"appid":"YOUR_APPID","taxcode":"MST","username":"user","password":"pass"}'
```

#### Viettel Prerequisites
```
□ Tài khoản SInvoice đã đăng ký
□ Username + Password tài khoản Viettel (format: MST-số hoặc username)
□ IP server production đã xác định (static IP)
□ Đã đăng ký IP whitelist tại sinvoice.viettel.vn → Enterprise management → User management
□ Test với demo account trước: 0100109106-215 / 111111a@A
□ Confirm: cổng 8443 không bị block bởi firewall của hosting
□ Verify Base64 encoding: btoa("username:password") — Test bằng curl:
  curl -X POST https://demo-sinvoice.viettel.vn:8443/InvoiceAPI/InvoiceUtilsWS/getListInvoiceDataControl \
    -H "Authorization: Basic BASE64_ENCODED" \
    -H "Content-Type: application/json" \
    -d '{"supplierTaxCode":"0100109106-215","fromDate":1700000000000,"toDate":1710000000000}'
```

#### BKAV Prerequisites
```
□ Tài khoản doanh nghiệp trên portal BKAV đã tạo
□ PartnerGUID đã lấy từ tài khoản BKAV
□ PartnerToken đã lấy từ tài khoản BKAV
□ Tài liệu API PDF đã nhận từ BKAV sales
□ Test healthcheck endpoint để verify credentials
```

#### Server/Infrastructure Prerequisites
```
□ Server có STATIC IP (bắt buộc cho Viettel whitelist)
□ PostgreSQL đã cài và chạy (local hoặc VPS)
□ Redis đã cài và chạy
□ Node.js >= 18.x đã cài
□ Cổng 8443 (Viettel), 443 (MISA, BKAV) không bị block
□ File .env đã điền đủ tất cả biến môi trường
```

---

## PHẦN 3 — DANH SÁCH TRỞ NGẠI & GIẢI PHÁP

### 🔴 Trở ngại 1: Viettel IP Whitelist — BLOCKING ISSUE

**Vấn đề:** Nếu server IP chưa được đăng ký, mọi request đều trả về `500 Request Fail` mà không nói lý do. Developer sẽ mất nhiều giờ debug mà không biết nguyên nhân.

**Giải pháp:**
```
1. Xác định IP server TRƯỚC khi bắt đầu code connector
2. Đăng ký IP tại sinvoice.viettel.vn → Quản lý doanh nghiệp → Quản lý người dùng
3. Nếu dùng cloud (VPS): dùng Elastic IP hoặc static IP từ provider
4. Nếu dev local: KHÔNG thể test production Viettel từ local
   → Dùng demo environment (demo-sinvoice.viettel.vn) để dev
   → Chỉ test production sau khi deploy lên server có IP đã whitelist
5. Thêm vào error handler: khi nhận 500, luôn log "Kiểm tra IP whitelist" kèm IP hiện tại
```

---

### 🔴 Trở ngại 2: MISA appid — Không thể tự lấy

**Vấn đề:** `appid` không có cách tự generate. Phải liên hệ MISA để được cấp. Mỗi ứng dụng tích hợp cần 1 `appid` riêng.

**Giải pháp:**
```
1. Liên hệ MISA: support@misa.com.vn hoặc hotline 1900 1518
2. Đăng ký tài khoản Partner/Developer trên portal MISA
3. Trong khi chờ appid: dùng testapi.meinvoice.vn với credential được cấp trong tài liệu test
4. Thiết kế connector để appid là config per-company (không hardcode)
   → Mỗi khách hàng dùng SaaS của bạn sẽ dùng appid của họ
   → HOẶC: bạn đàm phán với MISA để có 1 appid platform-level
```

---

### 🟡 Trở ngại 3: Viettel datetime milliseconds — Bug dễ gây ra

**Vấn đề:** Developer quen với ISO date string (`2025-03-01`). Viettel dùng UNIX milliseconds (`1740787200000`). Nếu truyền sai format, không có hóa đơn nào được trả về (không có error, chỉ empty array).

**Giải pháp:**
```typescript
// ĐÚNG
const toViettelMs = (d: Date): number => d.getTime()
const fromViettelMs = (ms: number): Date => new Date(ms)

// SAI — Viettel không hiểu
const wrongDate = "2025-03-01"

// Kiểm tra: log ra để verify trước khi gọi API
console.log("fromDate:", toViettelMs(new Date("2025-03-01")))
// Output: 1740787200000 — đây mới là đúng
```

---

### 🟡 Trở ngại 4: MISA API đầu vào là dịch vụ riêng

**Vấn đề:** Khách hàng dùng MISA có thể chưa đăng ký dịch vụ "xử lý hóa đơn đầu vào". Gọi API sẽ trả về 403 hoặc empty.

**Giải pháp:**
```
1. Khi setup connector MISA, thêm checkbox: "Có đăng ký dịch vụ HĐ đầu vào?"
2. Nếu không → chỉ sync HĐ đầu ra, hiển thị banner thông báo
3. Nếu API trả 403 → catch error, set input_invoice_available=false trong DB,
   hiện thông báo: "Dịch vụ HĐ đầu vào chưa được kích hoạt. Liên hệ MISA để đăng ký."
4. Vẫn sync được HĐ đầu ra bình thường
```

---

### 🟡 Trở ngại 5: Token expiry & Race conditions

**Vấn đề:** Nếu nhiều sync job chạy cùng lúc (multi-company), có thể xảy ra race condition khi refresh token — nhiều job cùng refresh, chỉ 1 token hợp lệ cuối cùng.

**Giải pháp:**
```typescript
// Dùng Redis distributed lock để tránh race condition
const tokenKey = `misa:token:${companyId}`
const lockKey = `misa:token:lock:${companyId}`

async function getValidToken(companyId: string): Promise<string> {
  // 1. Check cached token
  const cached = await redis.get(tokenKey)
  if (cached) return cached
  
  // 2. Acquire lock để chỉ 1 process refresh
  const lock = await redis.set(lockKey, '1', 'EX', 30, 'NX')
  if (!lock) {
    // Đang có process khác refresh, chờ 2s rồi thử lại
    await sleep(2000)
    return getValidToken(companyId)
  }
  
  // 3. Refresh token
  const newToken = await callMisaTokenAPI(companyId)
  await redis.set(tokenKey, newToken, 'EX', 3600) // cache 1h
  await redis.del(lockKey)
  return newToken
}
```

---

### 🟡 Trở ngại 6: XML parsing khác nhau giữa các nhà mạng

**Vấn đề:** MISA, Viettel, BKAV có schema XML khác nhau dù đều theo NĐ123/2020. Tên trường, cấu trúc, encoding đều có thể khác.

**Giải pháp:**
```
1. Luôn lưu raw_xml vào DB trước khi parse
2. Mỗi connector có parser riêng (không dùng chung parser)
3. Dùng try/catch cho từng field — nếu 1 field parse fail, không crash toàn bộ invoice
4. Tạo fixture files: lưu 3-5 invoice XML mẫu từ mỗi nhà mạng để test
5. Test với dữ liệu thật trước khi deploy
```

---

### 🟢 Trở ngại 7: Rate limiting (chưa rõ, cần monitor)

**Vấn đề:** Các nhà mạng không công bố rate limit chính thức. Khi sync nhiều công ty cùng lúc có thể bị throttle.

**Giải pháp:**
```
1. Implement retry với exponential backoff: 1s → 2s → 4s → 8s → give up
2. Mỗi nhà mạng giới hạn: max 1 request/giây (conservative)
3. BullMQ rate limiter: max 60 jobs/phút per provider
4. Monitor: log response time + status code để phát hiện throttling
5. Circuit breaker sẽ tự động dừng nếu nhiều lỗi liên tiếp
```

---

## PHẦN 4 — PROMPTS CHO COPILOT (Copy & Paste)

---

### SYNC-01: Cài đặt dependencies và cấu hình môi trường
```
[Respond in Vietnamese]
Install all required npm packages for the sync engine and configure the environment.

Run in /backend directory:
npm install axios@1.6 xml2js@0.6 xmlbuilder2@3.1 uuid@9 bull bullmq@5 ioredis@5 
npm install --save-dev @types/xml2js @types/uuid

Create /backend/src/config/env.ts that validates these env vars at startup:
  MISA_APP_ID           - provided by MISA per integration
  MISA_TEST_APP_ID      - for sandbox testing
  VIETTEL_DEMO_USER     - 0100109106-215
  VIETTEL_DEMO_PASS     - 111111a@A
  BKAV_PARTNER_GUID     - from BKAV account
  BKAV_PARTNER_TOKEN    - from BKAV account
  DATABASE_URL          - postgresql://localhost:5432/hddtdb
  REDIS_URL             - redis://localhost:6379
  ENCRYPTION_KEY        - 32+ character random string for AES-256
  NODE_ENV              - development | production

If any required var is missing: throw descriptive error listing exactly which vars are missing.
Add .env.example with all vars (empty values) and instructions.
```

---

### SYNC-02: MISA Connector — Authentication & Token Management
```
[Respond in Vietnamese]
Create /backend/src/connectors/MisaConnector.ts — complete implementation.

MISA API details (verified from docs):
  Sandbox:    https://testapi.meinvoice.vn
  Production: https://api.meinvoice.vn
  Auth endpoint: POST /api/integration/auth/token
  Request body: { appid, taxcode, username, password }
  Response: { Success: boolean, Data: "JWT_TOKEN_STRING", ErrorCode, Errors }
  
  Headers for all subsequent requests:
    Authorization: Bearer {token}
    CompanyTaxCode: {taxcode}
    Content-Type: application/json

Implement MisaConnector extending BaseConnector with:

1. authenticate(credentials: EncryptedCredentials): Promise<void>
   - Decrypt credentials (appid, taxcode, username, password)
   - POST to auth endpoint
   - If Success=true: cache token in Redis with key "misa:token:{companyId}", TTL 23h
   - If Success=false: throw ConnectorError with ErrorCode + message
   - Use Redis distributed lock to prevent race conditions on concurrent refresh

2. pullOutputInvoices(params: SyncParams): Promise<RawInvoice[]>
   Endpoint: GET /api/integration/invoice/list
   Query params: 
     fromDate: ISO date string (yyyy-MM-dd)
     toDate: ISO date string (yyyy-MM-dd)  
     pageIndex: number (starts at 0)
     pageSize: 50
   
   Paginate until response array is empty.
   Handle DuplicateInvoiceRefID gracefully: log warning, skip (do not throw).
   Map response fields to RawInvoice schema.

3. pullInputInvoices(params: SyncParams): Promise<RawInvoice[]>
   Endpoint: GET /api/integration/purchaseinvoice/list (same params)
   If response is 403: log warning "MISA input invoice service not activated", return []
   DO NOT throw error — graceful degradation.

4. downloadPDF(externalId: string): Promise<Buffer>
   Endpoint: GET /api/integration/invoice/pdf/{externalId}
   Returns binary PDF.

5. downloadXML(externalId: string): Promise<string>
   Endpoint: GET /api/integration/invoice/xml/{externalId}
   Returns XML string.

6. healthCheck(): Promise<boolean>
   Try to get a valid token. Return true if success, false if auth fails.

Add comprehensive JSDoc with exact API endpoints and response schemas.
```

---

### SYNC-03: Viettel Connector — IP Whitelist & Milliseconds
```
[Respond in Vietnamese]
Create /backend/src/connectors/ViettelConnector.ts — complete implementation.

Viettel SInvoice API details (verified):
  Sandbox:    https://demo-sinvoice.viettel.vn:8443/InvoiceAPI
  Production: https://sinvoice.viettel.vn:8443/InvoiceAPI
  Auth: HTTP Basic Auth — Base64 encode "username:password"
  
  CRITICAL: All dates MUST be milliseconds (UNIX timestamp × 1000)
  CRITICAL: IP whitelist required — requests from non-whitelisted IPs return 500
  CRITICAL: Response body is Base64 encoded — must decode before JSON parse
  CRITICAL: Timeout must be 90000ms minimum

Private helper methods (required):
  private toMs(d: Date): number { return d.getTime() }
  private fromMs(ms: number): Date { return new Date(ms) }
  private decodeResponse(base64: string): any { 
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'))
  }
  private encodeAuth(user: string, pass: string): string {
    return Buffer.from(`${user}:${pass}`).toString('base64')
  }

1. authenticate(): validates credentials work (no session, stateless auth)
   Test by calling getListInvoice with empty date range.
   If result is 500: add specific error message: 
   "Viettel authentication failed. Check: (1) credentials correct? (2) Server IP whitelisted?"
   Log current outbound IP for debugging.

2. pullOutputInvoices(params): 
   Endpoint: POST /InvoiceAPI/InvoiceUtilsWS/getListInvoiceDataControl
   Headers: Authorization: Basic {base64auth}, Content-Type: application/json
   Body: {
     supplierTaxCode: credentials.taxCode,
     fromDate: this.toMs(params.fromDate),
     toDate: this.toMs(params.toDate),
     pageIndex: page,
     pageSize: 50,
     transactionUuid: uuidv4()  ← required for idempotency
   }
   Response: Base64 decode → JSON parse → extract invoice array
   Paginate until result.length < pageSize

3. pullInputInvoices(params):
   Endpoint: POST /InvoiceAPI/InvoiceUtilsWS/getListInputInvoice (if available)
   Same structure as output. If 404: log "Viettel input invoice API not available", return []

4. healthCheck(): POST to getListInvoiceDataControl with 1-day range, return true if 200

Add JSDoc comment at class level:
  "⚠️ VIETTEL IP WHITELIST: Server IP must be registered at sinvoice.viettel.vn
   Management → User Management → Update IP. 500 errors without detail = IP not whitelisted."
```

---

### SYNC-04: BKAV Connector
```
[Respond in Vietnamese]
Create /backend/src/connectors/BkavConnector.ts — complete implementation.

BKAV eInvoice API:
  Base: https://api.bkav.com.vn/einvoice
  Auth: headers PartnerGUID + PartnerToken (stateless, no expiry)

1. authenticate(): verify credentials by calling healthCheck endpoint
   GET /api/health or GET /api/invoices?page=1&pageSize=1
   
2. pullOutputInvoices(params):
   GET /api/invoices?from={ISO}&to={ISO}&page={n}&pageSize=50
   Headers: PartnerGUID: {guid}, PartnerToken: {token}
   Paginate until empty response.

3. pullInputInvoices(params):
   GET /api/purchase-invoices?from={ISO}&to={ISO}&page={n}&pageSize=50

4. downloadPDF(externalId): GET /api/invoices/{externalId}/pdf
5. downloadXML(externalId): GET /api/invoices/{externalId}/xml
6. healthCheck(): GET /api/health → return status === 200

Note: BKAV validates invoices with GDT internally.
When normalizing BKAV invoices: set gdt_validated=true by default.
```

---

### SYNC-05: Invoice XML Parser & Normalizer
```
[Respond in Vietnamese]
Create /backend/src/services/InvoiceNormalizer.ts — handles XML parsing from all 3 providers.

The challenge: same invoice standard (TT78/2021) but each provider has different XML field names.

Create 3 separate parser functions:
  parseMisaInvoice(rawResponse: any): NormalizedInvoice
  parseViettelInvoice(rawResponse: any): NormalizedInvoice  
  parseBkavInvoice(rawResponse: any): NormalizedInvoice

Each parser must handle:
1. Invoice header fields:
   MISA field → NormalizedInvoice field:
     invoiceNumber → invoice_number
     invoiceSerial → serial_number
     invoiceDate → invoice_date (parse to Date, handle multiple date formats)
     sellerTaxCode → seller_tax_code
     sellerName → seller_name
     buyerTaxCode → buyer_tax_code (may be empty for B2C)
     buyerName → buyer_name
     totalAmountWithoutTax → subtotal
     vatPercentage → vat_rate (normalize: "10%" → 10, "0.1" → 10, 10 → 10)
     vatAmount → vat_amount
     totalAmount → total_amount
     currencyCode → currency (default "VND")
     invoiceStatus → status (map: "1"→valid, "2"→cancelled, "5"→replaced)
   
   Viettel field names differ — reference actual Viettel API response structure.
   BKAV field names differ — reference BKAV API docs.

2. Line items (extract if available in response):
   Map to invoice_line_items schema: itemCode, itemName, unit, quantity, unitPrice,
   subtotal, vatRate, vatAmount, total

3. Error resilience: each field in try/catch — one field failing must NOT stop the whole invoice

4. Deduplication key: return { duplicateKey: `${company_id}:${provider}:${invoice_number}:${seller_tax_code}:${invoice_date}` }

Write unit tests in /backend/tests/normalizer/:
  misa.normalizer.test.ts — with 3 fixture JSON files from MISA API
  viettel.normalizer.test.ts — with 3 fixture JSON files
  bkav.normalizer.test.ts — with 3 fixture JSON files
```

---

### SYNC-06: Sync Worker — Orchestration Engine
```
[Respond in Vietnamese]
Create /backend/src/jobs/SyncWorker.ts — the main orchestration engine.

This worker runs as a BullMQ worker processing jobs from "invoice-sync-queue".

Job payload: { companyId: string, fromDate?: Date, toDate?: Date }
If fromDate not provided: use last successful sync date (from sync_logs) or 3 months ago.

Worker logic:

async function processSyncJob(job: Job<SyncJobPayload>): Promise<void> {
  const { companyId } = job.data
  const syncStart = new Date()
  
  // 1. Get all active connectors for this company
  const connectors = await db.query(
    "SELECT * FROM company_connectors WHERE company_id=$1 AND enabled=true AND circuit_state!='OPEN'",
    [companyId]
  )
  
  // 2. Run each connector in ISOLATION — one failure must not stop others
  const results = await Promise.allSettled(
    connectors.map(conn => syncSingleConnector(conn, job.data))
  )
  
  // 3. Log results
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      await updateCircuitBreaker(connectors[i], 'FAIL')
      await logSync(companyId, connectors[i].provider, 'error', result.reason)
    } else {
      await updateCircuitBreaker(connectors[i], 'SUCCESS')
      await logSync(companyId, connectors[i].provider, 'success', result.value)
    }
  }
  
  // 4. After all syncs complete:
  await triggerPostSyncJobs(companyId)  // GDT validation, anomaly detection, RFM recalc
  await sendSyncSummaryNotification(companyId, results)
}

async function syncSingleConnector(conn, params): Promise<SyncResult> {
  try {
    const plugin = registry.get(conn.provider)
    if (!plugin || !plugin.isEnabled()) return { skipped: true }
    
    await plugin.authenticate(conn.credentials_encrypted)
    
    // Pull invoices
    const [outputInvoices, inputInvoices] = await Promise.all([
      plugin.pullOutputInvoices(params),
      plugin.pullInputInvoices(params)
    ])
    
    // Normalize all invoices
    const normalized = [...outputInvoices, ...inputInvoices]
      .map(raw => InvoiceNormalizer.normalize(raw, conn.provider))
      .filter(Boolean)
    
    // Upsert to DB (ON CONFLICT DO UPDATE)
    const upsertResult = await bulkUpsertInvoices(normalized, conn.company_id)
    
    // Queue line item extraction for new invoices
    for (const inv of upsertResult.new) {
      if (inv.raw_xml) {
        await lineItemQueue.add({ invoiceId: inv.id })
      }
    }
    
    return { 
      provider: conn.provider,
      fetched: normalized.length,
      inserted: upsertResult.new.length,
      updated: upsertResult.updated.length
    }
  } catch (error) {
    // NEVER rethrow — just reject the promise with context
    throw new ConnectorError(conn.provider, error.message, error)
  }
}

Circuit breaker update:
  FAIL: increment consecutive_failures, if >= 3: set circuit_state='OPEN', created_at=NOW()
  SUCCESS: reset consecutive_failures=0, circuit_state='CLOSED'
  Check OPEN: if circuit_state='OPEN' AND updated_at < NOW()-60s: set 'HALF_OPEN', allow 1 try

BullMQ Cron setup (add to app startup):
  Every 15 minutes: add sync job for each active company
  const queue = new Queue('invoice-sync-queue', { connection: redis })
  new QueueScheduler('invoice-sync-queue', { connection: redis })
  // Cron: '*/15 * * * *' → every 15 minutes
```

---

### SYNC-07: Post-Sync Pipeline — GDT Validation & Line Items
```
[Respond in Vietnamese]
Create /backend/src/jobs/PostSyncPipeline.ts — jobs that run after each sync.

3 workers to create:

Worker 1: GdtValidationWorker
  Queue: 'gdt-validate-queue'
  Rate limiter: max 1 job per 2000ms (avoid GDT rate limit)
  
  Job payload: { invoiceId, invoiceNumber, sellerTaxCode, issuedDate }
  Process:
    1. Call GDT validation endpoint
    2. On valid: UPDATE invoices SET gdt_validated=true, gdt_validated_at=NOW()
    3. On invalid: UPDATE gdt_validated=false, status='invalid'
       → Create notification: type='INVALID_INVOICE'
    4. On GDT unreachable: retry up to 5 times, then skip (don't mark invalid)
  
  Schedule: Queue all non-validated input invoices after each sync

Worker 2: LineItemExtractionWorker
  Queue: 'line-item-extract-queue'
  Job payload: { invoiceId }
  Process:
    1. Fetch raw_xml from invoice
    2. Parse <DSHHDVu><HHDVu> elements from XML
    3. Extract: STT, MHHDVu(item code), THHDVu(item name), DVTinh(unit), 
       SLuong(qty), DGia(unit price), ThTien(subtotal), TSuat(vat rate), TienThue(vat amount)
    4. Bulk insert to invoice_line_items
    5. Normalize item_name: lowercase, remove accents, trim → normalized_name
    6. Upsert to product_catalog

Worker 3: PostSyncTriggers (runs after all connectors done)
  Queue: 'post-sync-triggers-queue'
  Process:
    1. Trigger RFM recalculation if last_rfm_calc > 24h ago
    2. Trigger price anomaly detection
    3. Trigger repurchase prediction update
    4. Update dashboard cache (Redis)
    5. Send sync summary push notification
```

---

### SYNC-08: Database Setup & Bulk Upsert
```
[Respond in Vietnamese]
Create DB infrastructure for the sync engine.

1. Create migration /scripts/007_sync_engine.sql:
```sql
-- Invoice upsert function (handles duplicates correctly)
CREATE OR REPLACE FUNCTION upsert_invoice(
  p_company_id UUID,
  p_provider VARCHAR,
  p_direction VARCHAR,
  p_invoice_number VARCHAR,
  p_seller_tax_code VARCHAR,
  p_invoice_date DATE,
  p_data JSONB  -- all other fields
) RETURNS TABLE(id UUID, is_new BOOLEAN) AS $$
DECLARE
  v_id UUID;
  v_is_new BOOLEAN;
BEGIN
  INSERT INTO invoices (
    id, company_id, provider, direction, invoice_number, 
    seller_tax_code, invoice_date, -- ... all fields from p_data
  ) VALUES (
    gen_random_uuid(), p_company_id, p_provider, p_direction,
    p_invoice_number, p_seller_tax_code, p_invoice_date
    -- ... values from p_data
  )
  ON CONFLICT (company_id, provider, invoice_number, seller_tax_code, invoice_date)
  DO UPDATE SET
    status = EXCLUDED.status,
    vat_amount = EXCLUDED.vat_amount,
    total_amount = EXCLUDED.total_amount,
    raw_xml = COALESCE(EXCLUDED.raw_xml, invoices.raw_xml),
    sync_at = NOW()
  RETURNING invoices.id, (xmax = 0) AS is_new
  INTO v_id, v_is_new;
  
  RETURN QUERY SELECT v_id, v_is_new;
END;
$$ LANGUAGE plpgsql;
```

2. Create /backend/src/services/BulkInvoiceUpsert.ts:
   Process invoices in batches of 100 using pg transaction
   Return: { inserted: Invoice[], updated: Invoice[], skipped: number }
   Log execution time — should be < 5s for 1000 invoices

3. Performance indexes (add to migration):
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_sync 
  ON invoices(company_id, provider, sync_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_period 
  ON invoices(company_id, invoice_date, direction, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_seller 
  ON invoices(company_id, seller_tax_code);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_buyer 
  ON invoices(company_id, buyer_tax_code);
```
```

---

### SYNC-09: Connector Setup UI — Complete Flow
```
[Respond in Vietnamese]
Create the complete connector setup flow so users can add and test connections.

Page: /settings/connectors

For each provider (MISA / Viettel / BKAV), create a setup card with:

MISA Card:
  Status indicator (connected / not connected / error / circuit open)
  Form fields:
    - Môi trường: radio [Test / Production]
    - App ID: text input (placeholder: "Nhận từ MISA support")
    - Mã số thuế: text (mst format: 10 digits)
    - Tài khoản meInvoice: text (email hoặc số điện thoại)
    - Mật khẩu: password with show/hide toggle
    - HĐ đầu vào: checkbox "Đã đăng ký dịch vụ HĐ đầu vào"
  Info box: "appid được MISA cấp khi đăng ký tích hợp. Liên hệ 1900 1518 hoặc support@misa.com.vn"

Viettel Card:
  Same structure but fields:
    - Tên đăng nhập: text (format: MST-số)
    - Mật khẩu: password
  Warning box (orange): 
    "⚠️ Viettel yêu cầu đăng ký IP server trước khi kết nối.
    IP server hiện tại: [show current server IP via /api/system/ip]
    Đăng ký tại: sinvoice.viettel.vn → Quản lý doanh nghiệp → Quản lý người dùng"
  
BKAV Card:
  Fields:
    - PartnerGUID: text
    - PartnerToken: password with show/hide

All cards have:
  [Kiểm tra kết nối] button:
    → Calls POST /api/connectors/test with form values (NOT saved yet)
    → Shows result: "✅ Kết nối thành công — tìm thấy X hóa đơn trong 7 ngày qua"
    → OR: "❌ Lỗi: [specific error message]"
    → For Viettel 500 error: show extra hint "Kiểm tra IP whitelist"
  
  [Lưu & Kết nối] button:
    → Encrypt credentials → Save to DB → Trigger first sync immediately
    → Show progress: "Đang lấy hóa đơn lần đầu... T3/2026: 45/200"
  
  [Đồng bộ ngay] (when connected):
    → Trigger manual sync job → Show toast progress

Backend: POST /api/connectors/test
  1. Decrypt-free: receive plain credentials
  2. Instantiate connector with these credentials
  3. Call authenticate() + fetch 1 page of recent invoices
  4. Return: { success, invoiceCount, latestInvoiceDate, error? }
  5. NEVER save credentials in this endpoint — just test
```

---

### SYNC-10: Integration Testing Script
```
[Respond in Vietnamese]
Create /scripts/test-sync-integration.ts — end-to-end integration test.

This script tests the FULL sync flow with real API credentials from .env.test

Usage: npm run test:integration:sync

Test sequence:

1. MISA Test:
  - Authenticate with test appid
  - Pull output invoices for last 30 days
  - Assert: response array received (may be empty in test env)
  - Pull input invoices (if configured)
  - Test downloadXML for first invoice returned
  - Print: "MISA: OK — X output invoices, Y input invoices"

2. Viettel Test:
  - Authenticate with demo credentials (0100109106-215 / 111111a@A)
  - Pull from demo environment
  - Verify datetime conversion: toMs/fromMs round-trip
  - Verify Base64 response decoding works
  - Print: "Viettel DEMO: OK — X invoices found"
  - If production credentials available: also test production (requires whitelisted IP)

3. BKAV Test:
  - Authenticate with PartnerGUID/Token
  - Pull recent invoices
  - Print: "BKAV: OK — X invoices"

4. Full pipeline test:
  - Run SyncWorker with companyId from test DB
  - Wait for completion
  - Assert: sync_logs has entry with status='success'
  - Assert: invoices table has records
  - Assert: invoice_line_items has records (if XML available)
  - Print timing: "Full sync completed in Xs for N invoices"

Output format: JSON report to /scripts/test-results/sync-YYYYMMDD.json
```

---

## PHẦN 5 — THỨ TỰ THỰC HIỆN ĐỀ XUẤT

```
Tuần 1 — Chuẩn bị (không code):
  □ Liên hệ MISA lấy appid (mất 2-5 ngày làm việc)
  □ Xác định IP server production
  □ Đăng ký IP với Viettel
  □ Lấy PartnerGUID/Token từ BKAV
  □ Test thủ công 3 provider bằng Postman/curl

Tuần 1 (song song với chuẩn bị):
  □ SYNC-01: Setup dependencies, env config
  □ SYNC-05: Invoice normalizer + fixtures
  □ SYNC-08: DB schema + bulk upsert

Tuần 2:
  □ SYNC-02: MISA Connector (test với testapi.meinvoice.vn)
  □ SYNC-03: Viettel Connector (test với demo env)
  □ SYNC-04: BKAV Connector

Tuần 2-3:
  □ SYNC-06: Sync Worker (orchestration)
  □ SYNC-07: Post-sync pipeline (GDT validate, line items)
  □ SYNC-09: Connector setup UI
  □ SYNC-10: Integration tests

Tuần 3:
  □ Test với dữ liệu thật (sau khi có appid + IP whitelist)
  □ Performance test: sync 1000 invoices, must complete < 3 phút
  □ Monitor: check circuit breakers, retry logs
```

---

## PHẦN 6 — ENVIRONMENT FILE MẪU

```env
# MISA meInvoice
MISA_ENV=test                           # 'test' hoặc 'production'
MISA_TEST_BASE_URL=https://testapi.meinvoice.vn
MISA_PROD_BASE_URL=https://api.meinvoice.vn
# appid lưu per-company trong DB (encrypted), không lưu trong .env
# Nhưng có thể có 1 platform appid nếu đàm phán được với MISA

# Viettel SInvoice
VIETTEL_ENV=demo                        # 'demo' hoặc 'production'
VIETTEL_DEMO_BASE=https://demo-sinvoice.viettel.vn:8443/InvoiceAPI
VIETTEL_PROD_BASE=https://sinvoice.viettel.vn:8443/InvoiceAPI
VIETTEL_DEMO_USER=0100109106-215
VIETTEL_DEMO_PASS=111111a@A
# Production credentials lưu per-company trong DB (encrypted)

# BKAV eInvoice
BKAV_BASE_URL=https://api.bkav.com.vn/einvoice
# PartnerGUID và PartnerToken lưu per-company trong DB (encrypted)

# Infrastructure
DATABASE_URL=postgresql://postgres:password@localhost:5432/hddtdb
REDIS_URL=redis://localhost:6379
ENCRYPTION_KEY=your-32-character-secret-key-here!!

# GDT Intermediary (TBD)
GDT_INTERMEDIARY_BASE_URL=             # Để trống cho đến khi đàm phán xong

# Gemini AI
GEMINI_API_KEY=your-gemini-api-key

# App
NODE_ENV=development
PORT=3001
APP_URL=http://localhost:3000
JWT_SECRET=your-jwt-secret-here
ENCRYPTION_KEY=your-32-byte-encryption-key
```
