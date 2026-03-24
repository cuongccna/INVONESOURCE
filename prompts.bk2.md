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
