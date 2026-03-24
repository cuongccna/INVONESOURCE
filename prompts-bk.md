# prompts.md — Dev Prompt Library

> **Usage:** Copy any prompt into GitHub Copilot Chat / Cursor / AI assistant.
> **Language rule:** All prompts written in English. AI must respond in Vietnamese.
> **Reference:** Always read PRD.md and copilot-instructions.md before implementing.

---

## GROUP 0 — PROJECT SETUP

### P0.1 — Project structure
```
[Respond in Vietnamese]
Scaffold a monorepo Node.js project with:
- /backend: Express.js + TypeScript API server
- /frontend: Next.js 14 App Router + TypeScript + Tailwind CSS
- /shared: shared TypeScript interfaces
- /scripts: numbered SQL migration files (001_init.sql, 002_...)
No Docker. DB = PostgreSQL local. Redis local.
Create root package.json with workspace scripts: dev:backend, dev:frontend, dev:all.
```

### P0.2 — Database migrations
```
[Respond in Vietnamese]
Create PostgreSQL migration SQL files for these tables:
companies, company_connectors, invoices, vat_reconciliations,
notifications, sync_logs, users, user_companies, push_subscriptions.
Schema in PRD.md Section 5.2.
Add indexes on: company_id, invoice_date, seller_tax_code, buyer_tax_code, direction, status.
Use node-postgres (pg) directly, no ORM.
```

### P0.3 — Environment config
```
[Respond in Vietnamese]
Create .env.example with all required variables:
DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET,
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
GEMINI_API_KEY, APP_URL, ENCRYPTION_KEY.
Create /backend/src/config/env.ts to validate env vars at startup using zod.
Throw descriptive error if required var is missing.
```

---

## GROUP 1 — PLUGIN CONNECTOR SYSTEM

### P1.1 — ConnectorPlugin interface + Registry
```
[Respond in Vietnamese]
Create the connector plugin system as defined in copilot-instructions.md:
1. /backend/src/connectors/types.ts — ConnectorPlugin interface, SyncParams, RawInvoice types
2. /backend/src/connectors/ConnectorRegistry.ts — Registry class with:
   - register(plugin), unregister(id), get(id), getAll()
   - Circuit breaker per plugin: 3 fails → OPEN → 60s cooldown → HALF_OPEN
   - Each plugin call wrapped in isolated try/catch
   - Plugin error must NOT propagate to other plugins or crash the app
3. Export singleton registry instance
```

### P1.2 — BaseConnector abstract class
```
[Respond in Vietnamese]
Create /backend/src/connectors/BaseConnector.ts:
- Implements ConnectorPlugin interface
- Protected helper: retryWithBackoff<T>(fn, maxRetries=3, baseDelayMs=1000)
- Protected helper: normalizeInvoice(raw: RawInvoice): NormalizedInvoice
- Protected helper: paginatedFetch<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]>
  (loops pages until empty result)
- Abstract methods: authenticate, pullOutputInvoices, pullInputInvoices, downloadPDF, healthCheck
All errors must be wrapped as ConnectorError with plugin id context.
```

### P1.3 — MISA Connector plugin
```
[Respond in Vietnamese]
Create /backend/src/connectors/MisaConnector.ts extending BaseConnector.
API details from copilot-instructions.md MISA section.
Requirements:
- Auto-refresh JWT token 5min before expiry (store expiry timestamp)
- Header: Authorization: Bearer {token}, CompanyTaxCode: {mst}
- pullOutputInvoices: paginate GET /api/invoice/list until empty page
- pullInputInvoices: GET /api/purchaseinvoice/list (may return 403 if add-on not purchased — handle gracefully, return [])
- On DuplicateInvoiceRefID error: log warning, return existing invoice data from response
- healthCheck: GET /api/auth/verify-token
```

### P1.4 — Viettel Connector plugin
```
[Respond in Vietnamese]
Create /backend/src/connectors/ViettelConnector.ts extending BaseConnector.
API details from copilot-instructions.md Viettel section.
Requirements:
- Auth: HTTP Basic (store username/password encrypted)
- CRITICAL: all dates must be milliseconds — add private toMs(d: Date): number helper
- pullOutputInvoices: POST /InvoiceUtilsWS/getListInvoiceDataControl
  Body: { supplierTaxCode, fromDate: toMs(from), toDate: toMs(to), page }
- axios timeout: 90000ms on every request
- Every request needs transactionUuid: uuid.v4()
- IP Whitelist note: add JSDoc warning comment explaining this requirement
- healthCheck: attempt authenticate, return true/false
```

### P1.5 — BKAV Connector plugin
```
[Respond in Vietnamese]
Create /backend/src/connectors/BkavConnector.ts extending BaseConnector.
API details from copilot-instructions.md BKAV section.
Requirements:
- Auth: request headers PartnerGUID and PartnerToken (no token expiry — stateless)
- pullOutputInvoices: GET /api/invoices?from={ISO}&to={ISO}&page={n}
- pullInputInvoices: GET /api/purchase-invoices?from={ISO}&to={ISO}&page={n}
- downloadPDF: GET /api/invoices/{id}/pdf
- downloadXML: GET /api/invoices/{id}/xml
- healthCheck: GET /api/health or attempt list with pageSize=1
- GDT validation is handled by BKAV internally — set gdt_validated=true by default
```

### P1.6 — Sync Worker with plugin isolation
```
[Respond in Vietnamese]
Create /backend/src/jobs/SyncWorker.ts using BullMQ:
- Queue: invoice-sync-queue (Redis)
- Job payload: { companyId, fromDate, toDate }
- Worker logic:
  1. Load all active company_connectors for this companyId
  2. For each connector, get plugin from registry (skip if not found or circuit OPEN)
  3. Wrap EACH plugin sync in isolated try/catch — failure logs to sync_logs, continues
  4. Pull invoices (paginated), normalize, upsert to DB (ON CONFLICT DO UPDATE)
  5. Queue GDT validation jobs for new invoices (rate-limited queue)
  6. On finish: update sync_logs, trigger push notification summary
- Cron: schedule every 15 minutes via BullMQ cron jobs
- Retry: 3 attempts with exponential backoff
```

---

## GROUP 2 — DATA LAYER

### P2.1 — Invoice normalization mapper
```
[Respond in Vietnamese]
Create /backend/src/services/InvoiceNormalizer.ts:
Normalize raw invoice data from each provider to shared NormalizedInvoice schema.
Handle field name differences:
- Date fields: ArisingDate (BKAV) vs invoiceDate (MISA) vs arisingDate (Viettel in ms)
- VAT rate: may be 0.1 / 10 / "10%" — normalize to number (e.g. 10)
- Currency: if not VND, store original + note (no conversion needed for now)
- Null/undefined: default to empty string or 0 where appropriate
Write unit tests for each provider's mapper using sample XML/JSON fixtures.
```

### P2.2 — Encryption utility
```
[Respond in Vietnamese]
Create /backend/src/utils/encryption.ts using Node.js built-in crypto (no external libs):
- encrypt(plaintext: string): string  — AES-256-GCM, prefix with IV
- decrypt(ciphertext: string): string
- Key source: process.env.ENCRYPTION_KEY (must be 32+ bytes)
- encryptCredentials(obj: Record<string, string>): string  — JSON.stringify then encrypt
- decryptCredentials(ciphertext: string): Record<string, string>  — decrypt then JSON.parse
Add unit tests for round-trip encrypt/decrypt.
```

### P2.3 — GDT Validator queue
```
[Respond in Vietnamese]
Create /backend/src/jobs/GdtValidatorWorker.ts:
- Queue: gdt-validate-queue with rate limiter: max 1 job per 2000ms
- Job: { invoiceId, invoiceNumber, sellerTaxCode, issuedDate }
- Call GDT validation endpoint
- On valid: UPDATE invoices SET gdt_validated=true, gdt_validated_at=NOW()
- On invalid: UPDATE gdt_validated=false, status='invalid'
  + create notification: type='INVALID_INVOICE', trigger push
- On GDT unreachable: retry up to 5 times, then skip (do not mark invalid)
```

---

## GROUP 3 — VAT & REPORTS

### P3.1 — VAT Reconciliation engine
```
[Respond in Vietnamese]
Create /backend/src/services/VatReconciliationService.ts:
Function calculatePeriod(companyId: string, month: number, year: number):
1. Query all output invoices (direction='output', status='valid') for period
2. Query all input invoices (direction='input', status='valid', gdt_validated=true) for period
3. Group by vat_rate (0, 5, 8, 10)
4. Calculate: outputVat, inputVat, payableVat per rate + totals
5. Upsert to vat_reconciliations table
6. Return VatSummary with breakdown by rate
Note: only gdt_validated input invoices count for VAT deduction (Vietnamese tax law).
```

### P3.2 — PL01-1 and PL01-2 generator
```
[Respond in Vietnamese]
Create /backend/src/reports/VatDeclarationGenerator.ts using exceljs:
generatePL011(companyId, month, year): Excel workbook
  - Sheet "Bảng kê bán ra (01-1)"
  - Columns: STT, Ký hiệu mẫu, Ký hiệu HĐ, Số HĐ, Ngày lập,
             MST người mua, Tên người mua, Doanh số chưa thuế, Thuế suất, Tiền thuế
  - Summary row: totals for doanh số and tiền thuế
generatePL012(companyId, month, year): Excel workbook  
  - Sheet "Bảng kê mua vào (01-2)"
  - Same structure but for input invoices (seller columns)
Format: Vietnamese number format (comma thousands, dot decimal), date DD/MM/YYYY.
```

---

## GROUP 4 — PWA & PUSH

### P4.1 — PWA manifest and service worker
```
[Respond in Vietnamese]
Set up PWA for Next.js 14 App Router:
1. /public/manifest.json: name="HĐĐT Platform", short_name="HĐĐT",
   display="standalone", theme_color="#1e40af", icons at 192 and 512px
2. /public/sw.js service worker:
   - Cache-first for: JS, CSS, fonts, images
   - Network-first for: /api/* routes
   - Offline fallback page at /offline
   - Background sync for any failed API mutations
3. Register SW in frontend/app/layout.tsx (client component)
4. Show install prompt after 30s on mobile if not installed
Do not use next-pwa package — implement manually for full control.
```

### P4.2 — VAPID Web Push system
```
[Respond in Vietnamese]
Implement Web Push with VAPID:
Backend:
- POST /api/push/subscribe: save PushSubscription to push_subscriptions table
- DELETE /api/push/unsubscribe: remove subscription
- Service pushToUser(userId, notification: PushPayload):
  fetch all subscriptions for user, call webpush.sendNotification()
  on 410 Gone: delete subscription from DB
Frontend:
- After user login: request Notification permission
- If granted: subscribe with VAPID public key, POST to /api/push/subscribe
- SW push handler: self.addEventListener('push', ...) → self.registration.showNotification()
- SW notificationclick: clients.openWindow(event.notification.data.url)
```

### P4.3 — Notification triggers
```
[Respond in Vietnamese]
Create /backend/src/services/NotificationService.ts with these trigger methods:
- onSyncComplete(companyId, provider, count): "Đồng bộ xong {count} hóa đơn từ {provider}"
- onInvalidInvoicesFound(companyId, count): "⚠️ Phát hiện {count} hóa đơn không hợp lệ"
- onTaxDeadlineApproaching(companyId, daysLeft, month): "📅 Còn {daysLeft} ngày đến hạn nộp tờ khai tháng {month}"
  Schedule: check daily at 8am, alert at 7 days and 2 days before the 20th
- onConnectorError(companyId, provider): "🔴 Mất kết nối {provider} — cần xác thực lại"
- onVatAnomaly(companyId, message): "⚠️ {message}"
All methods: create notification record in DB + call pushToUser.
```

---

## GROUP 5 — FRONTEND

### P5.1 — App layout with bottom navigation
```
[Respond in Vietnamese]
Create responsive layout for Next.js App Router:
- Desktop (>768px): collapsible sidebar with nav items
- Mobile (<768px): fixed bottom tab bar with 5 tabs:
  Dashboard | Hóa đơn | Đối chiếu | Báo cáo | Cài đặt
- Header: company switcher dropdown (for multi-company), notification bell with unread badge, user avatar
- Company switcher: stores active companyId in React Context, updates all data queries
Use Tailwind CSS only. Support dark mode (class-based, toggle in settings).
```

### P5.2 — Invoice list page
```
[Respond in Vietnamese]
Create /app/invoices/page.tsx:
- Filter bar: date range picker, provider checkboxes (MISA/Viettel/BKAV/All),
  direction toggle (Tất cả/Đầu vào/Đầu ra), status filter, search by name or tax code
- Desktop: data table with sortable columns: STT, Số HĐ, Ngày, Người bán/mua, Tiền, VAT, Trạng thái, Nguồn
- Mobile: card list view (compact)
- Row color: red background for status=invalid, yellow for status=adjusted
- Click row: slide-over panel with full invoice detail + Download PDF / XML buttons
- Header button: "Đồng bộ ngay" dropdown per provider
- Pagination: 50 items/page, show total count
- Loading state: skeleton rows
```

### P5.3 — Dashboard page
```
[Respond in Vietnamese]
Create /app/dashboard/page.tsx with Recharts:
1. KPI cards (4 cards): Doanh thu tháng này | Chi phí | VAT phải nộp | HĐ bất thường
   Each card shows: value, % change vs last month (green up / red down arrow)
2. Line chart: Revenue vs Cost, last 6 months
3. Stacked bar chart: VAT output vs input, last 6 months
4. Donut chart: Top 5 suppliers by spend
5. Recent invoices list: last 5 invoices with provider badge
6. Alerts panel: unread notifications, click to mark read
Layout: 1-column mobile, 2-3 column grid desktop.
All data fetched via SWR with 60s revalidation.
```

### P5.4 — Connector settings page
```
[Respond in Vietnamese]
Create /app/settings/connectors/page.tsx:
For each provider (MISA, Viettel, BKAV) show a card with:
- Status badge: Connected (green) / Disconnected (gray) / Error (red) / Circuit Open (orange)
- Last sync timestamp
- Credential form: password fields with show/hide toggle, masked after save (show last 4 chars only)
- "Test kết nối" button: calls GET /api/connectors/{id}/test, show success/fail toast
- "Đồng bộ ngay" button: triggers immediate sync job
- "Ngắt kết nối" button with confirmation dialog
BKAV: show PartnerGUID and PartnerToken fields
Viettel: show yellow warning banner about IP Whitelist requirement with link to instructions
```

---

## GROUP 6 — AI FEATURES

### P6.1 — Gemini OCR for scanned invoices
```
[Respond in Vietnamese]
Create /backend/src/services/GeminiOCRService.ts:
Function extractInvoiceFromImage(imageBuffer: Buffer, mimeType: string): Promise<Partial<NormalizedInvoice>>
- Use @google/generative-ai with model gemini-1.5-flash
- Send image as base64 inline_data
- Prompt: "Extract all fields from this Vietnamese VAT invoice (hóa đơn GTGT).
  Return JSON only (no markdown): { invoiceNumber, serialNumber, issuedDate (ISO),
  sellerTaxCode, sellerName, buyerTaxCode, buyerName, items: [{name, qty, unitPrice, vatRate, amount}],
  subtotal, vatAmount, total, currency }"
- Parse JSON response, map to NormalizedInvoice partial
- On parse failure: return null, mark invoice for manual review
```

### P6.2 — AI anomaly analysis
```
[Respond in Vietnamese]
Create /backend/src/services/GeminiAnomalyService.ts:
Function analyzeAnomalies(companyId: string, period: { month, year }): Promise<AnomalyReport>
Step 1 - Rule-based detection (fast, no AI cost):
  - Invoices with amount > (mean + 3*stdev) for that supplier
  - New supplier never seen before with large invoice
  - Same MST + same amount + same date (potential duplicate across providers)
  - VAT rate mismatch for known product categories
Step 2 - Send top 10 anomalies summary to Gemini:
  Prompt: "You are a Vietnamese tax accountant. Analyze these invoice anomalies.
  Explain each risk in Vietnamese and suggest action. Return JSON: [{id, risk, explanation, action}]"
Return combined: rule results + AI explanations.
```

### P6.3 — AI chat assistant
```
[Respond in Vietnamese]
Create /backend/src/routes/ai.ts endpoint POST /api/ai/chat:
- Accept: { message: string, history: {role, content}[], companyId: string }
- Build context: fetch aggregated stats for current month (totals, top 5 customers/suppliers)
- System prompt: "You are a financial assistant for a Vietnamese business.
  You have access to their invoice data summary below. Answer questions in Vietnamese.
  Current data: {context}"
- Multi-turn: include history in Gemini messages array
- Limits: max 20 turns per session, context window max 8000 tokens
- Never include raw invoice XML or personal data in prompt
```

---

## GROUP 7 — TESTING & UTILITIES

### P7.1 — Connector unit tests
```
[Respond in Vietnamese]
Write Jest unit tests for each connector plugin in /backend/tests/connectors/:
For each of MisaConnector, ViettelConnector, BkavConnector:
- Mock HTTP calls with msw (Mock Service Worker)
- Test: authenticate() succeeds and stores token
- Test: pullOutputInvoices() paginates correctly (3 pages, verify all records)
- Test: normalizeInvoice() maps all fields correctly (use fixture JSON/XML)
- Test: error handling — 401, 500, timeout — verifies ConnectorError is thrown
- Test Viettel specific: datetime conversion toMs() and fromMs()
- Test circuit breaker: 3 fails → plugin marked OPEN
Coverage target: 70%+
```

### P7.2 — Database seed script
```
[Respond in Vietnamese]
Create /scripts/seed.ts:
- 2 companies: "Công ty TNHH ABC" (MST: 0123456789), "Công ty CP XYZ" (MST: 9876543210)
- 1 admin user per company
- 50 output invoices + 30 input invoices for current month (realistic random data)
  Randomize: amounts 1M-500M VND, VAT rates 8%/10%, 3 providers
- VAT reconciliation data for last 3 months
- 5 unread notifications (mix of types)
- 3 connector configs (MISA, Viettel, BKAV) for company 1 — credentials encrypted
Run with: npm run db:seed
```

### P7.3 — Standard error handling
```
[Respond in Vietnamese]
Create /backend/src/utils/AppError.ts:
class AppError extends Error {
  constructor(message: string, statusCode=500, code='INTERNAL_ERROR', details?: unknown)
}
class ConnectorError extends AppError {
  constructor(pluginId: string, message: string, originalError?: unknown)
  // auto-prefixes message: "[misa] Failed to authenticate: ..."
}
Create /backend/src/middleware/errorHandler.ts:
- Global Express error handler
- Log with context (requestId, userId, companyId)
- Return: { success: false, error: { code, message } }
- Never expose stack trace in production
- RequestId: UUID v4 per request via middleware, attached to res.locals
```

### P7.4 — API response helpers
```
[Respond in Vietnamese]
Create /backend/src/utils/response.ts with helpers:
- sendSuccess(res, data: T, statusCode=200): void
- sendPaginated(res, data: T[], total: number, page: number, pageSize: number): void
  Response shape: { success: true, data: T[], meta: { total, page, pageSize, totalPages } }
- sendError(res, error: AppError): void
Apply to all route handlers throughout the project.
```

---

## QUICK REFERENCE

```bash
# Dev
npm run dev:backend     # Express API :3001
npm run dev:frontend    # Next.js :3000
npm run dev:all         # Both concurrently

# Database
npm run db:migrate      # Run pending migrations
npm run db:seed         # Seed sample data
npm run db:reset        # Drop + migrate + seed

# Generate VAPID keys (run once)
npx web-push generate-vapid-keys

# Test
npm test                # Unit tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report

# Type check
npm run type-check
```

---

## GROUP 8 — GDT INTERMEDIARY CONNECTOR

### P8.1 — GDT Intermediary plugin
```
[Respond in Vietnamese]
Create /backend/src/connectors/GdtIntermediaryConnector.ts extending BaseConnector.
This connector accesses ALL invoices directly from the Tax Authority's data warehouse
via a licensed intermediary partner (credentials TBD after negotiation).

Auth: OAuth2 client_credentials flow:
  POST {GDT_INTERMEDIARY_TOKEN_URL}
  Body: { grant_type: 'client_credentials', client_id, client_secret, scope }
  Response: { access_token, expires_in }

Config from env:
  GDT_INTERMEDIARY_BASE_URL (placeholder until partner provides)
  GDT_INTERMEDIARY_CLIENT_ID
  GDT_INTERMEDIARY_CLIENT_SECRET
  GDT_INTERMEDIARY_SCOPE

Key behaviors:
- Auto-refresh access_token before expiry (same pattern as MisaConnector)
- pullOutputInvoices: GET {base}/invoices/output?taxCode={mst}&from={ISO}&to={ISO}&page={n}
- pullInputInvoices:  GET {base}/invoices/input?taxCode={mst}&from={ISO}&to={ISO}&page={n}
  (exact endpoint paths TBD — design adapter so only URLs need changing)
- healthCheck: GET {base}/health or token verification
- On 404 base URL not configured: log warning, isEnabled() returns false (graceful skip)
- Mark source field on normalized invoices: source='gdt_intermediary'
Add JSDoc: "⚠️ Base URL and exact endpoints must be updated after partner negotiation"
```

### P8.2 — Cross-validation service
```
[Respond in Vietnamese]
Create /backend/src/services/CrossValidationService.ts:
Function crossValidate(companyId: string, period: {month, year}): Promise<CrossValidationReport>

Compare invoices from nhà mạng connectors vs GDT Intermediary for same period:
1. Fetch invoices from nhà mạng (source IN ['misa','viettel','bkav'])
2. Fetch invoices from GDT Intermediary (source = 'gdt_intermediary')
3. Match by: invoice_number + seller_tax_code + invoice_date
4. Detect discrepancies:
   - In nhà mạng but NOT in GDT → may not be officially registered yet
   - In GDT but NOT in nhà mạng → sync gap, add to DB from GDT data
   - Amount mismatch → flag for accountant review
5. Return: { matched: N, onlyInProvider: Invoice[], onlyInGdt: Invoice[], amountMismatches: Diff[] }
6. Create notifications for critical discrepancies
```

---

## GROUP 9 — TAX DECLARATION ENGINE

### P9.1 — Tax Declaration calculation engine
```
[Respond in Vietnamese]
Create /backend/src/services/TaxDeclarationEngine.ts
Function calculateDeclaration(companyId: string, month: number, year: number, options?: {
  includeUncashPayments?: boolean  // default false - exclude cash > 20M
}): Promise<TaxDeclaration>

Calculate all 01/GTGT form line items from invoice data.
Follow EXACTLY the formula in PRD.md Section 7:

[22] = SUM(input.vat_amount) WHERE status != 'cancelled'
[23] = SUM(input.vat_amount) WHERE status='valid' AND gdt_validated=true
      AND (total_amount <= 20_000_000 OR payment_method != 'cash')
[24] = previous period carry_forward_vat (ct43) or 0 if first period
[25] = [23] + [24]

[29] = SUM(output.subtotal) WHERE status='valid'
[30] = SUM(output.subtotal) WHERE status='valid' AND vat_rate=0
[32] = SUM(output.subtotal) WHERE status='valid' AND vat_rate=5
[33] = SUM(output.vat_amount) WHERE status='valid' AND vat_rate=5
[34] = SUM(output.subtotal) WHERE status='valid' AND vat_rate=8
[35] = SUM(output.vat_amount) WHERE status='valid' AND vat_rate=8
[36] = SUM(output.subtotal) WHERE status='valid' AND vat_rate=10
[37] = SUM(output.vat_amount) WHERE status='valid' AND vat_rate=10
[40] = [30]+[32]+[34]+[36]
[40a] = [33]+[35]+[37]
[41] = Math.max(0, [40a]-[25])
[43] = Math.max(0, [25]-[40a])

All amounts in VND, round to 0 decimal places (Math.round).
Save result to tax_declarations table (upsert by company+period+form_type).
Return fully typed TaxDeclaration object with all ct* fields populated.
```

### P9.2 — HTKK XML generator
```
[Respond in Vietnamese]
Create /backend/src/services/HtkkXmlGenerator.ts
Function generateXml(declaration: TaxDeclaration, company: Company): string

Generate XML file in HTKK format (TT80/2021) that GDT accepts at thuedientu.gdt.gov.vn.
Use xmlbuilder2 or fast-xml-parser to construct XML.
Structure (see PRD.md Section 7 for full schema):
- Root: <GDT>
- <HSoKKhaiThue> with:
  - <TTinChung> → <KKhaiThue>: maTCThue, tenNNT, maHSo="01/GTGT"
    kyKKhai format: "M{MM}-{YYYY}" monthly or "Q{Q}-{YYYY}" quarterly
    ngayLapTKhai: today ISO date
  - <ChiTietHSo>: one <ChiTieu ma="..."> per line item, value as integer string
  - Attached: PL01-1 (output invoices list) and PL01-2 (input invoices list)
    Each PL row: soThuTu, mauSo, kyHieu, soHoaDon, ngayLap, maSoThue, tenNguoiNop, doanhThu, thueSuat, tienThue

Encoding: UTF-8, no BOM.
Validate XML against known HTKK structure before returning.
Save xml_content to tax_declarations.xml_content and xml_generated_at = NOW().
```

### P9.3 — Tax declaration preview UI
```
[Respond in Vietnamese]
Create /app/declarations/[period]/page.tsx:
- Period format: "2025-01" (year-month)
- Layout:
  Top: period selector (month/year dropdown), company selector
  Left panel (desktop) / top section (mobile): Form 01/GTGT visual
    Show all line items [22]-[43] with:
    - Chỉ tiêu number in gray badge
    - Field name in Vietnamese
    - Calculated value (formatted VND, e.g. 1.234.567)
    - Color: [41] in red if > 0 (must pay), [43] in green (carry forward)
  Right panel / bottom: Actions
    - "Tính lại" button: recalculate from invoices
    - "Xem bảng kê" tab: show PL01-1 and PL01-2 tables
    - "Tải XML HTKK" button: download XML file (filename: 01GTGT_M{MM}{YYYY}_{MST}.xml)
    - "Hướng dẫn nộp" button: show step-by-step instructions modal for manual upload

Warning banner if:
  - Some input invoices not yet GDT validated (count + link to validate)
  - ct41 > 0 and filing deadline < 7 days away
  - Declaration already submitted this period (show reference number)
```

### P9.4 — T-VAN submission service (optional)
```
[Respond in Vietnamese]
Create /backend/src/services/TVanSubmissionService.ts
Implement T-VAN integration for automated tax declaration submission.

Note: T-VAN providers have their own APIs (not standardized).
Design as a plugin pattern similar to ConnectorPlugin:

interface TVanProvider {
  readonly id: string  // 'thaison' | 'ts24' | 'misa_tvan'
  submit(xml: string, taxCode: string, digitalSignature?: Buffer): Promise<TVanResult>
  checkStatus(transactionId: string): Promise<TVanStatus>
}

class TVanSubmissionService:
  - submitDeclaration(declarationId: string, providerId: string): Promise<void>
    1. Load declaration XML from DB
    2. Get company digital signature config (if available)
    3. Call provider.submit()
    4. On success: update tax_declarations SET submission_status='submitted',
       tvan_transaction_id=result.id, submission_at=NOW()
    5. Schedule status check job after 30 minutes
    6. Create notification: "Tờ khai {period} đã được nộp qua T-VAN"

Also create: TVanStatusChecker BullMQ worker
  - Every 30min: check pending submissions, update status
  - On 'accepted': notify user with GDT reference number
  - On 'rejected': notify user with error reason, set status='rejected'
```

### P9.5 — Declaration history page
```
[Respond in Vietnamese]  
Create /app/declarations/page.tsx — Declaration history and management:
- Table columns: Kỳ kê khai | Mẫu | VAT phải nộp | Trạng thái | Phương thức nộp | Ngày nộp | Actions
- Status badges:
  draft (gray): chưa hoàn thiện
  ready (blue): đã tính xong, chưa nộp
  submitted (orange): đã nộp, chờ xác nhận
  accepted (green): GDT đã tiếp nhận + mã tham chiếu
  rejected (red): bị từ chối + lý do

- Actions per row:
  draft/ready: "Xem" | "Tải XML" | "Nộp qua T-VAN" (if configured)
  submitted: "Kiểm tra trạng thái"
  accepted: "Xem mã tham chiếu" | "Tải XML đã ký"
  rejected: "Xem lý do" | "Sửa và nộp lại"

- Top actions: "Tạo tờ khai mới" button → goes to /declarations/[current-period]
- Filter: by year, form type
```
