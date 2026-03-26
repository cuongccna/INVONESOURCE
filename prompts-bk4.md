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

---

## GROUP 10 — MULTI-COMPANY MANAGEMENT (CRITICAL GAP)

### P10.1 — Multi-company data model + context
```
[Respond in Vietnamese]
The app must support 1 user managing up to 100+ companies simultaneously.
Current state: no company switching exists.

Create the multi-company foundation:
1. DB tables (if not exist):
   - companies: id, name, tax_code, address, phone, type ENUM('private','jsc','partnership','household'), fiscal_year_start SMALLINT DEFAULT 1, created_at
   - user_companies: user_id, company_id, role ENUM('OWNER','ADMIN','ACCOUNTANT','VIEWER'), created_at
   - Add company_id FK to: invoices, tax_declarations, vat_reconciliations, notifications, company_connectors, sync_logs

2. CompanyContext (React Context):
   - activeCompanyId: string | null
   - activeCompany: Company | null
   - companies: Company[]  ← all companies user has access to
   - setActiveCompany(id: string): void
   - Persist activeCompanyId in localStorage

3. API middleware requireCompany:
   - Read X-Company-Id header OR companyId from request body
   - Verify user has access to that company (query user_companies)
   - Attach company to req.company
   - All data queries MUST filter by company_id — never return cross-company data

4. ALL existing API routes must add company_id filter:
   GET /api/invoices → WHERE company_id = req.company.id
   GET /api/dashboard → WHERE company_id = req.company.id
   etc.
```

### P10.2 — Company switcher + company list UI
```
[Respond in Vietnamese]
Create the company management UI:

1. Header company switcher (top of every page):
   - Shows active company name + tax code
   - Dropdown: list all user's companies (max 6 visible, scrollable)
   - Each item: company name, tax code, role badge (Chủ sở hữu/Kế toán/Xem)
   - Bottom of dropdown: "+ Thêm công ty" link
   - On switch: update CompanyContext, invalidate all SWR caches, redirect to /dashboard
   - Search input inside dropdown if user has > 5 companies

2. /settings/companies page — full company list:
   - Table: Tên công ty | MST | Loại hình | Vai trò | Kết nối | Hành động
   - Actions: Quản lý kết nối | Xem tờ khai | Sửa | Rời khỏi
   - Status badge per company: shows connector health (all OK / has error / no connector)
   - "+ Thêm công ty" button → modal with form: tên, MST, loại hình, địa chỉ

3. /settings/companies/[id] — company detail:
   - Edit company info
   - Member management: list users, invite by email, change roles, remove
   - Danger zone: delete company (soft delete, require typing company name to confirm)
```

### P10.3 — Company onboarding flow
```
[Respond in Vietnamese]
Create first-time setup flow for new company at /onboarding:
Step 1 — Company info: name, tax_code, address, phone, company type, fiscal year start month
Step 2 — Connect providers: show MISA/Viettel/BKAV cards, each with credential form + "Test kết nối" button
           Can skip and add later
Step 3 — First sync: trigger sync for connected providers, show progress indicator
           "Đang lấy 245 hóa đơn từ MISA..."
Step 4 — Done: show summary (X hóa đơn đầu ra, Y đầu vào), redirect to /dashboard

Progress indicator: stepper at top (1-2-3-4 with check marks).
Persist onboarding step in localStorage so user can resume if they close browser.
After onboarding completes: set company.onboarded = true in DB.
If user has no companies: auto-redirect to /onboarding on first login.
```

---

## GROUP 11 — NOTIFICATIONS SYSTEM (MISSING)

### P11.1 — Notification bell + panel
```
[Respond in Vietnamese]
Implement the notification bell in the app header:
1. Bell icon with unread count badge (red dot with number, max "99+")
2. Click bell → slide-down panel (max-height 400px, scrollable):
   - Each notification: icon (based on type) + title + body + time ago + read/unread indicator
   - Notification types with icons:
     SYNC_COMPLETE → checkmark circle (green)
     INVALID_INVOICE → warning triangle (red)  
     TAX_DEADLINE → calendar (orange)
     CONNECTOR_ERROR → broken link (red)
     VAT_ANOMALY → chart up (orange)
   - Mark all as read button at top
   - Click notification → navigate to relevant page + mark as read
3. API:
   GET /api/notifications?companyId=&page=1&pageSize=20&unreadOnly=false
   PATCH /api/notifications/:id/read
   PATCH /api/notifications/read-all?companyId=
4. Polling: re-fetch every 30s via SWR with refreshInterval: 30000
```

### P11.2 — VAPID Web Push setup
```
[Respond in Vietnamese]
Implement Web Push notifications (VAPID protocol):

Backend:
1. Generate keys (run once, save to .env):
   npx web-push generate-vapid-keys
2. POST /api/push/subscribe:
   - Body: { subscription: PushSubscription }  (from browser)
   - Upsert into push_subscriptions table (endpoint is unique key)
3. Service: PushNotificationService
   async sendToUser(userId, companyId, payload: { title, body, icon?, badge?, data: { url, type } }):
     - Fetch all subscriptions for user
     - Call webpush.sendNotification() for each
     - On 410 Gone: delete expired subscription from DB
     - On error: log, don't throw (best-effort delivery)

Frontend (in layout.tsx or a client component):
1. After user logs in:
   - Check Notification.permission
   - If 'default': show subtle banner "Bật thông báo để nhận cảnh báo thuế"
   - Banner has "Bật ngay" button and "Để sau" dismiss
2. On permission granted:
   - navigator.serviceWorker.ready → pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })
   - POST subscription to /api/push/subscribe
3. Service Worker (sw.js) push event handler:
   self.addEventListener('push', e => {
     const data = e.data.json()
     e.waitUntil(self.registration.showNotification(data.title, {
       body: data.body,
       icon: '/icon-192.png',
       badge: '/badge-72.png',
       data: data.data
     }))
   })
   self.addEventListener('notificationclick', e => {
     e.notification.close()
     e.waitUntil(clients.openWindow(e.notification.data.url || '/'))
   })
```

### P11.3 — Tax deadline reminder scheduler
```
[Respond in Vietnamese]
Create /backend/src/jobs/TaxDeadlineReminderJob.ts:
BullMQ cron job, runs daily at 8:00 AM Vietnam time (cron: '0 1 * * *' UTC):

Logic:
1. Get today's date
2. Calculate next filing deadline: day 20 of next month
3. daysUntilDeadline = diff in days between today and deadline
4. If daysUntilDeadline === 7 OR daysUntilDeadline === 2:
   - Fetch all active companies
   - For each company, fetch all users with role OWNER or ADMIN
   - Create notification record: type='TAX_DEADLINE', title='Nhắc hạn nộp tờ khai', 
     body='Còn {N} ngày đến hạn nộp tờ khai thuế GTGT tháng {M}/{Y} (hạn ngày 20/{M+1})'
   - Send push notification to each user
5. Also trigger when: connector sync finds invalid invoice → immediate push
6. Also trigger when: circuit breaker opens → immediate push to company admins
```

---

## GROUP 12 — ANALYTICS & REPORTS (MISSING)

### P12.1 — Full analytics dashboard
```
[Respond in Vietnamese]
Replace the current basic dashboard with a full analytics page at /dashboard.
All data filtered by activeCompanyId from CompanyContext.

Section 1 — Period selector:
  - Month/year picker (default: current month)
  - Quick presets: Tháng này | Tháng trước | Quý này | Năm nay
  - Compare toggle: "So sánh với kỳ trước" (shows delta arrows on KPIs)

Section 2 — KPI cards (2x2 grid, mobile 1 column):
  Card 1: Tổng doanh thu (output invoices subtotal) — delta % vs prev period
  Card 2: Tổng chi phí (input invoices subtotal) — delta %
  Card 3: Thuế GTGT phải nộp [41] — highlight red if > 0, deadline warning
  Card 4: Hóa đơn chờ xác thực GDT — count, link to invoice list filtered

Section 3 — Revenue vs Cost chart (Recharts LineChart):
  - X-axis: last 12 months
  - 2 lines: Doanh thu (blue) + Chi phí (orange)
  - Tooltip: show values in VND format (e.g. 1.234 Tr)
  - Responsive container 100% width, 280px height

Section 4 — VAT breakdown bar chart (Recharts BarChart grouped):
  - X-axis: last 6 months
  - 3 bars per month: VAT Đầu Ra | VAT Đầu Vào | Phải Nộp
  - Colors: blue/green/red

Section 5 — Two columns side by side (stack on mobile):
  Left: Top 5 khách hàng (output) — horizontal bar chart or table with amount
  Right: Top 5 nhà cung cấp (input) — same

Section 6 — Invoice status summary:
  Donut chart: Hợp lệ | Chờ xác thực | Không hợp lệ | Đã hủy

All charts use real data from API. Show skeleton loading state. Error state with retry button.
```

### P12.2 — Trend analysis page
```
[Respond in Vietnamese]
Create /reports/trends page — deep trend analysis:

1. Revenue trend (12 months):
   - Area chart: monthly revenue with moving average line (3-month)
   - Highlight months above/below average with different fill color
   - Show YoY comparison if prior year data exists
   - "Mùa cao điểm": auto-detect top 3 months historically, badge them

2. Supplier concentration risk:
   - Pie chart: top 10 suppliers by spend % of total input
   - Warning if any single supplier > 30% of total spend
   - Table: Nhà cung cấp | Tổng mua | % tổng | Số HĐ | Trung bình/HĐ | Xu hướng (↑↓)

3. Customer concentration:
   - Same structure for output invoices
   - Revenue from top customer as % of total revenue

4. VAT efficiency trend:
   - Line chart: VAT phải nộp / Doanh thu ratio by month
   - Higher ratio = less input VAT to offset
   
5. Invoice volume trend:
   - Stacked bar: HĐ đầu ra + HĐ đầu vào per month
   - Average invoice value trend (subtotal/count)

Period selector: 3 months | 6 months | 12 months | 24 months
Export button: "Tải báo cáo PDF" (use browser print or jsPDF)
```

### P12.3 — Detailed invoice report
```
[Respond in Vietnamese]
Create /reports/invoices page — detailed filterable invoice report:

Filters (collapsible filter bar):
  - Date range (from/to)
  - Direction: Tất cả / Đầu ra / Đầu vào
  - Provider: All / MISA / Viettel / BKAV / GDT
  - Status: All / Hợp lệ / Không hợp lệ / Đã hủy / Chờ xác thực
  - VAT rate: All / 0% / 5% / 8% / 10%
  - Amount range: from/to (VND)
  - Customer/Supplier MST or name search

Summary row above table:
  Tổng: X hóa đơn | Doanh số: Y | Thuế GTGT: Z | Đang lọc: N kết quả

Table (sortable columns):
  Số HĐ | Ngày | Chiều | Đối tác (tên + MST) | Tiền trước thuế | VAT% | Tiền thuế | Tổng | Nguồn | Trạng thái

Pagination: 50/page with page jump input
Export selected / Export all filtered → Excel (exceljs)
Bulk actions (checkbox selection): Mark for review | Validate with GDT | Export
Mobile: card view instead of table
```

### P12.4 — Financial summary report (month-end)
```
[Respond in Vietnamese]
Create /reports/monthly/[year]/[month] — monthly financial summary:
Designed as a printable report (A4 layout).

Header: Company name, MST, Period, Generated date/time

Section 1 — Revenue summary table:
  Columns: Thuế suất | Doanh số chưa thuế | Thuế GTGT | Tổng doanh thu
  Rows: 0% | 5% | 8% | 10% | TỔNG CỘNG (bold)

Section 2 — Purchase summary table:
  Same structure for input invoices
  
Section 3 — VAT reconciliation:
  [22] Tổng VAT đầu vào: X
  [23] VAT được khấu trừ: Y  
  [24] Kết chuyển kỳ trước: Z
  [25] Tổng được khấu trừ: W
  [40a] Tổng VAT đầu ra: A
  [41] VAT phải nộp: B  (red if > 0)
  [43] Kết chuyển kỳ sau: C  (green if > 0)

Section 4 — Notable invoices:
  - HĐ chưa xác thực GDT: count + link
  - HĐ giá trị lớn (top 5 by amount)
  - HĐ bất thường flagged by AI

Actions: "In báo cáo" (window.print()) | "Tải Excel" | "Tạo tờ khai"
Responsive but optimize for print (print CSS: remove nav, full width)
```

---

## GROUP 13 — TAX DECLARATION COMPLETION

### P13.1 — Fix declaration calculation and UI
```
[Respond in Vietnamese]
The /declarations page currently shows empty state. Complete the full flow:

1. Backend: POST /api/declarations/calculate
   Body: { companyId, month, year }
   - Call TaxDeclarationEngine.calculateDeclaration() (see PRD §7 for exact formulas)
   - Upsert to tax_declarations table
   - Return full declaration with all ct22-ct43 fields
   
2. Backend: GET /api/declarations?companyId=&year=
   Return list of all declarations for company, sorted by period desc
   
3. Backend: GET /api/declarations/[id]
   Return single declaration with breakdown detail

4. Frontend: /declarations page
   - Show history table (not empty state) when declarations exist
   - "+ Tính Mới" button → modal: select month + year → call calculate API → redirect to detail
   
5. Frontend: /declarations/[id] page — Declaration detail view:
   Left side: Form 01/GTGT visual with all line items [22]-[43]
     Each row: chỉ tiêu number | field name (Vietnamese) | calculated value (VND format)
     Highlight [41] red if > 0, [43] green if > 0
   Right side: 
     - "Tải XML HTKK" button
     - "Xem bảng kê PL01-1" tab
     - "Xem bảng kê PL01-2" tab
     - Warnings: incomplete GDT validations, deadline proximity
```

### P13.2 — HTKK XML generator + download
```
[Respond in Vietnamese]
Create /backend/src/services/HtkkXmlGenerator.ts:
Generate valid HTKK XML for form 01/GTGT (TT80/2021).
Use xmlbuilder2: npm install xmlbuilder2

The XML must include:
- <HSoKKhaiThue> root with TTinChung and ChiTietHSo
- <KKhaiThue>: maTCThue, tenNNT, maHSo="01/GTGT", 
  kyKKhai (format: "T{month:02d}/{year}" e.g. "T03/2026"),
  ngayLapTKhai (today dd/MM/yyyy)
- All ChiTieu elements ma="22" through ma="43"
- Attached PL01-1 (output invoice list) and PL01-2 (input invoice list)
  Each row: soThuTu, mauSoHoaDon, kyHieuHoaDon, soHoaDon (no leading HD), 
  ngayHoaDon (dd/MM/yyyy), maSoThue, tenNguoiNopThue, doanhThu (integer VND), thueSuat, tienThue

Backend endpoint: GET /api/declarations/[id]/xml
  - Generate XML
  - Set headers: Content-Type: application/xml, Content-Disposition: attachment; filename=01GTGT_T{MM}{YYYY}_{MST}.xml
  - Stream XML to response

Frontend: "Tải XML" button calls this endpoint and triggers browser download.
Add instruction modal: step-by-step guide for uploading to thuedientu.gdt.gov.vn
```

---

## GROUP 14 — CONNECTOR HUB COMPLETION

### P14.1 — Connector setup UI (complete)
```
[Respond in Vietnamese]
The current /settings/connectors page shows only a broken connector card. Replace with complete UI:

Layout: 3 cards side by side (stack on mobile) — one per provider: MISA | Viettel | BKAV

Each provider card:
  Header: Provider logo placeholder (colored initial square) + name + status badge
  Status badges: 
    "Đã kết nối" green | "Chưa kết nối" gray | "Lỗi xác thực" red | "Circuit mở" orange

  Body when NOT connected: short description + form fields:
    MISA: Username, Password, Mã số thuế DN
    Viettel: Username, Password + yellow alert "Yêu cầu IP tĩnh — xem hướng dẫn"
    BKAV: PartnerGUID, PartnerToken
  
  Body when connected:
    Last sync: "23/03/2026 14:32 — 156 hóa đơn"
    Next sync: "23/03/2026 14:47 (tự động)"
    Circuit breaker: "CLOSED (hoạt động bình thường)"
    
  Footer buttons:
    Not connected: "Kiểm tra kết nối" (test) | "Lưu & Kết nối"
    Connected: "Đồng bộ ngay" | "Ngắt kết nối" (red, with confirm dialog)

"+ Thêm" button (top right): modal to add new provider in future (GDT Intermediary placeholder)

Show sync progress inline when sync is running: progress bar + "Đang lấy trang 3/12..."
On sync complete: success toast with count.
```

### P14.2 — Sync status + logs page
```
[Respond in Vietnamese]
Create /settings/sync-logs page:
- Filter by: provider, company, date range, status (success/error/running)
- Table: Thời gian bắt đầu | Nhà mạng | Công ty | Số HĐ | Trạng thái | Thời gian | Chi tiết
- Status badges: Đang chạy (spinner), Thành công (green), Lỗi (red), Đã hủy (gray)
- Click row → expand error detail inline
- "Chạy lại" button for failed syncs
- Auto-refresh every 10s when any job is running (SWR refreshInterval)
- Summary: total synced this month, last error time
```

---

## GROUP 15 — SECURITY & RBAC COMPLETION

### P15.1 — Auth hardening
```
[Respond in Vietnamese]
Complete authentication system:

1. Login page /login:
   - Email + password form
   - "Ghi nhớ đăng nhập" checkbox (extends refresh token to 30 days)
   - Forgot password link → /reset-password flow (token email)
   - Rate limiting: 5 failed attempts → 15 min lockout (Redis)
   - Show specific error only for "Sai mật khẩu" not account existence (security)

2. JWT middleware hardening:
   - Access token: 1h, signed HS256, stored in memory only (not localStorage)
   - Refresh token: 7d, stored HTTP-only Secure SameSite=Strict cookie
   - Silent refresh: auto-call /api/auth/refresh 5min before expiry
   - On 401: attempt refresh, if fails → redirect to /login

3. RBAC middleware requireRole(minRole):
   Role hierarchy: OWNER(4) > ADMIN(3) > ACCOUNTANT(2) > VIEWER(1)
   Apply to routes:
     OWNER only: DELETE company, manage members
     ADMIN+: manage connectors, trigger sync
     ACCOUNTANT+: create/edit declarations, export data
     VIEWER+: read-only access to all data
   Return 403 with message if insufficient role

4. Audit log: INSERT INTO audit_logs(user_id, company_id, action, entity_type, entity_id, changes, ip, created_at)
   Log: declaration created/submitted, connector added/removed, invoice manually changed
```

### P15.2 — User settings page
```
[Respond in Vietnamese]
Create /settings/profile page:
- Edit: full name, email (requires re-verify), phone
- Change password: old password + new + confirm
- Notification preferences (per company):
  Toggle: Đồng bộ xong | HĐ không hợp lệ | Deadline thuế | Lỗi kết nối | Bất thường VAT
  Toggle: Push notification (mobile) | Email notification
- Active sessions: list all logged-in devices, "Đăng xuất thiết bị này" per row
- Data: "Xuất tất cả dữ liệu của tôi" (GDPR-like)
```

---

## GROUP 16 — AI COMPLETION (Gemini)

### P16.1 — Complete AI chat with real data
```
[Respond in Vietnamese]
Complete the /ai page — AI chat with real company data context:

Backend POST /api/ai/chat:
1. Build context (inject into system prompt):
   const stats = await buildCompanyContext(companyId, currentMonth, currentYear)
   // stats includes: invoice counts, revenue totals, top 5 customers/suppliers,
   //   vat payable, pending GDT validations, last 3 months trend

2. System prompt (Vietnamese):
   "Bạn là trợ lý kế toán AI cho doanh nghiệp Việt Nam.
   Bạn có quyền truy cập dữ liệu hóa đơn của công ty {companyName} (MST: {taxCode}).
   Dữ liệu hiện tại ({month}/{year}): {JSON.stringify(stats)}
   Trả lời bằng tiếng Việt, ngắn gọn và chính xác.
   Không bịa đặt số liệu ngoài dữ liệu đã cung cấp."

3. Multi-turn: include history array in Gemini messages
4. Max 20 turns/session, max 8000 tokens total context
5. Response streaming (SSE) for better UX

Frontend:
- Suggested questions (clickable chips): update based on company context
  e.g. if ct41 > 0: "Tháng này phải nộp bao nhiêu thuế?"
  e.g. if anomalies > 0: "Hóa đơn nào bất thường trong tháng này?"
- Stream response to chat bubble (show typing indicator while streaming)
- Chat history persisted in localStorage (last 20 turns)
- "Xóa lịch sử" button
```

### P16.2 — AI anomaly detection widget
```
[Respond in Vietnamese]
Create an anomaly detection panel visible on dashboard and /ai page:

Backend POST /api/ai/anomalies (run after each sync):
Step 1 — Rule-based detection (fast, run immediately):
  - Invoice amount > mean + 2.5*stdev for that supplier/customer
  - First-time supplier with invoice > 50 million VND  
  - Duplicate amount: same MST + same exact amount within 7 days
  - VAT rate inconsistency: same supplier used different rates recently
  - Cash payment > 20M (not deductible — flag for accountant)

Step 2 — Send top 5 anomalies to Gemini for explanation:
  Prompt: "Bạn là chuyên gia thuế VN. Phân tích các bất thường sau.
  Với mỗi item: [1] giải thích rủi ro, [2] hành động đề xuất.
  Trả lời JSON: [{id, riskLevel:'high'|'medium'|'low', explanation, action}]"

Frontend — Anomaly panel:
  Show after sync completes if anomalies found
  Each anomaly card: invoice number | risk level badge | AI explanation | action button
  "Xem chi tiết" → navigate to invoice
  "Đánh dấu OK" → dismiss anomaly (save to dismissed_anomalies table)
  "Hỏi AI" → open /ai with pre-filled question about this invoice
```

---

## GROUP 17 — COMPANY HIERARCHY & CONSOLIDATED VIEWS (CRITICAL MISSING)

### P17.1 — Database: company hierarchy with self-reference
```
[Respond in Vietnamese]
Redesign the companies table to support multi-level hierarchy:
Tập đoàn (Group) → Công ty con (Subsidiary) → Chi nhánh (Branch) — unlimited depth via self-reference.

Migration: ALTER or recreate companies table:
```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  short_name VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  parent_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  level SMALLINT DEFAULT 1,              -- 1=Tổng công ty/độc lập, 2=Công ty con, 3=Chi nhánh
  entity_type ENUM('company','branch','representative_office','project') DEFAULT 'company',
  is_consolidated BOOLEAN DEFAULT false; -- true = tổng hợp số liệu từ children
```

Also create helper function:
```sql
-- Get all descendants of a company (recursive)
CREATE OR REPLACE FUNCTION get_company_tree(root_id UUID)
RETURNS TABLE(id UUID, name VARCHAR, level SMALLINT, path TEXT) AS $$
  WITH RECURSIVE tree AS (
    SELECT id, name, level, tax_code, parent_id, name::TEXT as path
    FROM companies WHERE id = root_id
    UNION ALL
    SELECT c.id, c.name, c.level, c.tax_code, c.parent_id, tree.path || ' > ' || c.name
    FROM companies c JOIN tree ON c.parent_id = tree.id
  )
  SELECT id, name, level, path FROM tree;
$$ LANGUAGE sql;
```

API: GET /api/companies/tree?organizationId= → nested tree structure
Response: { id, name, taxCode, level, entityType, children: [...] }
```

### P17.2 — Portfolio view: all companies bird's-eye dashboard
```
[Respond in Vietnamese]
Create /portfolio page — the master overview for users managing multiple companies.
This is the FIRST page shown after login if user has more than 1 company.

This page NEVER filters by a single company — it always shows ALL companies the user has access to.

Layout:

Section 1 — Summary bar (4 KPI cards in a row):
  - Tổng số doanh nghiệp: count of all companies
  - Tổng hóa đơn tháng này: SUM across all companies
  - Tổng VAT phải nộp: SUM of ct41 across all companies
  - Cần xử lý: count of companies with alerts (invalid invoices, connector errors, deadline approaching)

Section 2 — Company list table (the core of this page):
  Columns: Công ty | MST | Loại | HĐ đầu ra | HĐ đầu vào | Doanh thu | VAT phải nộp | Trạng thái | Hành động
  - Color code the VAT column: red if > 0 (must pay), green if 0 (carry forward)
  - Status column shows worst active alert for that company (error > warning > ok)
  - Sortable by any column
  - Hành động: "Xem" → switch activeCompany + go to /dashboard | "Tờ khai" | "Đồng bộ"
  - Show hierarchy indent: chi nhánh indented under parent with a tree line
  - Search/filter: by name, MST, entity_type

Section 3 — Aggregate comparison chart:
  Horizontal bar chart: top 10 companies by revenue this month
  Each bar: company short name + revenue value
  Click bar → navigate to that company's dashboard

API: GET /api/portfolio/summary?userId= 
  → returns array of companies with aggregated invoice stats for current month
  Performance: use a single SQL query with GROUP BY company_id (not N+1 queries)
```

### P17.3 — Consolidated (Group) view: merged financials
```
[Respond in Vietnamese]
Create /group/[organizationId] page — consolidated financial view for a corporate group.
Shows MERGED data from parent company + all subsidiaries + all branches as if they were one entity.

Important rules for consolidation:
1. EXCLUDE inter-company transactions (invoices where both seller_tax_code AND buyer_tax_code belong to companies in the same group — these are internal transfers, not real revenue)
2. Sum all output invoices from all entities in the group (minus inter-company)
3. Sum all input invoices from all entities
4. Calculate consolidated VAT position

Page layout:

Header: "Tập đoàn [Name]" + subtitle "Báo cáo hợp nhất — bao gồm X công ty con, Y chi nhánh"
Period selector: same as single-company view

Section 1 — Consolidated KPIs (same 4 cards as single company but labeled "Hợp nhất"):
  Tổng doanh thu hợp nhất | Tổng chi phí hợp nhất | VAT hợp nhất | Giao dịch nội bộ (excluded)

Section 2 — Entity breakdown table:
  Row per entity (parent + children + branches):
  Đơn vị | Doanh thu | Chi phí | VAT | HĐ nội bộ | % đóng góp doanh thu
  Last row: TỔNG HỢP (bold, sum of all minus inter-company)
  
  Visual: progress bar in % column (width = % of group total)
  Click row → drill down to /dashboard?companyId={id}

Section 3 — Group revenue breakdown (pie chart via Recharts):
  Each slice = one entity's share of total group revenue

Section 4 — Inter-company transactions panel:
  List of invoices where buyer and seller are both within this group
  These are highlighted (not counted in consolidated numbers) with explanation
  "Giao dịch nội bộ: 12 hóa đơn, tổng 3.5 tỷ — đã loại khỏi báo cáo hợp nhất"

API: GET /api/group/[orgId]/consolidated?month=&year=
  Complex SQL: join all companies in group, sum invoices, identify inter-company by cross-referencing tax codes
```

### P17.4 — Org/group management UI
```
[Respond in Vietnamese]
Create /settings/organizations page — manage corporate groups:

1. List of organizations user belongs to:
   Each org card shows: name, count of companies, user's role
   "+ Tạo tập đoàn mới" button

2. /settings/organizations/[id] — org detail:
   Left panel: org info form (name, short_name, description)
   Right panel: Company tree view (visual hierarchy):
   
   Display as indented tree:
   [icon] Tập đoàn ABC Holdings
     ├── [icon] Công ty ABC Sài Gòn (MST: 030...)
     │     ├── [icon] Chi nhánh Quận 1
     │     └── [icon] Chi nhánh Bình Dương
     ├── [icon] Công ty ABC Hà Nội (MST: 010...)
     └── [icon] Công ty ABC Đà Nẵng (MST: 040...)
   
   Each node has: name, MST, entity_type badge, [Sửa] [Xóa khỏi nhóm] buttons
   "+ Thêm công ty vào nhóm" → search existing companies or create new
   Drag to reorder / change parent (drag-and-drop hierarchy editing)
   
3. Company detail within org (modal or slide-over):
   - Change parent_id (move to different parent)
   - Change entity_type
   - Set is_consolidated toggle: "Tổng hợp số liệu từ các đơn vị con"

API:
  POST /api/organizations — create org
  GET/PUT /api/organizations/[id] — get/update
  POST /api/organizations/[id]/companies — add company to org
  DELETE /api/organizations/[id]/companies/[companyId] — remove
  PATCH /api/companies/[id]/parent — change parent_id (move in tree)
```

### P17.5 — Smart navigation: context-aware switching
```
[Respond in Vietnamese]
Redesign the header company switcher to support 3 levels of viewing context:

The switcher dropdown should have 3 sections:

─── Chế độ xem ───
  [icon] Danh mục của tôi (tất cả X công ty)  → /portfolio
  
─── Tập đoàn ───  (only shown if user belongs to any org)
  [org icon] ABC Holdings (5 công ty)  → /group/[orgId]
  [org icon] XYZ Group (3 công ty)     → /group/[orgId]

─── Đơn công ty ───
  [company icon] Công ty ABC Sài Gòn (active ✓)  → /dashboard
  [company icon] Chi nhánh Quận 1 (indented)
  [company icon] Công ty ABC Hà Nội
  ... (scrollable, search available)

Header display changes based on active context:
  Portfolio mode: show "Danh mục — X công ty" in header, no single-company data visible
  Group mode:     show "[Org Name] — Hợp nhất" in header
  Single mode:    show company name + MST (current behavior)

When in Portfolio or Group mode:
  - /dashboard, /invoices, /declarations etc. are DISABLED (show tooltip "Chọn một công ty để xem chi tiết")
  - Only /portfolio and /group/* routes are active
  - Bottom nav shows different items: Danh mục | So sánh | Cài đặt

State management:
  ViewContext: { mode: 'portfolio' | 'group' | 'single', orgId?: string, companyId?: string }
  Store in React Context + localStorage
  All data-fetching hooks check ViewContext before making API calls
```

### P17.6 — Cross-company comparison dashboard
```
[Respond in Vietnamese]
Create /compare page — side-by-side analysis of multiple companies.
User selects 2–6 companies to compare.

Header: Company selector (multi-select dropdown, max 6) + Period selector

Section 1 — KPI comparison table:
  Row per metric: Doanh thu | Chi phí | VAT phải nộp | Số HĐ đầu ra | Số HĐ đầu vào | Tỉ lệ VAT/Doanh thu
  Column per selected company: [Company name]
  Best value in each row highlighted green, worst highlighted red

Section 2 — Revenue trend (multi-line chart):
  12 months, one line per selected company (different colors)
  Recharts LineChart with legend showing company names
  Hover tooltip shows all company values for that month

Section 3 — Invoice health comparison:
  Grouped bar chart: 3 bars per company (Hợp lệ / Chờ xác thực / Không hợp lệ)
  Visual indicator of which company has best GDT compliance

Section 4 — VAT efficiency:
  Bar chart: VAT phải nộp as % of doanh thu per company
  Lower % = better (more input VAT to offset)

Export: "Tải báo cáo so sánh" → Excel with all metrics in columns

API: GET /api/compare?companyIds=[id1,id2,id3]&month=&year=
  Returns stats for each requested company in a single response (no N+1)
```

### P17.7 — Portfolio alerts & action center
```
[Respond in Vietnamese]
Create /portfolio/alerts page — action center for managing issues across ALL companies.
This is where a manager quickly spots which companies need attention.

Filters at top: Loại vấn đề | Công ty | Mức độ (Critical/Warning/Info) | Chưa xử lý only toggle

Alert types displayed:
  CRITICAL (red badge):
    - Connector error: "MISA của [Company X] mất kết nối — cần xác thực lại"
    - Deadline trong 2 ngày: "[Company Y] chưa nộp tờ khai T03/2026 — hạn ngày 20/04"
    - Invalid invoices: "[Company Z] có 5 hóa đơn không hợp lệ tổng 450 triệu"
  
  WARNING (orange badge):
    - Deadline trong 7 ngày: "Còn 7 ngày — [Company A] cần nộp tờ khai"
    - Chưa đồng bộ > 24h: "[Company B] chưa đồng bộ hóa đơn trong 28 giờ"
    - VAT bất thường: "[Company C] VAT đầu ra tháng này tăng 300% so với kỳ trước"

Each alert card:
  - Company name + entity type badge
  - Alert message
  - Time (when detected)
  - Action button: "Xử lý ngay" → navigate to the specific page for that company+issue
  - "Bỏ qua" button (snooze 24h)

Summary row at top: "5 Critical · 8 Warning · 12 Info — tổng 3 công ty cần xử lý ngay"

Auto-refresh every 60s.
```

### P17.8 — Backend: consolidated SQL queries
```
[Respond in Vietnamese]
Create /backend/src/services/PortfolioService.ts with efficient aggregate queries.
IMPORTANT: Use single SQL queries with aggregation — do NOT loop and fetch per company (N+1 anti-pattern).

1. getPortfolioSummary(userId, month, year):
```sql
SELECT 
  c.id, c.name, c.tax_code, c.parent_id, c.level, c.entity_type,
  COALESCE(inv_out.count, 0) as output_count,
  COALESCE(inv_out.subtotal, 0) as output_revenue,
  COALESCE(inv_out.vat, 0) as output_vat,
  COALESCE(inv_in.count, 0) as input_count,
  COALESCE(inv_in.subtotal, 0) as input_cost,
  COALESCE(inv_in.vat, 0) as input_vat,
  COALESCE(td.ct41, 0) as payable_vat,
  EXISTS(SELECT 1 FROM sync_logs sl WHERE sl.company_id = c.id AND sl.errors_count > 0 
         AND sl.started_at > NOW() - INTERVAL '24h') as has_sync_error
FROM companies c
JOIN user_companies uc ON c.id = uc.company_id AND uc.user_id = $1
LEFT JOIN (
  SELECT company_id, COUNT(*) as count, SUM(subtotal) as subtotal, SUM(vat_amount) as vat
  FROM invoices 
  WHERE direction = 'output' AND status = 'valid'
    AND EXTRACT(MONTH FROM invoice_date) = $2 AND EXTRACT(YEAR FROM invoice_date) = $3
  GROUP BY company_id
) inv_out ON c.id = inv_out.company_id
LEFT JOIN (
  SELECT company_id, COUNT(*) as count, SUM(subtotal) as subtotal, SUM(vat_amount) as vat
  FROM invoices
  WHERE direction = 'input' AND status = 'valid'
    AND EXTRACT(MONTH FROM invoice_date) = $2 AND EXTRACT(YEAR FROM invoice_date) = $3
  GROUP BY company_id
) inv_in ON c.id = inv_in.company_id
LEFT JOIN tax_declarations td ON c.id = td.company_id 
  AND td.period_month = $2 AND td.period_year = $3
ORDER BY c.level, c.name;
```

2. getConsolidatedGroupStats(orgId, month, year):
   Same query but filter by organization_id, PLUS exclude inter-company invoices:
   WHERE NOT (
     seller_tax_code IN (SELECT tax_code FROM companies WHERE organization_id = $1) AND
     buyer_tax_code  IN (SELECT tax_code FROM companies WHERE organization_id = $1)
   )

3. getCompanyTree(userId): recursive CTE as defined in P17.1
   Returns full nested tree structure for switcher dropdown

All queries must use proper indexes. Add migration:
  CREATE INDEX idx_companies_org ON companies(organization_id);
  CREATE INDEX idx_companies_parent ON companies(parent_id);
  CREATE INDEX idx_invoices_period ON invoices(company_id, invoice_date, direction, status);
```

---

## GROUP 18 — MINI-CRM & CUSTOMER INTELLIGENCE

### P18.1 — RFM customer segmentation engine
```
[Respond in Vietnamese]
Create /backend/src/services/RfmAnalysisService.ts

RFM = Recency, Frequency, Monetary — standard customer segmentation from sales invoice data.

Function calculateRfm(companyId: string, asOfDate: Date): Promise<RfmReport>

Step 1 — Aggregate per customer (buyer_tax_code) from output invoices:
  R (Recency):   days since last invoice date
  F (Frequency): count of invoices in last 12 months
  M (Monetary):  SUM(total_amount) in last 12 months

Step 2 — Score each dimension 1-5 using quintile ranking:
  R: lower days = higher score (recent = 5, old = 1)
  F: higher count = higher score
  M: higher amount = higher score
  RFM score = R*100 + F*10 + M (e.g. 555 = best customer)

Step 3 — Segment classification:
  Champions     : R>=4 AND F>=4 AND M>=4
  Loyal         : F>=3 AND M>=3
  At Risk       : R<=2 AND F>=3 AND M>=3  ← used to be good, now gone quiet
  New Customer  : R>=4 AND F<=1
  Big Spender   : M=5 (regardless of R, F)
  Lost          : R=1 AND F=1

Step 4 — Save to customer_rfm table:
  buyer_tax_code, buyer_name, r_score, f_score, m_score, rfm_score, segment, 
  last_invoice_date, invoice_count_12m, total_amount_12m, calculated_at

API:
  GET /api/crm/rfm?companyId=&segment=  → list with pagination
  GET /api/crm/rfm/summary?companyId=   → count per segment, total revenue per segment
  POST /api/crm/rfm/recalculate         → trigger recalculation job (BullMQ)

Run automatically after each sync completion.
```

### P18.2 — CRM customer list page
```
[Respond in Vietnamese]
Create /crm/customers page — customer intelligence dashboard:

Header KPIs (4 cards):
  Tổng khách hàng | Champions (count + % revenue) | At Risk (count + revenue at risk) | Khách mới tháng này

Segment filter tabs: Tất cả | Champions | Loyal | At Risk | Big Spender | New | Lost

Customer table:
  Tên khách hàng | MST | Lần mua cuối | Số lần mua | Tổng doanh thu | Segment badge | Điểm RFM | Hành động
  Segment badge colors: Champions=purple, Loyal=blue, At Risk=red, New=green, Lost=gray
  Sort by: doanh thu, lần mua cuối, điểm RFM
  Click row → customer detail slide-over

Customer detail (slide-over panel):
  - Company name, MST, address (from invoice data)
  - RFM breakdown: R/F/M scores with explanation
  - Invoice history: last 10 invoices (date, amount, items summary)
  - Revenue trend: 12-month bar chart (Recharts)
  - AI note (Gemini): "Khách này thường mua vào đầu tháng, đơn hàng trung bình 45 triệu, chưa mua trong 45 ngày — nguy cơ rời bỏ"

Export button: "Xuất danh sách CSV" per segment (for external email campaigns)
```

### P18.3 — Debt collection reminder system
```
[Respond in Vietnamese]
Create payment tracking and reminder system.
IMPORTANT: Vietnamese invoices don't always have payment_date — add this field and a way to mark invoices as paid.

1. DB migration: ADD COLUMN to invoices:
   payment_due_date DATE (calculated: invoice_date + default payment terms)
   payment_date DATE NULL (when actually paid — NULL = unpaid)
   payment_terms_days SMALLINT DEFAULT 30
   is_paid BOOLEAN GENERATED AS (payment_date IS NOT NULL) STORED

2. API: PATCH /api/invoices/:id/mark-paid  → set payment_date = today or custom date
   Bulk: POST /api/invoices/bulk-mark-paid

3. Aging Report Service: /backend/src/services/AgingReportService.ts
   getAgingReport(companyId, asOfDate):
     Bucket invoices by days overdue: current(0) | 1-30 | 31-60 | 61-90 | 90+
     Per bucket: count, total_amount, customer_count
     Per customer: list all overdue invoices with days overdue

4. Daily reminder job (BullMQ cron 8am):
   - Find invoices: payment_due_date = today OR payment_due_date = yesterday (already due)
   - Group by customer
   - Create notification + push: "Hôm nay 3 khách hàng đến hạn thu tiền: CT A (45tr), CT B (12tr), CT C (8tr)"
   - If overdue > 7 days AND > 20M: escalate alert level to CRITICAL

5. Frontend: /crm/aging page
   Aging matrix table: rows=customers, columns=0/1-30/31-60/61-90/90+ days
   Cell value: total overdue amount (red gradient — darker = older)
   "Gửi nhắc nhở" button per customer row (creates a reminder record)
```

### P18.4 — Telegram notification channel
```
[Respond in Vietnamese]
Integrate Telegram bot as an additional notification channel.
This is preferred by Vietnamese business owners over email — more immediate, no inbox noise.

Backend setup:
1. Create Telegram bot via @BotFather, save BOT_TOKEN to .env
2. DB: telegram_chat_configs(id, company_id, chat_id, chat_type ENUM('private','group'), 
   subscribed_events JSONB, is_active, created_at)
3. Service: TelegramNotificationService
   sendMessage(chatId, text: string, parseMode='HTML')
   sendAlert(companyId, event: NotificationEvent): routes to all configured chats for that company

Message formats (HTML Markdown):
  Debt due today:
    "💰 <b>Đến hạn thu tiền hôm nay</b>
    Công ty: Cty ABC
    • CT TNHH Khách A: <b>45.000.000đ</b> (HĐ #001)
    • CT CP Khách B: <b>12.000.000đ</b> (HĐ #002)
    Tổng: <b>57.000.000đ</b>"

  VAT deadline warning:
    "📅 <b>Nhắc nộp tờ khai thuế</b>
    Công ty: Cty ABC
    Còn <b>7 ngày</b> đến hạn nộp tờ khai T03/2026
    VAT phải nộp: <b>11.900.000đ</b>"

  Price increase alert:
    "⚠️ <b>Giá NCC tăng</b>
    Mặt hàng: Bao bì A
    NCC: Cty Vật tư XYZ
    Tháng trước: 12.000đ/cái → Tháng này: <b>12.600đ/cái (+5%)</b>"

Frontend: /settings/notifications/telegram
  - Show bot username + QR code / link to start chat
  - Input: paste Telegram chat_id (with instructions how to find it)
  - Toggle per event type: Nợ đến hạn | Hạn thuế | Giá NCC tăng | Đồng bộ lỗi | Tờ khai mới
  - Test button: "Gửi tin nhắn thử"
```

---

## GROUP 19 — VENDOR INTELLIGENCE & PRICE TRACKING

### P19.1 — Line item extraction from invoices
```
[Respond in Vietnamese]
IMPORTANT: Current invoice data only has header-level totals. To enable product/vendor analytics,
we need to extract line items (chi tiết hàng hóa) from invoice XML.

Create DB table:
  invoice_line_items (
    id UUID PK,
    invoice_id UUID FK,
    company_id UUID FK,
    line_number SMALLINT,
    item_code VARCHAR(100),         -- Mã hàng
    item_name TEXT,                 -- Tên hàng hóa, dịch vụ
    unit VARCHAR(50),               -- Đơn vị tính
    quantity NUMERIC(18,4),
    unit_price NUMERIC(18,2),
    subtotal NUMERIC(18,2),
    vat_rate NUMERIC(5,2),
    vat_amount NUMERIC(18,2),
    total NUMERIC(18,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
  CREATE INDEX idx_line_items_invoice ON invoice_line_items(invoice_id);
  CREATE INDEX idx_line_items_company_item ON invoice_line_items(company_id, item_name);

Parser: Extract from HTKK XML <DSHHDVu> (danh sach hang hoa, dich vu) section:
  <HHDVu>
    <STT>, <MHHDVu>, <THHDVu>, <DVTinh>, <SLuong>, <DGia>, <ThTien>, <TSuat>, <TienThue>
  </HHDVu>

Fallback: If XML not available, use Gemini OCR to extract line items from PDF.
Update InvoiceNormalizer to also parse and save line items after saving invoice header.
```

### P19.2 — Vendor price tracking & alerts
```
[Respond in Vietnamese]
Create /backend/src/services/VendorPriceTrackingService.ts

Function trackPriceChanges(companyId: string, period: {month, year}): Promise<PriceAlert[]>

Logic:
1. For each (seller_tax_code + item_name) combination in input invoices:
   Calculate: avg_unit_price for current period vs avg_unit_price for previous period
   price_change_pct = (current - previous) / previous * 100

2. Flag when:
   - price_change_pct > threshold (default: +5%, configurable per company)
   - OR price_change_pct < -10% (significant drop — also noteworthy)
   - OR new item_name never seen before from this supplier (new product line)

3. Save to price_alerts table:
   (company_id, seller_tax_code, seller_name, item_name, prev_price, curr_price, 
   change_pct, period_month, period_year, is_acknowledged, created_at)

4. Auto-trigger after each sync, create push notification + Telegram for significant changes

Frontend: /vendors/price-alerts
  Filter: by vendor, item category, date range, % threshold slider
  Table: Nhà cung cấp | Mặt hàng | Giá tháng trước | Giá tháng này | Thay đổi | Lần nhập cuối
  Change column: red up arrow for increase, green down arrow for decrease
  "Xem lịch sử" → price history chart for that item+vendor (last 12 months line chart)
  "Bỏ qua" button: dismiss alert, "OK giá mới" confirmation
```

### P19.3 — Vendor performance dashboard
```
[Respond in Vietnamese]
Create /vendors page — comprehensive vendor management view:

Section 1 — Vendor KPIs:
  Total active vendors (had invoice last 3 months) | Total spend this month
  Vendors with price increase this month | Concentration risk (top vendor % of total spend)

Section 2 — Vendor list (from input invoices):
  Columns: Nhà cung cấp | MST | Ngành | Tổng chi tiêu | Số HĐ | Giá TB/HĐ | Xu hướng giá | Rủi ro
  Trend column: sparkline chart (8 months mini chart) showing spend trend
  Risk badge: High (>30% of total spend), Medium (10-30%), Low (<10%) — concentration risk
  Sort: by spend, invoice count, price trend severity

Section 3 — Spend distribution:
  Treemap or donut chart: top 10 vendors by spend as % of total

Section 4 — New vendors this month:
  Table: vendors that appeared for the first time — highlight for review
  "Xác nhận đối tác" button: mark as verified vendor

Vendor detail (click row → slide-over):
  - Company info from invoice data
  - Spend history 12 months (bar chart)
  - Price trend for top 5 items purchased
  - All invoices list (filterable)
  - Notes field (free text for accountant)
```

---

## GROUP 20 — PRODUCT & PROFIT INTELLIGENCE

### P20.1 — Product catalog from invoice line items
```
[Respond in Vietnamese]
Create /backend/src/services/ProductCatalogService.ts

Build automatic product catalog from line items — no manual input needed.

Function buildCatalog(companyId: string): deduplicate and normalize item names

The challenge: same product may appear with slightly different names:
  "Bao bì A", "Bao bi A", "BAO BI A", "Bao bì loại A" → same product
  Use simple normalization: lowercase + remove accents + trim

Tables:
  product_catalog (
    id UUID PK, company_id UUID FK,
    normalized_name VARCHAR(255),     -- cleaned lookup key
    display_name VARCHAR(255),        -- most frequent original name
    category VARCHAR(100),            -- auto-classified by Gemini
    is_input BOOLEAN,                 -- appears in purchase invoices
    is_output BOOLEAN,                -- appears in sales invoices
    first_seen DATE, last_seen DATE,
    avg_purchase_price NUMERIC(18,2), -- latest from input invoices
    avg_sale_price NUMERIC(18,2),     -- latest from output invoices
    gross_margin_pct NUMERIC(5,2)     -- (sale - purchase) / sale * 100
  )

Auto-categorize using Gemini: 
  POST to Gemini with list of 100 product names, ask to assign category
  (e.g. "Bao bì" → Vật tư đóng gói, "Điều hòa" → Thiết bị điện tử)
  Cache categories, re-run monthly
```

### P20.2 — Product profitability (80/20 analysis)
```
[Respond in Vietnamese]
Create /products/profitability page — identify your most valuable products:

Backend: GET /api/products/profitability?companyId=&month=&year=
  For each product in catalog where is_output=true:
    revenue = SUM(output line items total for this product this period)
    cogs    = SUM(input line items total for this product same period)
    gross_profit = revenue - cogs
    gross_margin = gross_profit / revenue * 100
  Sort by gross_profit DESC

Frontend page:
Section 1 — 80/20 summary:
  "20% sản phẩm đầu bảng đóng góp X% doanh thu và Y% lợi nhuận"
  Visual: Pareto chart (bar=revenue per product, line=cumulative %)

Section 2 — Product profitability table:
  Columns: Sản phẩm | Doanh thu | Giá vốn | Lợi nhuận gộp | Margin% | Xu hướng | Phân loại
  Classification badges:
    Star (Sao): top 20% by profit + positive trend → "Đầu tư thêm"
    Cow (Bò sữa): top revenue but flat trend → "Duy trì"
    Dog (Gánh nặng): low margin AND low revenue → "Cân nhắc dừng"
    Question (Câu hỏi): high revenue but negative margin → "Xem lại giá"
  
Section 3 — Sleeping inventory alert:
  Products with input invoices (purchased) but NO output invoices in last 90 days
  "5 mặt hàng đã mua nhưng chưa bán trong 3 tháng — tổng giá trị tồn ước tính: 180tr"
  List with estimated value (unit_price × quantity purchased)
```

### P20.3 — Gross margin tracking per customer
```
[Respond in Vietnamese]
Enhance customer view to show TRUE profitability (not just revenue).

Create /backend/src/services/CustomerProfitabilityService.ts
Function calculateCustomerMargin(companyId, customerId, period):
  For each output invoice to this customer:
    For each line item: find matching item in input invoices → get COGS
    gross_profit = sale_price - purchase_price (matched by item_name normalization)
  
  Handle unmatched items (service, no input equivalent): treat as 100% margin

Result: { customerId, revenue, cogs, grossProfit, grossMarginPct, invoiceCount }

Update CRM customer list to show:
  Add column: Margin% (color: green >30%, yellow 10-30%, red <10%)
  Rename "Tổng doanh thu" to show: "Doanh thu / Lợi nhuận gộp"

Insight: "Top 5 khách hàng theo doanh thu" vs "Top 5 khách theo lợi nhuận" may differ significantly
Show both rankings side by side on /crm page — often a revelation for business owners.
```

---

## GROUP 21 — TAX PLANNING & FINANCIAL FORECASTING

### P21.1 — VAT forecast for next period
```
[Respond in Vietnamese]
Create /backend/src/services/VatForecastService.ts

Function forecastNextPeriod(companyId: string): Promise<VatForecast>

Method: weighted moving average of last 3 periods
  weights = [0.5, 0.3, 0.2] for [current-1, current-2, current-3] months
  
  forecast_output_vat = weighted avg of ct40a last 3 months
  forecast_input_vat  = weighted avg of deductible input last 3 months
  forecast_payable    = forecast_output - forecast_input
  carry_forward_from_current = current period ct43 (if any)

Confidence: "Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ."

Frontend: Add forecast card to dashboard (below current period VAT card):
  "Dự báo VAT tháng sau: ~12.4 triệu"
  Sub-text: "Dựa trên xu hướng 3 tháng gần nhất"
  Bar showing: current vs forecast side by side (small inline chart)
  "Chuẩn bị tiền" reminder button → creates calendar reminder in notifications

Also: Tax calendar widget on dashboard:
  Current month 20 (filing deadline): X days left / overdue
  Next month 20: forecast amount due
  Visual: horizontal timeline with colored markers
```

### P21.2 — Industry benchmark comparison
```
[Respond in Vietnamese]
Create anonymous benchmarking feature. 
IMPORTANT: all data used for benchmarks must be fully anonymized and aggregated — never expose individual company data.

Backend:
1. Opt-in system: company_settings.contribute_to_benchmark (default false)
   Only opted-in companies contribute to benchmark pool
   
2. Benchmark materialized view (refresh monthly):
   CREATE MATERIALIZED VIEW benchmark_by_industry AS
   SELECT 
     industry_code,
     AVG(vat_ratio) as avg_vat_ratio,        -- VAT/revenue ratio
     PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY vat_ratio) as p25_vat,
     PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY vat_ratio) as p75_vat,
     AVG(input_output_ratio) as avg_io_ratio, -- input VAT / output VAT
     COUNT(*) as sample_size
   FROM company_monthly_stats
   WHERE opted_in_benchmark = true
   GROUP BY industry_code
   HAVING COUNT(*) >= 10  -- minimum sample for privacy

3. GET /api/benchmark?companyId=&industryCode=
   Returns: company's own metrics + anonymized industry percentiles

Frontend: Benchmark section on /dashboard (only shown if opted in or after prompt):
  "Tỉ lệ VAT/Doanh thu của bạn: 8.2%"
  Industry average: 7.1% (p25: 5.2%, p75: 9.8%)
  Visual: gauge or position on distribution chart
  Call-to-action: "Đóng góp dữ liệu ẩn danh để nhận benchmark chi tiết hơn"
```

---

## GROUP 22 — CASH FLOW & PAYMENT INTELLIGENCE

### P22.1 — Cash flow projection
```
[Respond in Vietnamese]
Create /cashflow page — 30/60/90 day cash flow projection:

Data sources:
  Incoming (AR): output invoices unpaid (payment_date IS NULL)
    Expected date = payment_due_date (invoice_date + payment_terms_days)
  Outgoing (AP): input invoices unpaid
    Expected date = payment_due_date from input invoices
  Tax outflow: ct41 due on 20th of next month if > 0

Projection logic:
  For each day in next 90 days:
    expected_in  = SUM of AR invoices with payment_due_date = that day
    expected_out = SUM of AP invoices + tax due on that day
    net_cashflow = expected_in - expected_out

Frontend layout:
Section 1 — 30-day waterfall chart (Recharts):
  Each bar: net daily cashflow (green=positive, red=negative)
  Running balance line overlay
  Click bar → see which invoices are due that day

Section 2 — Summary cards:
  AR 30 days: total expected incoming
  AP 30 days: total expected outgoing  
  Tax due:    next filing amount
  Net 30d:    projected net

Section 3 — Critical dates list:
  Sorted list of dates with large expected flows
  Red highlight: dates where cumulative balance goes negative
  "Nguy cơ thiếu tiền ngày 15/04: dự kiến -45 triệu"

Section 4 — Overdue invoices requiring follow-up:
  AR overdue: payment_due_date < today AND payment_date IS NULL
  Shows urgency and customer contact (from invoice data)
```

### P22.2 — Customer payment behavior scoring
```
[Respond in Vietnamese]
Create /backend/src/services/PaymentBehaviorService.ts

Score each customer based on payment history (requires payment_date data):
  on_time_rate = count(payment_date <= payment_due_date) / count(paid invoices)
  avg_days_late = AVG(payment_date - payment_due_date) for late invoices
  
Payment Score (A/B/C/D):
  A: on_time_rate >= 90%        — "Thanh toán tốt"
  B: on_time_rate 70-90%        — "Thường trả đúng hạn"
  C: on_time_rate 50-70%        — "Hay trả trễ"
  D: on_time_rate < 50%         — "Rủi ro thanh toán cao"

Business rule suggestions (AI-generated):
  Score A: "Có thể đề xuất hạn thanh toán 45 ngày để tăng đơn hàng"
  Score D: "Nên yêu cầu thanh toán trước hoặc giảm hạn mức còn 15 ngày"

Show score on:
  - Customer list (badge next to name)
  - Invoice creation (warn if adding to Score D customer)
  - CRM customer detail slide-over
  - Cashflow projection (use score to weight reliability of expected payments)
```

---

## GROUP 23 — ESG & ADVANCED ANALYTICS

### P23.1 — ESG lite carbon footprint estimate
```
[Respond in Vietnamese]
Create basic ESG carbon footprint estimation from purchase data.
This is increasingly required for Vietnamese companies working with foreign partners.

Approach: spend-based estimation (Tier 3 GHG Protocol)
  carbon_estimate = spend_in_category × emission_factor_per_VND

Category mapping (Gemini classifies vendor + item → category):
  Energy & Fuel: 0.85 kgCO2/1000 VND spent
  Transport & Logistics: 0.62 kgCO2/1000 VND
  Manufacturing materials: 0.45 kgCO2/1000 VND
  Services: 0.12 kgCO2/1000 VND
  Office supplies: 0.18 kgCO2/1000 VND

Output: annual tCO2e estimate per company
Disclaimer: "Ước tính sơ bộ theo phương pháp chi tiêu. Cần kiểm toán chuyên nghiệp cho báo cáo ESG chính thức."

Frontend: ESG widget on dashboard (opt-in, collapsed by default):
  Annual carbon estimate: X tCO2e
  Top 3 emission categories (pie chart)
  "Tải báo cáo ESG sơ bộ" → PDF with methodology note
  
Use case: help SME understand their carbon profile before ESG becomes mandatory in VN (2025+ trend).
```

### P23.2 — Seasonal planning assistant
```
[Respond in Vietnamese]
Create /insights/seasonal page — AI-powered seasonal planning:

Backend: GET /api/insights/seasonal?companyId=&months=24
  Analyze 24 months of invoice data:
  1. Revenue seasonality: which months consistently above/below annual average
  2. Purchase seasonality: which months have highest input invoice spend
  3. VAT seasonality: months with highest tax burden
  4. Identify top customers' ordering patterns (which months they order most)

Gemini analysis prompt:
  "Analyze this Vietnamese business's 24-month invoice pattern and provide:
   1. Top 3 peak revenue months with explanation
   2. Top 3 low revenue months with risk assessment
   3. Recommended purchase timing (when to stock up based on sales cycle)
   4. Cash flow warning periods (high spend + low revenue months)
   Respond in Vietnamese with actionable recommendations."

Frontend:
  12-month heatmap: revenue intensity per month (color: dark=high, light=low)
  Side panel: AI recommendations in plain Vietnamese
  "Gợi ý lịch mua hàng": calendar view with suggested purchase timing
  "Kế hoạch dòng tiền": highlight danger months needing credit line

Save insights to insights_cache table, refresh monthly.
```

---

## GROUP 24 — PREDICTIVE REPURCHASE ENGINE

### P24.1 — Burn rate calculation engine
```
[Respond in Vietnamese]
Create /backend/src/services/BurnRateService.ts

This service analyzes OUTPUT invoice line items to calculate how fast each customer
consumes each product — enabling prediction of next purchase date.

Function calculateBurnRate(companyId: string): Promise<void>
  For each (buyer_tax_code + normalized_item_name) combination with >= 3 invoices:

  Step 1 — Calculate inter-purchase intervals:
    SELECT buyer_tax_code, normalized_item_name,
      invoice_date,
      LAG(invoice_date) OVER (PARTITION BY buyer_tax_code, normalized_item_name 
                              ORDER BY invoice_date) AS prev_date,
      quantity,
      LAG(quantity) OVER (...) AS prev_quantity
    FROM invoice_line_items
    JOIN invoices ON invoice_line_items.invoice_id = invoices.id
    WHERE invoices.direction = 'output' AND invoices.company_id = $1

  Step 2 — Compute per (customer + product):
    avg_interval_days = AVG(invoice_date - prev_date)
    avg_quantity_per_order = AVG(quantity)
    last_purchase_date = MAX(invoice_date)
    predicted_next_date = last_purchase_date + avg_interval_days
    days_until_predicted = predicted_next_date - CURRENT_DATE
    confidence = CASE WHEN data_points >= 6 THEN 'high'
                      WHEN data_points >= 3 THEN 'medium' ELSE 'low' END

  Step 3 — Upsert into repurchase_predictions table:
    (company_id, buyer_tax_code, buyer_name, normalized_item_name, display_item_name,
     avg_interval_days, avg_quantity, last_purchase_date, predicted_next_date,
     days_until_predicted, confidence, data_points, alert_sent_at, created_at)

  CREATE INDEX idx_repurchase_days ON repurchase_predictions(company_id, days_until_predicted);

Run: after each successful sync + once daily at 6am via BullMQ cron.
```

### P24.2 — Repurchase alert scheduler
```
[Respond in Vietnamese]
Create /backend/src/jobs/RepurchaseAlertJob.ts — BullMQ cron job, runs daily at 7am.

Logic:
1. Query repurchase_predictions WHERE days_until_predicted BETWEEN 3 AND 7
   AND confidence IN ('high', 'medium')
   AND (alert_sent_at IS NULL OR alert_sent_at < NOW() - INTERVAL '25 days')
   AND company_id IN (active companies)

2. Group by company_id + buyer_tax_code

3. For each company, send alerts via:
   a) Internal notification (bell icon) for ACCOUNTANT role:
      "3 khách hàng dự kiến đặt hàng lại trong 5 ngày tới"
   
   b) Telegram alert to sales team group (if configured, channel='sales'):
      "🔔 <b>Khách hàng sắp cần mua lại</b>
      Công ty: [Buyer Name]
      Sản phẩm: [Item] — dự kiến cần trong <b>[N] ngày</b>
      Lịch sử: mua [avg_qty] [unit] mỗi [avg_interval] ngày
      Tin cậy: [High/Medium]
      → Đây là thời điểm tốt để chăm sóc khách hàng!"
   
   c) Push notification (PWA) to company OWNER:
      "5 cơ hội bán hàng tuần này từ khách mua lại"

4. Update alert_sent_at = NOW() to avoid duplicate sends

Telegram channel routing:
  company has telegram_chat_configs with chat_type='sales_team' → send to that group
  Fallback to 'management' group if no sales group configured
```

### P24.3 — Repurchase predictions dashboard
```
[Respond in Vietnamese]
Create /crm/repurchase page — sales opportunity pipeline from predictions:

Header: "Cơ hội bán hàng từ dự đoán mua lại" + period context

Section 1 — Opportunity pipeline (kanban-style timeline):
  Column "Trong 7 ngày":  predictions where days_until_predicted 0-7 (urgent, red)
  Column "8-14 ngày":     predictions 8-14 (warm, orange)
  Column "15-30 ngày":    predictions 15-30 (upcoming, blue)

  Each card:
    Customer name (large) + MST (small)
    Product name + expected quantity
    "Lần mua cuối: X ngày trước"
    Confidence badge: Cao/Trung bình
    [Liên hệ ngay] button → opens note modal
    [Đã liên hệ] checkbox → marks as actioned

Section 2 — Prediction accuracy tracking:
  Table: predictions that were due + whether customer actually ordered
  Accuracy rate: "78% dự đoán trong 7 ngày đúng kỳ thực tế"
  Used to build trust with sales team over time

Section 3 — "Khách hàng im lặng" (Silent customers):
  Customers whose predicted_next_date has PASSED by >14 days with no new invoice
  These have likely churned or gone to competitor
  "8 khách hàng quá hạn dự kiến mua — cần chăm sóc khẩn"
  RFM segment overlay: if these are Champions/Loyal → escalate alert

API:
  GET /api/crm/repurchase?companyId=&daysRange=7|14|30
  PATCH /api/crm/repurchase/:predictionId/action  → mark as actioned, add note
```

### P24.4 — Zalo integration (optional, future)
```
[Respond in Vietnamese]
Design Zalo OA integration as a future channel for customer-facing alerts.
NOTE: This requires Zalo Official Account registration (business process, not just code).
Implement as a plugin following ConnectorPlugin pattern so it can be added without core changes.

Create /backend/src/notifications/ZaloNotificationPlugin.ts:
  interface NotificationPlugin {
    readonly channelId: string  // 'telegram' | 'email' | 'push' | 'zalo'
    send(recipient: RecipientConfig, message: NotificationPayload): Promise<void>
    isEnabled(): boolean
  }

Zalo ZNS (Zalo Notification Service) API — for transactional messages:
  POST https://business.openapi.zalo.me/message/template
  Headers: access_token (from Zalo OA OAuth2)
  Body: { phone, template_id, template_data: { customer_name, product_name, days } }

Template message (pre-approved by Zalo):
  "Xin chào [customer_name], cửa hàng [company] nhận thấy bạn sắp cần 
  bổ sung [product_name]. Liên hệ ngay để đặt hàng trước nhé!"

Config UI: /settings/notifications/zalo
  - Input: OA ID, OA Secret, template_id (after OA registration)
  - Map: buyer_tax_code → phone_number (manual mapping, or from contact database)
  - Warning banner: "Zalo ZNS yêu cầu đăng ký OA doanh nghiệp và phê duyệt template"

Priority: Telegram first (immediate, no approval needed), Zalo as premium upgrade.
```

---

## GROUP 25 — COST LEAK & FRAUD DETECTION (AI AUDITOR)

### P25.1 — Price anomaly detection engine (SQL-based)
```
[Respond in Vietnamese]
Create /backend/src/services/PriceAnomalyDetector.ts

This is an extension of VendorPriceTrackingService (P19.2) with deeper fraud-detection logic.
Uses PostgreSQL window functions — NO machine learning needed.

Function detectAnomalies(companyId: string, invoiceId?: string): Promise<Anomaly[]>

SQL Query — detect price anomalies using statistical baseline:
```sql
WITH price_history AS (
  SELECT 
    li.company_id,
    i.seller_tax_code,
    i.seller_name,
    li.normalized_item_name,
    li.unit_price,
    i.invoice_date,
    i.id as invoice_id,
    -- 90-day rolling average (baseline)
    AVG(li.unit_price) OVER (
      PARTITION BY li.company_id, i.seller_tax_code, li.normalized_item_name
      ORDER BY i.invoice_date
      ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING
    ) AS baseline_avg_price,
    -- Standard deviation for volatility
    STDDEV(li.unit_price) OVER (
      PARTITION BY li.company_id, i.seller_tax_code, li.normalized_item_name
      ORDER BY i.invoice_date
      ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING
    ) AS price_stddev,
    COUNT(*) OVER (
      PARTITION BY li.company_id, i.seller_tax_code, li.normalized_item_name
    ) AS data_points
  FROM invoice_line_items li
  JOIN invoices i ON li.invoice_id = i.id
  WHERE i.direction = 'input' AND i.company_id = $1
)
SELECT *,
  (unit_price - baseline_avg_price) / NULLIF(baseline_avg_price, 0) * 100 AS pct_deviation,
  CASE 
    WHEN data_points < 3 THEN 'insufficient_data'
    WHEN unit_price > baseline_avg_price + 2 * COALESCE(price_stddev, baseline_avg_price * 0.1)
      THEN 'price_spike'
    WHEN unit_price < baseline_avg_price - 2 * COALESCE(price_stddev, baseline_avg_price * 0.1)
      THEN 'price_drop'
    ELSE 'normal'
  END AS anomaly_type
FROM price_history
WHERE anomaly_type != 'normal' AND anomaly_type != 'insufficient_data'
ORDER BY ABS(pct_deviation) DESC;
```

Additional rule-based checks (complement statistical detection):
1. CROSS-VENDOR comparison: same item, different vendors, price gap > 20%
   → "Mặt hàng X: NCC A bán 50k/cái, NCC B bán 65k/cái cùng kỳ"
2. ROUND NUMBER suspicion: unit_price ends in 000 AND deviation > 10%
   → Suspiciously round numbers are common in manual invoice manipulation
3. NEW VENDOR + HIGH VALUE: vendor never seen before AND invoice > threshold
   → "Nhà cung cấp mới xuất hiện lần đầu với hóa đơn 150 triệu"
4. QUANTITY MISMATCH: same item ordered significantly more than usual
   → quantity > avg_quantity * 2.5 in same period
5. FREQUENCY SPIKE: same vendor invoiced > 3x in one week (split invoicing to avoid approval)

Save to price_anomalies table:
  (id, company_id, invoice_id, line_item_id, anomaly_type, severity ENUM('critical','warning','info'),
   seller_tax_code, seller_name, item_name, unit_price, baseline_price, pct_deviation,
   ai_explanation TEXT, is_acknowledged, acknowledged_by, acknowledged_at, created_at)
```

### P25.2 — Gemini AI explanation for anomalies
```
[Respond in Vietnamese]
Enhance PriceAnomalyDetector with AI-powered natural language explanations.

After SQL detection identifies anomalies, send top anomalies to Gemini for explanation:

Function explainAnomalies(anomalies: RawAnomaly[]): Promise<ExplainedAnomaly[]>

Gemini prompt (system):
"Bạn là kiểm toán viên nội bộ AI cho doanh nghiệp Việt Nam.
Phân tích các bất thường giá hóa đơn mua hàng sau.
Với mỗi bất thường, hãy:
1. Giải thích rủi ro bằng tiếng Việt đơn giản (1-2 câu, cho chủ doanh nghiệp đọc)
2. Đánh giá mức độ: Nghiêm trọng / Cần xem xét / Thông tin
3. Đề xuất hành động cụ thể (1 câu)
Format JSON: [{id, explanation, severity, action}]"

User message: JSON array of anomalies with: item_name, seller_name, unit_price, baseline_price, pct_deviation, anomaly_type

Example output:
{
  "explanation": "Mặt hàng giấy in A4 từ NCC Văn phòng phẩm XYZ tăng 30% so với giá trung bình 3 tháng trước mà không có thông báo trước. Mức tăng này cao hơn nhiều so với lạm phát thông thường.",
  "severity": "Nghiêm trọng",
  "action": "Yêu cầu NCC giải trình lý do tăng giá và so sánh báo giá với ít nhất 2 NCC khác."
}

Batch: max 10 anomalies per Gemini call. Cache explanations (same item+deviation → reuse).
```

### P25.3 — AI Auditor alert UI
```
[Respond in Vietnamese]
Create /audit/anomalies page — the "AI Auditor" dashboard.
This is the highest-value page in the app for business owners.

Page title: "Kiểm toán AI — Rò rỉ chi phí & Bất thường" with a shield icon

Section 1 — Severity summary bar (always visible, even on main dashboard):
  CRITICAL: N items | WARNING: N items | INFO: N items
  Total potential overcharge: SUM of (unit_price - baseline_price) × quantity for CRITICAL items
  "Phát hiện ~X triệu đồng chi phí bất thường cần xem xét"

Section 2 — Anomaly feed (card list, sorted by severity then pct_deviation):
  Each card:
    [SEVERITY BADGE] [ANOMALY TYPE LABEL]
    "Mặt hàng: [item_name]"
    "Nhà cung cấp: [seller_name] (MST: ...)"
    "Giá hôm nay: [unit_price] vs Giá bình quân: [baseline_price] ([+X%])"
    "Ngày hóa đơn: [date] — HĐ số: [invoice_number]"
    
    AI Explanation box (collapsible, default open for CRITICAL):
      "[Gemini explanation text]"
      "Đề xuất: [action]"
    
    Action buttons:
      [Xem hóa đơn] → navigate to invoice detail
      [Đánh dấu OK] → acknowledge with optional note (modal)
      [Báo cáo lên quản lý] → creates escalation notification to OWNER role

Section 3 — Vendor risk matrix:
  Table: Nhà cung cấp | Số lần bất thường 3T | Tổng tiền bất thường | Mức độ tin cậy
  Trust score: High/Medium/Low based on anomaly frequency
  "5 nhà cung cấp cần giám sát chặt hơn"

Notification triggers:
  CRITICAL anomaly detected → immediate push + Telegram to OWNER
  Message: "🚨 Phát hiện bất thường giá nghiêm trọng: [item] tăng [X]% — Kiểm tra ngay"

Run detection: after every sync + daily at 5am
Auto-dismiss: anomalies > 90 days old without action → archive
```

### P25.4 — Fraud pattern library (configurable rules)
```
[Respond in Vietnamese]
Create /settings/audit-rules page — allow admins to configure detection thresholds:

Default rules (editable):
  Rule 1: Price spike threshold
    Trigger: unit_price > baseline × [1.15] (default 15%)
    Severity: [Warning]
    Items excluded: ["Xăng dầu", "Điện"] (volatile by nature)

  Rule 2: Cross-vendor price gap  
    Trigger: price gap between vendors > [20%] for same item
    Severity: [Warning]
    Min data points: [3] invoices

  Rule 3: New vendor large invoice
    Trigger: first invoice from vendor AND total > [50,000,000] VND
    Severity: [Critical]
    
  Rule 4: Split invoice detection
    Trigger: same vendor, same approximate amount, within [7] days, count > [3]
    Note: "Có thể là phân nhỏ hóa đơn để tránh duyệt cấp trên"
    Severity: [Warning]

  Rule 5: Round price suspicion
    Trigger: unit_price is round number (ends in 000) AND deviation > [10%]
    Severity: [Info]

Each rule: toggle on/off, edit threshold, add item exclusion list
"Lưu & Chạy lại" button → re-runs detection with new rules

Store rules in: audit_rule_configs(company_id, rule_id, threshold, severity, enabled, exclusions, updated_at)
```

---

## GROUP 26 — UI COMPLETION: FIX EXISTING BUGS

### P26.1 — Fix ESG carbon calculation (currently showing 336,900 tCO2e — WRONG)
```
[Respond in Vietnamese]
The ESG Carbon Estimate widget on /dashboard is showing 336,900 tCO2e which is
completely wrong. This is because it's multiplying raw VND amounts without correct
emission factors.

Fix /backend/src/services/EsgEstimationService.ts:

Correct formula: carbon_estimate_kgCO2e = (spend_VND / 1,000,000) × emission_factor
Unit: tCO2e = kgCO2e / 1000

This prompt supersedes any earlier rough wording that implied factors were applied
directly on raw VND amounts.

Correct emission factors (kgCO2e per 1 MILLION VND spent):
  'Năng lượng & Nhiên liệu'    : 0.85
  'Vận tải & Logistics'        : 0.62
  'Vật tư sản xuất'            : 0.45
  'Dịch vụ'                    : 0.12
  'Văn phòng phẩm'             : 0.18
  'Xây dựng & Bất động sản'    : 0.38
  'Thực phẩm & F&B'            : 0.28
  'Khác'                        : 0.20  ← default

Example:
  spend_VND = 700,000,000
  factor = 0.20 kgCO2e / 1,000,000 VND
  carbon_estimate_kgCO2e = (700,000,000 / 1,000,000) × 0.20 = 140 kgCO2e
  carbon_estimate_tCO2e = 140 / 1000 = 0.14 tCO2e

The correct total for a typical 700M VND input invoice month should be roughly 0.1–0.3 tCO2e
with the factors above, not hundreds of thousands of tCO2e.

Also fix the UI display:
- Show "tCO2e" not "336.900 tCO2e" (remove absurd number)
- Add disclaimer text: "Ước tính sơ bộ theo phương pháp chi tiêu (Scope 3)"
- Show breakdown: top 3 categories with their carbon contribution
- If total < 1 tCO2e, show in kgCO2e instead
```

### P26.2 — Fix sync log warnings (showing 5 MISA warnings 23h ago with no detail)
```
[Respond in Vietnamese]
The dashboard shows 5 MISA sync warning icons (⚠) all showing "23h trước" with no
explanation. This is unhelpful. Fix the sync log display:

1. Backend: GET /api/sync/recent?companyId=&limit=5
   Return sync_logs with:
   - status: 'success' | 'warning' | 'error'
   - records_fetched count
   - error_detail (if any)
   - duration_seconds
   
   A sync is 'warning' only if: records_fetched > 0 BUT errors_count > 0
   A sync is 'error' if: records_fetched = 0 AND errors_count > 0
   A sync is 'success' if: errors_count = 0

2. Frontend: Fix the "Đồng Bộ Gần Đây" section on dashboard:
   Show meaningful status text instead of just the icon:
   ✅ MISA — "Đồng bộ 156 hóa đơn" — 23h trước
   ⚠️ Viettel — "Lấy được 45 HĐ, bỏ qua 2 lỗi" — 2h trước  
   🔴 BKAV — "Thất bại: Token hết hạn" — 5h trước [Xác thực lại]

3. If all syncs show the same timestamp (23h trước × 5): this indicates the cron job
   is not running correctly. Add a "Đồng bộ thủ công" button that triggers all active
   connectors immediately.
```

### P26.3 — Fix AI Anomaly Detection (currently empty — "Nhấn Phân tích" state)
```
[Respond in Vietnamese]
The "Phát Hiện Bất Thường AI" widget on dashboard shows empty state.
Fix it to show real results automatically, not require manual button press.

Changes needed:

1. Backend: Run anomaly detection automatically after each sync.
   POST /api/ai/anomalies/run should be called by the SyncWorker after completion.
   Results saved to price_anomalies table.

2. Backend: GET /api/ai/anomalies/summary?companyId=
   Return: { critical: N, warning: N, topItems: [{itemName, deviation, sellerName}] }

3. Frontend widget: Replace empty state with live data:
   If anomalies exist:
     "🔴 2 bất thường nghiêm trọng | ⚠️ 5 cần xem xét"
     Show top 2 anomalies inline:
       "Giấy in A4 — NCC Văn Phòng XYZ: tăng 30% so với tháng trước"
       "Bao bì loại B — NCC Vật Tư ABC: cao hơn 25% so với giá thị trường"
     [Xem tất cả →] link to /audit/anomalies
   
   If no anomalies: show "✅ Không phát hiện bất thường trong kỳ này"
   
   Remove the manual "Phân tích" button — make this automatic.
   Show "Cập nhật lúc: [last_sync_time]" timestamp.
```

---

## GROUP 27 — NAVIGATION: ADD ALL MISSING MODULES

### P27.1 — Add new navigation items (CRM, Vendors, Audit, Cashflow)
```
[Respond in Vietnamese]
The bottom navigation currently shows: Tổng Quan | Hóa Đơn | Tờ Khai | Đối Soát | AI | Báo Cáo

The following completely built modules have NO navigation entry and are unreachable:
- /crm/customers (RFM, customer list)
- /crm/repurchase (predictive repurchase)
- /crm/aging (debt collection)
- /vendors (vendor management)
- /vendors/price-alerts (price tracking)
- /products/profitability (product analysis)
- /cashflow (cash flow projection)
- /audit/anomalies (AI auditor / fraud detection)
- /reports/trends (trend analysis)
- /reports/monthly (monthly summary)
- /portfolio/alerts (multi-company alert center)

Fix: Replace the bottom nav (max 5 tabs on mobile) and add a "More" menu:

Bottom nav (5 tabs):
  Tổng Quan (/dashboard)
  Hóa Đơn (/invoices)
  Tờ Khai (/declarations)
  AI & Báo Cáo → opens a drawer/modal with all sub-pages
  Cài Đặt (/settings)

"AI & Báo Cáo" drawer sections:
  📊 Phân Tích:
    Báo cáo xu hướng (/reports/trends)
    Báo cáo tháng (/reports/monthly)
    So sánh công ty (/compare)
  
  👥 Khách Hàng (CRM):
    Danh sách & RFM (/crm/customers)
    Dự đoán mua lại (/crm/repurchase)
    Báo cáo nợ (/crm/aging)
  
  🏭 Nhà Cung Cấp:
    Tổng quan NCC (/vendors)
    Cảnh báo giá (/vendors/price-alerts)
  
  📦 Sản Phẩm:
    Lợi nhuận sản phẩm (/products/profitability)
  
  💰 Dòng Tiền:
    Dự báo 90 ngày (/cashflow)
  
  🔍 Kiểm Toán AI:
    Phát hiện bất thường (/audit/anomalies)
    Cấu hình quy tắc (/settings/audit-rules)
  
  🏢 Đa Công Ty:
    Danh mục tổng (/portfolio)
    Cảnh báo hệ thống (/portfolio/alerts)

Desktop sidebar: add all the above as grouped navigation items.
```

### P27.2 — Dashboard quick actions update
```
[Respond in Vietnamese]
The "Thao Tác Nhanh" section on dashboard currently shows:
  Xem Hóa Đơn | Tờ Khai | Kết Nối nhà mạng | Trợ Lý AI

Update to show context-aware quick actions based on what needs attention:

Dynamic quick actions (show the most relevant 4 based on current state):
  ALWAYS show:
    📄 Xem Hóa Đơn → /invoices
    🤖 Trợ Lý AI → /ai
  
  CONDITIONAL (show if condition is true):
    🔴 [N] Bất thường giá → /audit/anomalies  (if anomalies > 0)
    📅 Nộp tờ khai (còn N ngày) → /declarations  (if deadline < 10 days)
    💰 [N] Hóa đơn đến hạn → /crm/aging  (if overdue > 0)
    📈 Dự đoán mua lại → /crm/repurchase  (if predictions available)
    ⚠️ Lỗi kết nối → /settings/connectors  (if circuit breaker open)
    🏭 [N] Giá NCC tăng → /vendors/price-alerts  (if price alerts > 0)

Each action card: icon + label + count badge if applicable
Fetch: GET /api/dashboard/quick-actions?companyId= returns the relevant actions to show
```

---

## GROUP 28 — CRM PAGES: COMPLETE UI

### P28.1 — Build /crm/customers page (full implementation)
```
[Respond in Vietnamese]
Create the complete /crm/customers page. This page must fetch REAL data from the API.

Backend prerequisites (create if missing):
  GET /api/crm/rfm?companyId=&segment=&page=&pageSize=20
  GET /api/crm/rfm/summary?companyId=
  POST /api/crm/rfm/recalculate (trigger BullMQ job)
  
  If no RFM data exists yet: run calculateRfm() synchronously for the first request
  and return results (may take a few seconds — show loading state).

Full page layout:

1. Page header: "Khách Hàng" + period context + "Tính lại RFM" button

2. Summary cards row (horizontal scroll on mobile):
  [Tổng KH: 24] [Champions: 3 (45% DT)] [At Risk: 5 (23% DT)] [Mới T3: 2]
  
3. Segment filter tabs (horizontal scroll):
  Tất cả | Champions | Loyal | At Risk | Big Spender | New | Lost
  Each tab shows count badge

4. Customer list (mobile: cards, desktop: table):
  Each customer card:
    Avatar circle with initials (from company name)
    Tên công ty (bold) + MST (muted)
    RFM Score: [R:4 F:3 M:5] displayed as colored pills
    Segment badge (color-coded)
    Lần mua cuối: X ngày trước
    Tổng DT 12T: [amount]
    Số đơn: [count]
  
5. Customer detail (tap card → slide panel from bottom on mobile, right on desktop):
  Section: Thông tin
    Tên, MST, địa chỉ từ dữ liệu HĐ
    Segment badge + RFM explanation
  Section: Lịch sử mua hàng
    Last 5 invoices: date + amount + items count + VAT
    "Xem tất cả hóa đơn" link → /invoices?buyerTaxCode=X
  Section: Phân tích AI (Gemini)
    Load on demand: "Phân tích" button → call Gemini with customer data
    Show: pattern summary, churn risk, recommendation

6. FAB button (bottom right): "Tính lại RFM" → POST /api/crm/rfm/recalculate → show progress toast
```

### P28.2 — Build /crm/repurchase page (predictive pipeline)
```
[Respond in Vietnamese]
Create the complete /crm/repurchase page — sales opportunity pipeline.

Backend prerequisites:
  GET /api/crm/repurchase?companyId=&daysRange=7  (7|14|30)
  GET /api/crm/repurchase/stats?companyId=  (summary stats)
  PATCH /api/crm/repurchase/:id/action  (mark as actioned)
  
  If no prediction data: show onboarding message:
  "Cần ít nhất 3 lần mua hàng từ cùng 1 khách để dự đoán.
   Hệ thống đang phân tích dữ liệu của bạn..."

Page layout:

Header:
  "Dự Đoán Mua Lại" + "Cập nhật: [last_run_time]"
  Summary: "12 cơ hội trong 30 ngày tới | Độ chính xác: 78%"

Timeline tabs: Tuần này (7 ngày) | 2 tuần | Tháng này (30 ngày)

Opportunity cards (sorted by urgency):
  Each card:
    [URGENCY INDICATOR: red circle if ≤3 days, orange 4-7, blue 8+]
    Tên khách hàng (bold)
    Sản phẩm: [item_name]
    Dự kiến: [predicted_date] (còn X ngày)
    Trung bình: [avg_quantity] [unit] / [avg_interval] ngày
    Confidence: [Cao ✓ | Trung bình ~]
    [Đã liên hệ ✓] toggle  |  [Ghi chú] button

"Khách hàng im lặng" section (collapsed by default, expand with count):
  Customers whose predicted date has passed > 14 days
  Each: name + product + "[N] ngày quá hạn" (red text) + [Gọi ngay] button

Empty state (no predictions yet): 
  Illustration + "Hệ thống cần thêm dữ liệu để dự đoán. Khi có đủ 3 lần mua,
  dự đoán sẽ xuất hiện tự động."
```

### P28.3 — Build /crm/aging page (debt collection)
```
[Respond in Vietnamese]
Create the complete /crm/aging page — accounts receivable aging report.

Backend prerequisites:
  GET /api/crm/aging?companyId=  → aging buckets + customer breakdown
  PATCH /api/invoices/:id/mark-paid  → mark invoice as paid
  POST /api/crm/aging/send-reminder/:customerId  → create reminder notification
  
  Aging buckets: current (not due) | 1-30 | 31-60 | 61-90 | 90+ days overdue

Page layout:

Header summary bar (4 colored cards):
  Chưa đến hạn: [amount] (gray)
  Trễ 1-30 ngày: [amount] (yellow)
  Trễ 31-60 ngày: [amount] (orange)
  Trễ >60 ngày: [amount] (red)
  
  Total bar: "Tổng công nợ chưa thu: [sum] từ [N] khách hàng"

Important note for Vietnamese context:
  Most invoices don't track payment dates yet.
  Show banner: "Đánh dấu hóa đơn đã thanh toán để báo cáo chính xác hơn"
  Provide bulk-mark-paid option

Customer aging table:
  Columns: Khách hàng | MST | Chưa hạn | 1-30 ngày | 31-60 | 61-90 | 90+ | Tổng nợ | Hành động
  Row colors: all-gray → yellow → orange → red based on worst bucket
  Hành động: [Nhắc nợ] (creates notification) | [Xem HĐ] | [Đánh dấu đã thu]
  Expandable row: shows individual invoices with their amounts and due dates

"Nhắc nợ tự động" section at bottom:
  Toggle: "Tự động nhắc khi HĐ đến hạn 1 ngày trước"
  Toggle: "Nhắc qua Telegram" (if Telegram configured)
  "Cài đặt nhắc nhở" → /settings/notifications
```

---

## GROUP 29 — VENDOR & PRODUCT PAGES: COMPLETE UI

### P29.1 — Build /vendors page (vendor overview)
```
[Respond in Vietnamese]
Create the complete /vendors page — vendor management overview.

Backend: GET /api/vendors?companyId=&sortBy=spend&page=1
  Aggregate from input invoices: per seller_tax_code
  Return: seller_name, tax_code, total_spend_12m, invoice_count, last_invoice_date,
          avg_invoice_value, spend_pct_of_total, has_price_alert (boolean),
          price_trend: 'up'|'down'|'stable'|'new'

Page layout:

Header KPIs (4 cards):
  NCC hoạt động (3 tháng): [count]
  Tổng chi tiêu tháng này: [amount]
  Có cảnh báo giá: [count] (orange if > 0)
  NCC chiếm tỉ trọng cao nhất: [name] ([pct]%)

Vendor list (mobile: cards, desktop: table):
  Each vendor card/row:
    Avatar circle with initials
    Tên NCC (bold) + MST (muted)
    Tổng chi tiêu: [amount 12 tháng]
    Số HĐ: [count] | Trung bình: [avg/invoice]
    Tỉ trọng: [pct]% with mini progress bar
    Xu hướng: ↑ red (price up) | ↓ green (price down) | → stable | NEW badge
    Risk badge: Cao (>30%) | Trung bình (10-30%) | Thấp (<10%) concentration
    [Xem chi tiết] → vendor detail slide panel

"Cảnh báo giá" section (if any):
  "⚠️ [N] mặt hàng có biến động giá đáng chú ý → Xem chi tiết"
  Link to /vendors/price-alerts

"NCC mới tháng này" section:
  List vendors appearing for the first time — highlight for review
  [Xác nhận đối tác] button

Sort/filter: by spend, invoice count, risk level, price trend
```

### P29.2 — Build /vendors/price-alerts page
```
[Respond in Vietnamese]
Create the complete /vendors/price-alerts page.

Backend: GET /api/vendors/price-alerts?companyId=&severity=&acknowledged=false
  Return price_anomalies records with AI explanation

Page layout:

Header: "Cảnh Báo Biến Động Giá" + filter toggles

Filter bar: Nghiêm trọng | Cần xem xét | Thông tin | Đã xử lý

Alert cards (sorted by severity then pct_deviation):
  Each card has left border color: red=critical, orange=warning, blue=info
  
  Card content:
    [SEVERITY BADGE] [ANOMALY TYPE: "Tăng giá đột biến" | "Cao hơn NCC khác" | "NCC mới" | "Chia nhỏ HĐ"]
    Tên mặt hàng: [item_name] (bold, large)
    Nhà cung cấp: [seller_name]
    Giá hiện tại: [unit_price] → Giá bình quân: [baseline_price] (+ pct_deviation in red/green)
    Ngày phát hiện: [created_at] | HĐ số: [invoice_number]
    
    AI Giải Thích box (light blue background):
      "[ai_explanation text]"
      "Đề xuất: [action]"
    
    Action buttons row:
      [Xem hóa đơn] [Đánh dấu OK] [Báo lên quản lý]

Price history modal (when clicking item name):
  Line chart: unit_price over last 12 months for this item+vendor
  Show baseline (dotted line), actual prices (solid), flag anomaly points (red dots)

Summary at top: "Phát hiện ~[total_overcharge] triệu đồng chi phí bất thường tiềm tàng"
```

### P29.3 — Build /products/profitability page
```
[Respond in Vietnamese]
Create the complete /products/profitability page.

Backend: GET /api/products/profitability?companyId=&month=&year=
  Requires invoice_line_items data to exist.
  If no line_items extracted yet: show "Đang trích xuất chi tiết hàng hóa..." with progress.

Page layout:

Header: "Lợi Nhuận Sản Phẩm" + period selector

Section 1 — 80/20 insight banner:
  "20% sản phẩm hàng đầu đóng góp [pct]% doanh thu và [pct]% lợi nhuận"
  Mini Pareto chart (bar + cumulative line)

Section 2 — Product table (sortable):
  Columns: Sản phẩm | Doanh thu | Giá vốn | Lợi nhuận gộp | Margin% | Phân loại
  
  Classification badges (BCG-style):
    ⭐ Star: top margin + growing → "Đầu tư thêm" (green)
    🐄 Cash Cow: high revenue, stable → "Duy trì" (blue)  
    ❓ Question: high revenue, low margin → "Xem lại giá" (orange)
    🐕 Dog: low both → "Cân nhắc dừng" (red)
  
  Margin% column: green if >30%, yellow 10-30%, red <10%
  Sort: default by gross_profit DESC

Section 3 — "Hàng Ngủ Đông" alert box (if any):
  Red/orange banner: "5 mặt hàng đã nhập nhưng chưa bán trong 90 ngày"
  List: item_name | last_purchase_date | estimated_value
  "Cảnh báo: tổng giá trị tồn ước tính [X] triệu"

If no line_item data available:
  Empty state: "Tính năng này cần dữ liệu chi tiết hàng hóa từ hóa đơn XML.
  Hệ thống đang trích xuất tự động. Quay lại sau lần đồng bộ tiếp theo."
```

---

## GROUP 30 — CASHFLOW & AUDIT PAGES: COMPLETE UI

### P30.1 — Build /cashflow page (90-day projection)
```
[Respond in Vietnamese]
Create the complete /cashflow page.

Backend: GET /api/cashflow/projection?companyId=&days=90
  Calculate from unpaid invoices (payment_date IS NULL):
    AR (incoming): output invoices grouped by payment_due_date
    AP (outgoing): input invoices grouped by payment_due_date
    Tax: ct41 amount due on 20th of next month
  
  If no payment_due_date set: default = invoice_date + 30 days
  Return: daily buckets for next 90 days, running balance, summary

Page layout:

Header: "Dự Báo Dòng Tiền" + "90 ngày tới" label

Important banner (if no payment tracking data):
  "💡 Để dự báo chính xác hơn: đánh dấu hóa đơn đã thanh toán [Hướng dẫn]"

Section 1 — Summary cards:
  Thu dự kiến 30 ngày: [AR amount] (green)
  Chi dự kiến 30 ngày: [AP amount] (red)
  Thuế phải nộp: [tax amount + date] (orange)
  Dòng tiền ròng 30 ngày: [net] (green if positive, red if negative)

Section 2 — Waterfall chart (Recharts ComposedChart):
  Bar per week: net cashflow (green=positive, red=negative)
  Line: cumulative balance
  X-axis: weekly dates for 12 weeks
  Hover: shows AR + AP + tax breakdown for that week
  Red zone: when cumulative balance goes negative (shaded background)

Section 3 — Critical dates list:
  "Ngày cần chú ý" — dates where large flows occur
  Each: date + type (Thu tiền/Trả tiền/Thuế) + amount + who
  Sorted by absolute amount DESC
  Red highlight for negative-balance dates

Section 4 — Overdue receivables:
  AR invoices where payment_due_date < today AND payment_date IS NULL
  Table: Khách hàng | Số HĐ | Hạn | Quá hạn | Số tiền | [Nhắc nợ]
  
  "Đánh dấu đã thu" button: opens date picker → sets payment_date
```

### P30.2 — Build /audit/anomalies page (AI Auditor — the killer feature)
```
[Respond in Vietnamese]
Create the complete /audit/anomalies page. This is the highest-value page in the app.
Make it look professional and trustworthy — this is what justifies the subscription.

Backend: 
  GET /api/audit/anomalies?companyId=&severity=&acknowledged=false&page=1
  GET /api/audit/summary?companyId=  → counts + total_overcharge_estimate
  PATCH /api/audit/anomalies/:id/acknowledge  (with optional note)
  POST /api/audit/anomalies/:id/escalate  → creates CRITICAL notification to OWNER

Page layout:

Header: 
  Shield icon + "Kiểm Toán AI" title
  Sub: "Giám sát 24/7 | Cập nhật sau mỗi lần đồng bộ"

Alert banner (if critical items exist — RED background):
  "🚨 Phát hiện [N] bất thường nghiêm trọng — ước tính [X] triệu đồng chi phí bất thường"
  [Xem ngay] button scrolls to critical items

Severity filter tabs: Tất cả | 🔴 Nghiêm trọng ([N]) | ⚠️ Cần xem ([N]) | ℹ️ Thông tin ([N]) | ✅ Đã xử lý

Anomaly cards:
  Left border: 4px red=critical, orange=warning, blue=info
  
  Card header:
    [SEVERITY BADGE] [TYPE BADGE: "Tăng giá đột biến" / "NCC mới giao dịch lớn" / "Chia nhỏ HĐ" / "Chênh lệch NCC"]
    Mặt hàng: [item_name] (18px bold)
    [seller_name] — [invoice_date] — HĐ #[invoice_number]
  
  Price comparison row (visual):
    Giá bình quân: [baseline]đ  →→→  Giá này: [unit_price]đ  [+X% ▲] (red)
  
  AI Explanation card (light background, distinct style):
    Robot icon + "Phân tích AI"
    "[ai_explanation — written in simple Vietnamese for business owner]"
    "Đề xuất hành động: [action]"
  
  Action buttons:
    [Xem hóa đơn gốc] → navigate to invoice
    [Đánh dấu OK - Đã kiểm tra] → acknowledge modal with note field
    [🔔 Báo cáo lên Giám đốc] → POST escalate → sends push + Telegram to OWNER

Vendor Risk Table (below anomaly list):
  "Nhà cung cấp cần theo dõi"
  Columns: NCC | Số lần bất thường (3T) | Tổng tiền chênh | Mức độ tin cậy
  Trust score badges: Cao (green) | Trung bình (yellow) | Thấp (red)

Empty state (no anomalies):
  Green checkmark illustration
  "✅ Không phát hiện bất thường trong kỳ này"
  "Hệ thống kiểm tra liên tục sau mỗi lần đồng bộ hóa đơn"
```

### P30.3 — Build /reports/trends page (trend analysis)
```
[Respond in Vietnamese]
Create the complete /reports/trends page.

Backend: GET /api/reports/trends?companyId=&months=12
  Return monthly aggregates: revenue, cost, vat, invoice_count, avg_invoice_value
  Plus: top_customers (top 5 by revenue), top_suppliers (top 5 by spend)
  Plus: seasonality insight (which months are above/below average)

Page layout:

Header: "Phân Tích Xu Hướng" + period selector (3T / 6T / 12T / 24T)
Export button: "Tải báo cáo" (browser print)

Section 1 — Revenue trend (Recharts AreaChart):
  12 months area chart: revenue (blue fill) + cost (gray fill)
  Moving average line (3-month, dashed)
  Highlight bars: months > average (darker shade)
  Seasonal labels: auto-detect top 3 months → show "Cao điểm" badge on X-axis
  Y-axis: format as "Trđ" (triệu đồng)

Section 2 — VAT trend (Recharts BarChart grouped):
  Grouped bars: VAT đầu ra (blue) | VAT đầu vào (green) | Phải nộp (red)
  6 months

Section 3 — Two columns:
  Left: Top 5 khách hàng (by revenue) — horizontal bar chart
    Each bar: customer name (truncated) + revenue amount
    Click bar → /crm/customers filtered to that customer
  
  Right: Top 5 nhà cung cấp (by spend) — same structure
    Click → /vendors filtered to that vendor

Section 4 — Invoice health trend:
  Stacked bar: Hợp lệ (green) | Chờ xác thực (yellow) | Không hợp lệ (red) per month
  Shows GDT compliance improvement/degradation over time

Section 5 — AI Seasonal Insight (Gemini — load on page open, cache result):
  Card with robot icon: "Phân tích Gemini AI"
  "[Natural language seasonal insight in Vietnamese]"
  "Gợi ý: [actionable recommendation]"
  Fallback: "Đang phân tích dữ liệu..." loading state
```

### P30.4 — Build /reports/monthly/[year]/[month] page (month-end printable report)
```
[Respond in Vietnamese]
Create the complete /reports/monthly/[year]/[month] page.

Backend: GET /api/reports/monthly/:year/:month?companyId=
  Return:
  - company info: name, tax_code, address
  - output summary by VAT rate (0/5/8/10): subtotal, vat, total
  - input summary by VAT rate (0/5/8/10): subtotal, vat, total
  - VAT reconciliation lines: ct22, ct23, ct24, ct25, ct40a, ct41, ct43
  - notable items: pending_gdt_count, invalid_invoice_count, anomaly_count
  - generated_at timestamp

Page layout:

Header:
  Company name + MST
  Title: "Báo Cáo Tài Chính Tháng [MM/YYYY]"
  Generated time: [dd/MM/yyyy HH:mm]
  Actions: [In báo cáo] [Tải Excel] [Tạo tờ khai]

Section 1 — Revenue summary table:
  Columns: Thuế suất | Doanh số chưa thuế | Thuế GTGT | Tổng doanh thu
  Rows: 0% | 5% | 8% | 10% | TỔNG CỘNG
  Bold total row, VND formatting, print-friendly borders

Section 2 — Purchase summary table:
  Same structure for input invoices
  Highlight deductible VAT subtotal row

Section 3 — VAT reconciliation panel:
  [22] Tổng VAT đầu vào
  [23] VAT đầu vào đủ điều kiện khấu trừ
  [24] VAT còn được khấu trừ kỳ trước chuyển sang
  [25] Tổng VAT được khấu trừ
  [40a] Tổng VAT đầu ra
  [41] VAT phải nộp kỳ này
  [43] VAT còn được khấu trừ chuyển kỳ sau

  Color rules:
    ct41 > 0 → red/orange emphasis
    ct43 > 0 → green emphasis

Section 4 — Notable items / alerts:
  - HĐ chưa xác thực GDT: [count] → link to filtered invoice list
  - HĐ không hợp lệ: [count]
  - Bất thường AI: [count] → link /audit/anomalies
  - Gợi ý ngắn: "Cần kiểm tra trước khi nộp tờ khai" if any warning count > 0

Section 5 — Print optimization:
  A4 portrait layout
  Hide navigation/header/footer app chrome in print mode
  Keep tables on page where possible, avoid row breaking

If the API has no monthly data yet:
  Show empty state with CTA:
  "Chưa có đủ dữ liệu để lập báo cáo tháng này" + [Đồng bộ ngay]
```

