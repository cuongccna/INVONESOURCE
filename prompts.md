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

Correct emission factors (kgCO2e per 1 MILLION VND spent):
  'Năng lượng & Nhiên liệu'    : 0.85
  'Vận tải & Logistics'        : 0.62
  'Vật tư sản xuất'            : 0.45
  'Dịch vụ'                    : 0.12
  'Văn phòng phẩm'             : 0.18
  'Xây dựng & Bất động sản'    : 0.38
  'Thực phẩm & F&B'            : 0.28
  'Khác'                        : 0.20  ← default

Example: 700 triệu VND spend × 0.20 factor / 1,000,000 × 1,000,000 / 1000 = 140 tCO2e (NOT 336,900)

The correct total for a typical 700M VND input invoice month should be roughly 100–300 tCO2e.

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


---

## GROUP 31 — CRITICAL BUGFIXES (FIX TRƯỚC MỌI THỨ KHÁC)

### FIX-01 — Numeric field overflow (BLOCKING — Viettel sync fails)
```
[Respond in Vietnamese]
CRITICAL BUG: Viettel sync shows "numeric field overflow" error (screenshot: connector page).
Some invoices from Viettel have very large total amounts that exceed NUMERIC(18,2) limit.

Fix 1 — DB migration /scripts/008_fix_numeric_overflow.sql:
ALTER TABLE invoices
  ALTER COLUMN subtotal     TYPE NUMERIC(22,2),
  ALTER COLUMN vat_amount   TYPE NUMERIC(22,2),
  ALTER COLUMN total_amount TYPE NUMERIC(22,2);

ALTER TABLE invoice_line_items
  ALTER COLUMN unit_price TYPE NUMERIC(22,4),
  ALTER COLUMN subtotal   TYPE NUMERIC(22,2),
  ALTER COLUMN total      TYPE NUMERIC(22,2);

ALTER TABLE vat_reconciliations
  ALTER COLUMN output_vat  TYPE NUMERIC(22,2),
  ALTER COLUMN input_vat   TYPE NUMERIC(22,2),
  ALTER COLUMN payable_vat TYPE NUMERIC(22,2);

ALTER TABLE tax_declarations
  ALTER COLUMN ct22_total_input_vat    TYPE NUMERIC(22,0),
  ALTER COLUMN ct23_deductible_input_vat TYPE NUMERIC(22,0),
  ALTER COLUMN ct25_total_deductible   TYPE NUMERIC(22,0),
  ALTER COLUMN ct29_total_revenue      TYPE NUMERIC(22,0),
  ALTER COLUMN ct40_total_output_revenue TYPE NUMERIC(22,0),
  ALTER COLUMN ct40a_total_output_vat  TYPE NUMERIC(22,0),
  ALTER COLUMN ct41_payable_vat        TYPE NUMERIC(22,0),
  ALTER COLUMN ct43_carry_forward_vat  TYPE NUMERIC(22,0);

Fix 2 — Add validation in ViettelConnector.ts normalizeInvoice():
  const MAX_SAFE_AMOUNT = 999_999_999_999 // 999 tỷ VND is already unrealistic
  if (totalAmount > MAX_SAFE_AMOUNT) {
    logger.warn(`[viettel] Suspicious amount ${totalAmount} on invoice ${invoiceNumber} — capping and flagging`)
    return { ...invoice, total_amount: totalAmount, needs_review: true }
  }

Fix 3 — After running migration: retry all failed Viettel sync jobs:
  UPDATE company_connectors SET consecutive_failures=0, circuit_state='CLOSED'
  WHERE provider='viettel';
  Then trigger manual sync.
```

### FIX-02 — Vietnamese number formatting (ALL charts and reports broken)
```
[Respond in Vietnamese]
CRITICAL BUG: Numbers display incorrectly everywhere:
  "10.000.000.000M" → should be "10.000 tỷ đ"
  "100000.0Tỷ" → should be "100.000 tỷ đ"  
  "19.183.017.446.294.900" → should be "19.183 nghìn tỷ đ"
  "10000000.0Tỷ" → clearly wrong scaling

Create /frontend/utils/formatCurrency.ts — the SINGLE source of truth for all VND formatting:

export function formatVND(amount: number | null | undefined): string {
  if (!amount || isNaN(amount)) return '0đ'
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  
  if (abs >= 1_000_000_000_000) {  // >= 1 nghìn tỷ
    return `${sign}${(abs / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '')} nghìn tỷ`
  }
  if (abs >= 1_000_000_000) {      // >= 1 tỷ
    return `${sign}${(abs / 1_000_000_000).toFixed(1).replace(/\.0$/, '')} tỷ`
  }
  if (abs >= 1_000_000) {          // >= 1 triệu
    return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')} Tr`
  }
  // < 1 triệu: show full with dot separator
  return `${sign}${Math.round(abs).toLocaleString('vi-VN')}đ`
}

// For chart Y-axis labels (shorter)
export function formatVNDShort(amount: number): string {
  if (Math.abs(amount) >= 1_000_000_000_000) return `${(amount/1_000_000_000_000).toFixed(0)}nghìntỷ`
  if (Math.abs(amount) >= 1_000_000_000) return `${(amount/1_000_000_000).toFixed(0)}Tỷ`
  if (Math.abs(amount) >= 1_000_000) return `${(amount/1_000_000).toFixed(0)}Tr`
  return `${(amount/1_000).toFixed(0)}K`
}

// For full display in tables
export function formatVNDFull(amount: number): string {
  return Math.round(amount).toLocaleString('vi-VN') + 'đ'
}

REPLACE every instance of currency formatting throughout the app with these functions.
Search for: toLocaleString, toFixed, "Tỷ", "Trđ", "M", chart Y-axis formatters
Replace ALL with calls to formatVND() or formatVNDShort().

Also fix Chart.js Y-axis in all chart components:
  yAxis: { ticks: { callback: (v) => formatVNDShort(v) } }
```

### FIX-03 — Tập đoàn / Nhóm creation fails (empty state, button does nothing)
```
[Respond in Vietnamese]
BUG: /settings/organizations page shows empty state. "Tạo nhóm mới" button fails silently.
Diagnose and fix in order:

Step 1 — Check if organizations table exists:
  Run: SELECT tablename FROM pg_tables WHERE tablename='organizations';
  If missing: run migration to create it:
  CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(50),
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS organization_members (
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID FK REFERENCES users(id),
    role ENUM('OWNER','ADMIN','MEMBER') DEFAULT 'MEMBER',
    PRIMARY KEY (organization_id, user_id)
  );
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS 
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    level SMALLINT DEFAULT 1;

Step 2 — Check backend route exists:
  GET  /api/organizations          → list user's organizations
  POST /api/organizations          → create new organization
  PUT  /api/organizations/:id      → update
  DELETE /api/organizations/:id    → delete
  POST /api/organizations/:id/companies  → add company to org
  
  If routes missing: create /backend/src/routes/organizations.ts with all routes.
  Each route requires JWT auth + ownership check.

Step 3 — Fix the frontend form:
  "Tạo nhóm mới" button must open a modal with:
    - Tên tập đoàn/nhóm (required)
    - Tên viết tắt (optional)
    - Mô tả (optional)
    - After create: auto-navigate to /settings/organizations/:id
  
  After organization created: show company picker to add companies to the group.

Step 4 — Fix the organization detail page /settings/organizations/:id:
  - Edit org info
  - Visual company tree (indent by level)
  - "+ Thêm công ty vào nhóm" → search existing companies by name/MST
  - Set parent relationship (which company is parent of which)
```

### FIX-04 — Dashboard chart scale wrong (shows 0000000 and exponential curve)
```
[Respond in Vietnamese]
BUG: Dashboard "Doanh Thu / Chi Phí" chart shows Y-axis as "0000000" 
and data as exponential spike only in the last month.

Root causes:
1. Y-axis formatter not applied → raw numbers render as "10000000"
2. Only 1 month has data → line chart shows as a spike from zero
3. Chart not handling empty months properly

Fix the revenue trend chart component:

1. Apply formatVNDShort() to Y-axis (from FIX-02):
  options.scales.y.ticks.callback = (v) => formatVNDShort(Number(v))

2. Handle months with no data: fill missing months with 0 (don't skip):
  // Generate all months in range, fill 0 for missing
  const allMonths = generateMonthRange(from, to)  // ['T6/25','T7/25',...,'T3/26']
  const data = allMonths.map(m => monthlyData[m]?.revenue ?? 0)

3. For single-month data (only T3/2026): show as bar chart not line chart.
  Auto-detect: if dataPoints <= 2 → use bar chart instead of line

4. Fix Phân Tích Xu Hướng page (reports/trends):
  Same fix: Y-axis formatter + fill empty months with 0
  "Cao điểm: T3/26" badge logic: only show if data spans >= 3 months

5. Fix Top 5 customers horizontal bar chart:
  Labels: truncate to 18 chars max
  Values: use formatVND() not raw numbers
  "võ Đông hà: 10.000.000.000M" → should be "10 tỷ" or correct amount
```

### FIX-05 — GDT Validation: 150,728 of 150,751 invoices unvalidated
```
[Respond in Vietnamese]
BUG: Dashboard shows "Chờ Xét Duyệt GDT: 150,728" — almost ALL invoices unvalidated.
This means the GDT validation queue is not running or is stuck.

Diagnose:
1. Check if gdt-validate-queue has jobs:
   redis-cli LLEN bull:gdt-validate-queue:wait
   If 0: queue was never populated.

2. Check BullMQ worker is running:
   Look in /backend/src/jobs/ — is GdtValidationWorker registered in app startup?
   If not: add worker.process() call in server initialization.

3. The actual fix — GDT validation for Viettel invoices:
   Viettel invoice format: C26TVI201390 (format: C{year}{provider}{number})
   These are "mã không có CQT" (without tax authority code).
   
   IMPORTANT: For invoices WITHOUT mã CQT (identified by serial starting with "C"):
     - Cannot be validated via GDT portal individually
     - Should be validated through Viettel's own verification system
     - Set gdt_validated = true for all Viettel invoices by default
       (Viettel as a licensed provider guarantees authenticity)
   
   Update GdtValidationWorker:
     if (invoice.provider === 'viettel') {
       await db.query("UPDATE invoices SET gdt_validated=true WHERE id=$1", [invoice.id])
       return  // skip GDT portal check for Viettel
     }
   
   For MISA invoices (have mã CQT): validate via GDT portal normally.
   
4. Run bulk update for existing Viettel invoices:
   UPDATE invoices SET gdt_validated=true, gdt_validated_at=NOW()
   WHERE provider='viettel' AND gdt_validated=false;
   
   This will immediately fix the "150,728 chờ GDT" counter.
```

### FIX-06 — Monthly report table layout broken on mobile
```
[Respond in Vietnamese]
BUG: /reports/monthly page shows table columns "BÁN RA (ĐẦU RA)" and "MUA VÀO (ĐẦU VÀO)"
with truncated text and numbers overflowing: "19.183.017.446.294.900" unreadable.

Fix 1 — Apply formatVNDFull() from FIX-02 to all table cells.

Fix 2 — Redesign table for mobile (card-based instead of table):
  Desktop: keep as table with fixed column widths
    table-layout: fixed
    col widths: Loại(80px) | Số lượng(90px) | Tiền hàng(120px) | Thuế(100px)
  
  Mobile (< 768px): convert to card layout:
    Each row becomes a card:
    [Arrow icon] Bán ra (đầu ra)
    Số HĐ: 150,738 | Tiền hàng: 19.183 tỷ | Thuế: 1.398 tỷ

Fix 3 — Mua vào shows "0" for subtotal — this is wrong if input invoices exist:
  Check query: ensure direction='input' filter is correct
  Debug: SELECT COUNT(*), SUM(total_amount) FROM invoices 
         WHERE company_id=X AND direction='input' AND invoice_date BETWEEN...

Fix 4 — "In báo cáo" button:
  Add @media print CSS to hide navigation, show full report
  print: { nav: display:none, content: width:100%, font-size:12px }
```

---

## GROUP 32 — ARCHITECTURAL PIVOT: REMOVE PROVIDER CONNECTORS, ADD GDT BOT + MANUAL IMPORT

### ARCH-01 — Remove MISA / Viettel / BKAV connectors (keep structure, disable)
```
[Respond in Vietnamese]
ARCHITECTURAL CHANGE: MISA, Viettel, BKAV connectors are being DISABLED — not deleted.
Keep all code but mark as deprecated. Replace with GDT-based sources.

Reason: These providers only store invoices they ISSUED for a specific company.
They cannot provide INPUT invoices (purchases from other vendors).
Only GDT (hoadondientu.gdt.gov.vn) has both input and output invoices for any company.

Step 1 — Soft-disable connectors in DB:
  ALTER TYPE connector_provider ADD VALUE IF NOT EXISTS 'gdt_bot';
  ALTER TYPE connector_provider ADD VALUE IF NOT EXISTS 'manual_import';
  
  UPDATE company_connectors 
  SET enabled = false, 
      notes = 'Disabled: provider only stores outgoing invoices. Use GDT Bot instead.'
  WHERE provider IN ('misa', 'viettel', 'bkav');

Step 2 — Hide from UI (don't delete):
  In /settings/connectors page:
  - Move MISA/Viettel/BKAV to a collapsed "Kết nối nhà mạng (Hạn chế)" section
  - Show info banner: "Các nhà mạng chỉ cung cấp HĐ đầu ra. Để có đầy đủ HĐ đầu vào + đầu ra, 
    sử dụng GDT Bot hoặc Import thủ công từ cổng thuế."
  - Keep toggle to re-enable if user wants partial data (outgoing only)

Step 3 — Update onboarding flow:
  Remove MISA/Viettel/BKAV as primary connection options
  New primary options: GDT Bot | Import thủ công
  Keep provider connectors as secondary/optional

Step 4 — Update dashboard warning:
  If company only has provider connectors (no GDT source):
  Show banner: "⚠️ Dữ liệu chưa đầy đủ: chỉ có HĐ đầu ra. Thiết lập GDT Bot để có báo cáo chính xác."

Do NOT delete ConnectorPlugin interface or BaseConnector — keep for future use.
```

---

## GROUP 33 — GDT CRAWLER BOT (SEPARATE MODULE)

### BOT-01 — GDT Bot architecture and technical approach
```
[Respond in Vietnamese]
Create a standalone GDT crawler bot as a SEPARATE module that runs independently.
This bot logs into hoadondientu.gdt.gov.vn on behalf of the business owner and
downloads all their invoices (both input AND output).

Architecture decision:
  The bot is a separate Node.js process, NOT part of the main Express server.
  It runs on a schedule and pushes data into the shared PostgreSQL database.
  Communication: bot writes to invoices table → main app reads from it.

Bot location: /bot/ directory at project root (separate from /backend and /frontend)

Technical approach for hoadondientu.gdt.gov.vn:
  The portal uses NNT (Người Nộp Thuế) login with:
    - MST (Mã số thuế)
    - Password (đặt bởi doanh nghiệp trên cổng thuế)
    - OTP (nếu có bật 2FA — optional)
  
  After login, user can:
    - View HĐ đầu ra: /tra-cuu-hoa-don-ban-ra
    - View HĐ đầu vào: /tra-cuu-hoa-don-mua-vao
    - Export: XML (chi tiết từng HĐ) hoặc Excel (tổng hợp)
  
  Bot strategy: Use Playwright (headless Chromium) to:
    1. Login with MST + password
    2. Navigate to invoice search pages
    3. Set date range filter
    4. Export XML/Excel file
    5. Parse downloaded file
    6. Insert to invoices table

Create /bot/package.json:
  Dependencies: playwright@1.40, pg, redis, winston, cron, dotenv
  Script: "start": "node src/index.js", "dev": "nodemon src/index.ts"

/bot/src/index.ts: main entry, loads credentials from DB, schedules runs
/bot/src/GdtBotRunner.ts: core bot logic (see BOT-02)
/bot/src/parsers/: XML and Excel parsers
/bot/src/db.ts: shared DB connection (same DATABASE_URL as main app)
```

### BOT-02 — GDT Bot core crawler implementation
```
[Respond in Vietnamese]
Create /bot/src/GdtBotRunner.ts — the main Playwright crawler.

import { chromium, Browser, Page } from 'playwright'

const GDT_BASE = 'https://hoadondientu.gdt.gov.vn'

export class GdtBotRunner {
  private browser: Browser | null = null
  private page: Page | null = null

  async run(config: BotConfig): Promise<BotResult> {
    const startTime = Date.now()
    try {
      await this.init()
      await this.login(config.taxCode, config.password)
      
      // Run both directions in sequence (not parallel — same session)
      const outputResult = await this.crawlInvoices('output', config)
      const inputResult  = await this.crawlInvoices('input', config)
      
      return {
        success: true,
        outputCount: outputResult.count,
        inputCount: inputResult.count,
        durationMs: Date.now() - startTime
      }
    } catch (error) {
      return { success: false, error: error.message, durationMs: Date.now() - startTime }
    } finally {
      await this.cleanup()
    }
  }

  private async init() {
    this.browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
    this.page = await this.browser.newPage()
    // Set Vietnamese locale and realistic user agent
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9' })
  }

  private async login(taxCode: string, password: string) {
    await this.page.goto(`${GDT_BASE}/nnt/login`, { waitUntil: 'networkidle' })
    
    // Fill MST field
    await this.page.fill('input[name="username"], input[placeholder*="mã số thuế"], #username', taxCode)
    await this.page.fill('input[type="password"]', password)
    await this.page.click('button[type="submit"], .btn-login')
    
    // Wait for dashboard or detect error
    await this.page.waitForTimeout(2000)
    const errorMsg = await this.page.$('.error-message, .alert-danger')
    if (errorMsg) {
      const text = await errorMsg.textContent()
      throw new Error(`GDT login failed: ${text}`)
    }
    
    // Handle OTP if present
    const otpInput = await this.page.$('input[placeholder*="OTP"], #otp')
    if (otpInput) {
      // OTP required — notify user via push notification and pause
      await this.notifyOtpRequired(taxCode)
      throw new Error('OTP_REQUIRED: Manual intervention needed')
    }
    
    logger.info(`[GDT Bot] Login successful for MST: ${taxCode}`)
  }

  private async crawlInvoices(direction: 'input' | 'output', config: BotConfig) {
    const urlPath = direction === 'output' 
      ? '/nnt/hoa-don-ban-ra' 
      : '/nnt/hoa-don-mua-vao'
    
    await this.page.goto(`${GDT_BASE}${urlPath}`, { waitUntil: 'networkidle' })
    
    // Set date range filter
    const fromStr = formatDate(config.fromDate)  // dd/MM/yyyy
    const toStr   = formatDate(config.toDate)
    await this.page.fill('input[placeholder*="từ ngày"], #fromDate', fromStr)
    await this.page.fill('input[placeholder*="đến ngày"], #toDate', toStr)
    await this.page.click('button.btn-search, button[type="submit"]')
    await this.page.waitForTimeout(3000)
    
    // Check total count
    const totalText = await this.page.textContent('.total-records, .record-count')
    const total = parseInt(totalText?.match(/\d+/)?.[0] ?? '0')
    logger.info(`[GDT Bot] Found ${total} ${direction} invoices`)
    
    if (total === 0) return { count: 0, invoices: [] }
    
    // Export XML (preferred — has full detail)
    const xmlData = await this.exportXML(direction)
    if (xmlData) {
      const invoices = await parseGdtXml(xmlData, direction, config.companyId)
      await bulkUpsertInvoices(invoices)
      return { count: invoices.length }
    }
    
    // Fallback: Export Excel if XML fails
    const excelData = await this.exportExcel(direction)
    const invoices = await parseGdtExcel(excelData, direction, config.companyId)
    await bulkUpsertInvoices(invoices)
    return { count: invoices.length }
  }

  private async exportXML(direction: string): Promise<Buffer | null> {
    try {
      // Click export XML button
      const downloadPromise = this.page.waitForEvent('download', { timeout: 30000 })
      await this.page.click('button[title*="XML"], .export-xml, a:has-text("Xuất XML")')
      const download = await downloadPromise
      const buffer = await download.createReadStream().then(stream => {
        return new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = []
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
          stream.on('end', () => resolve(Buffer.concat(chunks)))
          stream.on('error', reject)
        })
      })
      return buffer
    } catch {
      return null
    }
  }
}

// Schedule: run every 6 hours for each active bot config
// Store credentials encrypted in bot_configs table (separate from company_connectors)
```

### BOT-03 — GDT Bot XML parser (chuẩn TT78/2021)
```
[Respond in Vietnamese]
Create /bot/src/parsers/GdtXmlParser.ts

GDT export XML follows TT78/2021 standard. Parse the downloaded XML file.

The GDT XML structure for invoice list:
<DSHDon>                          <!-- Danh sách hóa đơn -->
  <HDon>                          <!-- Một hóa đơn -->
    <TTChung>                     <!-- Thông tin chung -->
      <SHDon>                     <!-- Số hóa đơn -->
      <MHDon>                     <!-- Mẫu số hóa đơn -->
      <KHHDon>                    <!-- Ký hiệu hóa đơn (serial) -->
      <NLap>                      <!-- Ngày lập (dd/MM/yyyy or yyyy-MM-dd) -->
      <DVTTe>                     <!-- Đơn vị tiền tệ (VND) -->
    </TTChung>
    <NDHDon>                      <!-- Nội dung hóa đơn -->
      <NBan>                      <!-- Người bán -->
        <MST>                     <!-- Mã số thuế người bán -->
        <Ten>                     <!-- Tên người bán -->
        <DChi>                    <!-- Địa chỉ -->
      </NBan>
      <NMua>                      <!-- Người mua -->
        <MST>                     <!-- Mã số thuế người mua -->
        <Ten>                     <!-- Tên người mua -->
      </NMua>
      <DSHHDVu>                   <!-- Danh sách hàng hóa dịch vụ -->
        <HHDVu>                   <!-- Chi tiết từng dòng -->
          <MHHDVu>                <!-- Mã hàng -->
          <THHDVu>                <!-- Tên hàng -->
          <DVTinh>                <!-- Đơn vị tính -->
          <SLuong>                <!-- Số lượng -->
          <DGia>                  <!-- Đơn giá -->
          <ThTien>                <!-- Thành tiền (chưa thuế) -->
          <TSuat>                 <!-- Thuế suất (0%,5%,8%,10%,KCT) -->
          <TienThue>              <!-- Tiền thuế -->
        </HHDVu>
      </DSHHDVu>
      <TToan>                     <!-- Thanh toán -->
        <THTTLTSuat>              <!-- Theo từng thuế suất -->
          <LTSuat>
            <TSuat>               <!-- Thuế suất -->
            <TienHang>            <!-- Doanh số -->
            <TienThue>            <!-- Tiền thuế -->
        <TgTCThue>                <!-- Tổng giá trị chưa thuế -->
        <TgTThue>                 <!-- Tổng tiền thuế -->
        <TgTTTBSo>                <!-- Tổng thanh toán bằng số -->
    </NDHDon>
    <TTKTThue>                    <!-- Trạng thái kiểm tra thuế -->
      <TCTBao>                    <!-- Trạng thái: 1=hợp lệ, 3=hủy, 5=thay thế -->
  </HDon>
</DSHDon>

Parse function: parseGdtXml(xmlBuffer: Buffer, direction: 'input'|'output', companyId: string): NormalizedInvoice[]

Handle:
  - Date formats: 'dd/MM/yyyy', 'yyyy-MM-dd', 'dd-MM-yyyy' (GDT exports vary)
  - VAT rate formats: '10%', '10', 'KCT' (không chịu thuế → 0), 'KKKTT' → 0
  - Status mapping: TCTBao '1'→valid, '3'→cancelled, '5'→replaced, '6'→adjusted
  - buyer_tax_code may be empty (B2C transactions — set to 'B2C')
  - Also parse line items into invoice_line_items
  - Set source = 'gdt_bot', gdt_validated = true (GDT data is by definition validated)

Error handling: if one invoice fails to parse, log and skip — don't abort entire file.
Return count of successfully parsed vs total in file.
```

### BOT-04 — GDT Bot Excel/CSV parser (fallback format)
```
[Respond in Vietnamese]
Create /bot/src/parsers/GdtExcelParser.ts — parse GDT Excel export (fallback when XML fails).

GDT Excel export for HĐ bán ra has these columns (Vietnamese headers):
  STT | Mẫu số | Ký hiệu | Số HĐ | Ngày lập | Tên người mua | MST người mua |
  Tổng tiền chưa thuế | Thuế suất | Tiền thuế | Tổng tiền thanh toán | Trạng thái

GDT Excel export for HĐ mua vào:
  STT | Mẫu số | Ký hiệu | Số HĐ | Ngày lập | Tên người bán | MST người bán |
  Tổng tiền chưa thuế | Thuế suất | Tiền thuế | Tổng tiền thanh toán | Trạng thái

Use SheetJS (xlsx): npm install xlsx

async function parseGdtExcel(
  buffer: Buffer, 
  direction: 'input' | 'output',
  companyId: string
): Promise<NormalizedInvoice[]>

Steps:
  1. Read workbook: XLSX.read(buffer, { type: 'buffer' })
  2. Find correct sheet (usually first sheet or named "Danh sách HĐ")
  3. Get headers from row 1, detect column positions by header text matching
     (GDT may change column order between exports — NEVER hardcode column indices)
  4. Parse each data row:
     - Skip rows where STT is empty or non-numeric (subtotal rows, blank rows)
     - Map column names flexibly: 
       "Số HĐ" | "Số hóa đơn" | "SỐ HĐ" → invoice_number
       "MST người mua" | "MST người bán" → partner_tax_code
       "Ngày lập" | "Ngày hóa đơn" → invoice_date
     - Parse date: try multiple formats (dd/MM/yyyy, dd-MM-yyyy, Excel serial number)
     - Parse VAT rate: "10%" → 10, "5%" → 5, "KCT" | "0%" | "KKKTT" → 0
     - Parse status: "Hợp lệ" → valid, "Đã hủy" → cancelled, "Thay thế" → replaced
  5. NOTE: Excel export has NO line items — only header totals
     Set has_line_items = false, schedule XML re-fetch for line item detail
  
  Return array of NormalizedInvoice with source='gdt_bot', gdt_validated=true
```

### BOT-05 — Bot management UI + credentials storage
```
[Respond in Vietnamese]
Create the bot management interface and secure credential storage.

1. DB Migration /scripts/009_gdt_bot.sql:
CREATE TABLE gdt_bot_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  tax_code VARCHAR(20) NOT NULL,
  password_encrypted TEXT NOT NULL,       -- AES-256-GCM encrypted
  has_otp BOOLEAN DEFAULT false,
  otp_method VARCHAR(20),                 -- 'sms' | 'email' | 'app'
  is_active BOOLEAN DEFAULT true,
  sync_frequency_hours SMALLINT DEFAULT 6,
  last_run_at TIMESTAMPTZ,
  last_run_status VARCHAR(20),            -- 'success' | 'error' | 'otp_required'
  last_run_output_count INT DEFAULT 0,
  last_run_input_count INT DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id)
);

2. Frontend: /settings/connectors — GDT Bot section (PRIMARY, shown first):
  Card title: "GDT Crawler Bot" with green "Nguồn chính" badge
  
  Status states:
    Not configured: Blue "Thiết lập" button
    Active: Green dot + "Đang hoạt động" + last sync time + counts
    Error: Red dot + error message + "Xem chi tiết" + "Thử lại"
    OTP Required: Orange dot + "Cần xác thực OTP" + manual intervention button
  
  Setup form (modal):
    Mã số thuế DN: text (pre-filled from company.tax_code)
    Mật khẩu cổng thuế: password field
      Note: "Đây là mật khẩu đăng nhập hoadondientu.gdt.gov.vn (khác mật khẩu MISA/Viettel)"
    Bật xác thực 2 bước: toggle (if yes, ask for OTP method)
    Tần suất đồng bộ: select [Mỗi 6 giờ | Mỗi 12 giờ | Mỗi 24 giờ | Thủ công]
    
  After save: immediately trigger first bot run + show progress

3. API endpoints:
  POST /api/bot/setup          → save config (encrypt password), trigger first run
  POST /api/bot/run-now        → trigger immediate sync
  GET  /api/bot/status         → current status + last run stats
  DELETE /api/bot/config       → remove config (confirm dialog)
  POST /api/bot/submit-otp     → for OTP verification flow

4. Security note in UI:
  "Thông tin đăng nhập được mã hóa AES-256 và chỉ dùng để kết nối cổng thuế.
  Chúng tôi không lưu mật khẩu dạng văn bản thô."
```

### BOT-06 — OTP handling flow
```
[Respond in Vietnamese]
Handle OTP requirement gracefully when GDT portal has 2FA enabled.

When bot detects OTP screen during login:
  1. Save session state (cookies) to Redis with TTL 10 minutes
  2. Create notification: type='OTP_REQUIRED', companyId, botConfigId
  3. Send push notification + Telegram:
     "🔐 GDT Bot cần xác thực OTP
     Công ty: [company name]
     Vui lòng mở app và nhập mã OTP để tiếp tục đồng bộ."
  4. Set bot status: 'otp_required'

Frontend OTP modal (triggered by notification or bot status card):
  - Show OTP input (6 digits)
  - Countdown: "Phiên làm việc hết hạn sau: 8:34"
  - "Gửi mã OTP" button → POST /api/bot/submit-otp { botConfigId, otp }

Backend OTP submission:
  1. Retrieve saved browser session from Redis
  2. Resume Playwright session
  3. Fill OTP input on GDT page
  4. Continue crawling
  5. Clear Redis session

If session expired (>10 min): restart full login flow from beginning.

Alternative for users who don't want OTP interruption:
  Offer to disable 2FA on GDT portal (show instructions link).
  Or: set sync time to specific hours when user is available to enter OTP.
```

---

## GROUP 34 — MANUAL IMPORT MODULE (FLEXIBLE)

### IMP-01 — Import module architecture + supported formats
```
[Respond in Vietnamese]
Create a flexible manual import module. Users download their invoice data from
hoadondientu.gdt.gov.vn and import it into the app.

Why manual import is needed:
  - Fallback when bot is not set up or fails
  - Users who don't want to share GDT credentials
  - One-time historical data import
  - Accountants who already have Excel exports from tax portal

Supported import formats:
  FORMAT 1: XML từ cổng thuế (chi tiết, preferred)
    - File: downloaded from GDT portal "Xuất XML"
    - Contains: full invoice detail + line items
    - Parser: reuse GdtXmlParser from BOT-03
    
  FORMAT 2: Excel từ cổng thuế (tổng hợp)
    - File: .xlsx downloaded from GDT portal "Xuất Excel"  
    - Contains: header data only, no line items
    - Parser: reuse GdtExcelParser from BOT-04
    
  FORMAT 3: CSV từ cổng thuế
    - File: .csv from GDT or converted from Excel
    - Same columns as Excel format
    - Parser: new CsvParser using csv-parse library
    
  FORMAT 4: XML chuẩn HTKK (từ phần mềm HTKK)
    - File: exported from HTKK software for tax declaration
    - Structure similar to GDT XML but different root tags
    
  FORMAT 5: Excel tùy chỉnh (cấu trúc linh hoạt)
    - User-defined Excel with column mapping
    - Allow user to map their columns to system fields
    - "Cột A là Số HĐ, Cột B là Ngày lập..."

DB table for import history:
CREATE TABLE import_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  user_id UUID REFERENCES users(id),
  filename VARCHAR(500),
  format VARCHAR(30),         -- 'gdt_xml'|'gdt_excel'|'csv'|'htkk_xml'|'custom_excel'
  direction VARCHAR(10),      -- 'input'|'output'|'both'|'auto_detect'
  period_month SMALLINT,
  period_year SMALLINT,
  total_rows INT,
  success_count INT DEFAULT 0,
  error_count INT DEFAULT 0,
  duplicate_count INT DEFAULT 0,
  error_details JSONB,        -- [{row, field, message}]
  status VARCHAR(20),         -- 'processing'|'completed'|'failed'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### IMP-02 — Import UI — drag-and-drop upload flow
```
[Respond in Vietnamese]
Create /import page — the complete manual import interface.

Page layout:

Header: "Import Hóa Đơn" + "Lịch sử import" button (link to import_sessions list)

Section 1 — Upload area:
  Large drag-and-drop zone (dotted border, dashed):
    Cloud upload icon (24px SVG)
    "Kéo thả file hoặc click để chọn"
    Supported: "XML · Excel (xlsx) · CSV · HTKK XML"
    Max file size: 50MB
  
  After file selected:
    Show file name + size + auto-detected format badge
    Show: "Phát hiện: [format name] — [X hóa đơn tìm thấy]"

Section 2 — Import settings (shown after file selected):
  Chiều hóa đơn:
    Auto detect (từ file) | Đầu ra (bán hàng) | Đầu vào (mua hàng)
  Kỳ (tháng/năm): pre-filled from file dates, editable
  Xử lý trùng lặp:
    Bỏ qua HĐ đã tồn tại (default) | Cập nhật nếu có thay đổi | Hỏi từng trường hợp

Section 3 — Preview (after parsing):
  Show first 5 rows in a preview table with columns:
    Số HĐ | Ngày | Đối tác | Tiền | VAT | Chiều | Trạng thái
  
  Summary: "Tìm thấy 245 hóa đơn: 230 mới · 12 đã tồn tại · 3 lỗi"
  
  If errors: show expandable error list:
    "Dòng 45: Ngày '32/13/2026' không hợp lệ"
    "Dòng 67: MST '123abc' sai định dạng"
  
  "Xem trước đầy đủ" link: show all parsed rows in scrollable table

Section 4 — Action buttons:
  [Nhập X hóa đơn hợp lệ] (primary, disabled if 0 valid)
  [Hủy]
  
  Progress bar (during import):
    "Đang nhập... 145/245 hóa đơn"
    Cancel button

Section 5 — Result (after import):
  Success card: "✅ Nhập thành công 242 hóa đơn"
  Stats: X mới | Y cập nhật | Z bỏ qua (trùng) | W lỗi
  "Xem hóa đơn vừa nhập" → /invoices?importSessionId=X
  "Nhập file khác" button
```

### IMP-03 — Custom Excel column mapping (Format 5)
```
[Respond in Vietnamese]
Create a flexible column mapping interface for non-standard Excel files.
This handles cases where users have their own Excel format or exported from other software.

Triggered when: auto-detection fails OR user selects "Excel tùy chỉnh" format.

Step 1 — Show detected columns from Excel:
  "Phát hiện X cột trong file: [Cột A, Cột B, Cột C, ...]"
  Show first 3 rows as preview

Step 2 — Column mapping UI:
  For each REQUIRED system field, show a dropdown of file columns:
  
  Required fields:
    Số hóa đơn * → [dropdown: select column from file]
    Ngày lập * → [dropdown]
    Tổng tiền * → [dropdown]
  
  Optional fields:
    Ký hiệu HĐ → [dropdown or "Bỏ qua"]
    MST đối tác → [dropdown or "Bỏ qua"]
    Tên đối tác → [dropdown or "Bỏ qua"]
    Thuế suất → [dropdown or "Nhập cố định: [input]"]
    Tiền thuế → [dropdown or "Tính tự động"]
    Chiều HĐ → [dropdown or "Tất cả là đầu ra/đầu vào"]
  
  Date format selector: dd/MM/yyyy | yyyy-MM-dd | MM/dd/yyyy | Auto detect
  Decimal separator: Dấu chấm (1,234.56) | Dấu phẩy (1.234,56)

Step 3 — Save mapping as template:
  "Lưu cấu hình này cho lần sau" checkbox
  Template name: text input
  
  Saved to: import_templates(company_id, name, column_mapping JSON)
  Next time user uploads similar file: "Áp dụng cấu hình đã lưu: [template name]?"

Step 4 — Preview with mapping applied:
  Show 5 rows parsed with the mapping
  Highlight any parse errors in red
  Allow user to fix mapping and re-preview

Backend: POST /api/import/preview { fileId, mapping, format }
         POST /api/import/execute { fileId, mapping, format, settings }
```

### IMP-04 — Import history + re-import
```
[Respond in Vietnamese]
Create /import/history page — audit trail of all imports.

Table columns: 
  Thời gian | File | Định dạng | Kỳ | Nhập vào | Trùng lặp | Lỗi | Trạng thái | Người thực hiện

Row actions:
  [Xem chi tiết] → expand error list, show sample parsed rows
  [Xem HĐ đã nhập] → /invoices filtered to this import session
  [Xóa & Nhập lại] → delete invoices from this session + re-import modal

Import session detail modal:
  File info: name, size, format, upload time
  Processing stats: total / success / duplicate / error
  Error log (if any): row number + field + error message
  Sample of imported invoices (first 5): preview table
  Download error report: Excel with error rows highlighted

Backend:
  GET /api/import/sessions?companyId=&page=1
  GET /api/import/sessions/:id/details
  DELETE /api/import/sessions/:id → soft-delete invoices with import_session_id=X
    Require confirmation: "Xóa sẽ xóa X hóa đơn đã nhập từ session này. Không thể hoàn tác."
```

### IMP-05 — Step-by-step guide: how to export from GDT portal
```
[Respond in Vietnamese]
Create a help modal "Hướng dẫn xuất file từ cổng thuế" — shown when user opens /import.

The guide should be a visual stepper (5 steps) explaining how to get the file:

Step 1 — Đăng nhập cổng thuế:
  URL: https://hoadondientu.gdt.gov.vn
  "Đăng nhập bằng MST và mật khẩu cổng thuế của doanh nghiệp"
  [Screenshot placeholder showing login form]

Step 2 — Chọn loại hóa đơn:
  HĐ đầu ra: "Tra cứu → Hóa đơn bán ra"
  HĐ đầu vào: "Tra cứu → Hóa đơn mua vào"
  Note: "Cần xuất riêng 2 file cho đầu vào và đầu ra"

Step 3 — Đặt khoảng thời gian:
  "Nhập ngày từ / đến. Khuyến nghị: không quá 3 tháng mỗi lần để file không quá lớn"

Step 4 — Xuất file:
  "Nhấn nút 'Xuất XML' để lấy file đầy đủ (bao gồm chi tiết hàng hóa)"
  "Hoặc 'Xuất Excel' nếu chỉ cần tổng hợp"
  Note: "File XML chứa nhiều thông tin hơn và cho phép phân tích chi tiết hàng hóa"

Step 5 — Upload vào hệ thống:
  "Kéo file vừa tải về vào ô upload bên dưới"

Show tip: "💡 Để tiết kiệm thời gian, hãy thiết lập GDT Bot để tự động đồng bộ mà không cần xuất thủ công"
[Thiết lập GDT Bot] button → /settings/connectors#gdt-bot

Stepper component: HTML with prev/next navigation, dot indicators
```


---

## GROUP 35 — GDT BOT: ANTI-BLOCK & SECURITY INFRASTRUCTURE

> Mục tiêu nhóm này: Xây dựng hệ thống crawl GDT an toàn, tránh bị block IP,
> không để lộ credential người dùng, xử lý captcha tự động, scale đa tenant.
> Thứ tự bắt buộc: BOT-SEC-01 → 02 → 03 → 04 → 05 → 06

---

### BOT-SEC-01 — PostgreSQL Schema: RLS + GIN Index + Credential Isolation
```
[Respond in Vietnamese]
Create migration /scripts/010_gdt_bot_security.sql

Goal: Database schema that prevents credential leakage across tenants,
uses Row-Level Security, and indexes for fast invoice search.

-- 1. Bot configs table (one per company)
CREATE TABLE IF NOT EXISTS gdt_bot_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_code         VARCHAR(20) NOT NULL,
  encrypted_creds  TEXT NOT NULL,        -- AES-256-GCM encrypted JSON
  has_otp          BOOLEAN DEFAULT false,
  otp_method       VARCHAR(20),          -- 'sms' | 'email' | 'app'
  proxy_url        TEXT,                 -- optional dedicated proxy for this tenant
  is_active        BOOLEAN DEFAULT true,
  sync_frequency_hours SMALLINT DEFAULT 6,
  last_run_at      TIMESTAMPTZ,
  last_run_status  VARCHAR(20),          -- 'success'|'error'|'otp_required'|'blocked'
  last_run_output_count INT DEFAULT 0,
  last_run_input_count  INT DEFAULT 0,
  last_error       TEXT,
  consecutive_failures  SMALLINT DEFAULT 0,
  blocked_until    TIMESTAMPTZ,          -- set when GDT blocks this account
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id)
);

-- 2. Bot run logs (audit trail)
CREATE TABLE IF NOT EXISTS gdt_bot_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id     UUID NOT NULL REFERENCES gdt_bot_configs(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL,
  direction     VARCHAR(10),            -- 'input'|'output'|'both'
  from_date     DATE,
  to_date       DATE,
  status        VARCHAR(20),
  output_count  INT DEFAULT 0,
  input_count   INT DEFAULT 0,
  duration_ms   INT,
  proxy_used    TEXT,                   -- masked: socks5://***@host:port
  error_detail  TEXT,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

-- 3. Enable Row-Level Security on gdt_bot_configs
ALTER TABLE gdt_bot_configs ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see their own company's config
CREATE POLICY gdt_bot_configs_isolation ON gdt_bot_configs
  USING (
    company_id IN (
      SELECT company_id FROM user_companies
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- Policy: service role bypasses RLS (for worker process)
CREATE POLICY gdt_bot_configs_service ON gdt_bot_configs
  TO service_role USING (true);

-- 4. GIN index on invoices for fast full-text search on seller/buyer names
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_seller_gin
  ON invoices USING GIN(to_tsvector('simple', coalesce(seller_name, '')));

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_buyer_gin
  ON invoices USING GIN(to_tsvector('simple', coalesce(buyer_name, '')));

-- 5. Composite index for the most common dashboard query
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_dashboard
  ON invoices(company_id, invoice_date DESC, direction, status)
  WHERE deleted_at IS NULL;

-- 6. Set session variable helper (called by backend before queries)
-- Usage: SELECT set_config('app.current_user_id', $userId, true);
-- This enables RLS to filter correctly per user session.

-- Note on service role:
-- The BullMQ worker (bot process) connects with WORKER_DB_URL which uses
-- a dedicated PostgreSQL role 'gdt_worker' that bypasses RLS.
-- Main app API uses 'app_user' role subject to RLS.
```

---

### BOT-SEC-02 — AES-256-GCM Encryption Service
```
[Respond in Vietnamese]
Create /bot/src/encryption.service.ts — secure credential encryption using Node.js built-in crypto only.
No external libraries. Follow the specification exactly.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12   // 96-bit IV for GCM
const TAG_LENGTH = 16  // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) throw new Error('ENCRYPTION_KEY environment variable is not set')
  if (hex.length !== 64) throw new Error(`ENCRYPTION_KEY must be 64 hex characters (32 bytes), got ${hex.length}`)
  return Buffer.from(hex, 'hex')
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ])
  const authTag = cipher.getAuthTag()
  
  // Format: "iv_base64:authTag_base64:ciphertext_base64"
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64')
  ].join(':')
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const parts = ciphertext.split(':')
  if (parts.length !== 3) throw new Error('Invalid ciphertext format: expected iv:authTag:data')
  
  const [ivB64, tagB64, dataB64] = parts
  const iv       = Buffer.from(ivB64, 'base64')
  const authTag  = Buffer.from(tagB64, 'base64')
  const data     = Buffer.from(dataB64, 'base64')
  
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(authTag)
  
  try {
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    throw new Error('Decryption failed: data may have been tampered (authTag mismatch)')
  }
}

export function encryptCredentials(obj: { username: string; password: string }): string {
  return encrypt(JSON.stringify(obj))
}

export function decryptCredentials(encrypted: string): { username: string; password: string } {
  const json = decrypt(encrypted)
  return JSON.parse(json)
}

// Unit tests — run with: node --import tsx bot/src/encryption.service.ts (or jest)
// Create /bot/src/encryption.service.test.ts:
import assert from 'node:assert/strict'

// Test 1: encrypt then decrypt returns original value
const original = 'Hello, GDT Bot!'
const enc = encrypt(original)
assert.equal(decrypt(enc), original, 'Round-trip failed')

// Test 2: same plaintext encrypted twice gives different ciphertext (random IV)
const enc1 = encrypt('same-text')
const enc2 = encrypt('same-text')
assert.notEqual(enc1, enc2, 'IV must be random each call')

// Test 3: tampered authTag throws error
const parts = enc.split(':')
parts[1] = Buffer.alloc(16, 0).toString('base64')  // zero out authTag
assert.throws(() => decrypt(parts.join(':')), /tampered|authTag/)

// Test 4: empty string handled correctly
const encEmpty = encrypt('')
assert.equal(decrypt(encEmpty), '')

// Test 5: encryptCredentials/decryptCredentials round-trip
const creds = { username: 'test@company.vn', password: 'S3cr3t!23' }
const encCreds = encryptCredentials(creds)
const decCreds = decryptCredentials(encCreds)
assert.deepEqual(decCreds, creds, 'Credentials round-trip failed')

console.log('All 5 encryption tests passed ✓')
```

---

### BOT-SEC-03 — CAPTCHA Solver Service (2Captcha integration)
```
[Respond in Vietnamese]
Create /bot/src/captcha.service.ts — TypeScript class for solving GDT portal captchas.

import axios, { AxiosInstance } from 'axios'

const GDT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://hoadondientu.gdt.gov.vn/',
  'Origin': 'https://hoadondientu.gdt.gov.vn',
  'Accept': 'image/avif,image/webp,*/*',
  'Accept-Language': 'vi-VN,vi;q=0.9',
}

export class CaptchaService {
  private readonly client: AxiosInstance
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(config: { apiKey: string; timeoutMs?: number }) {
    if (!config.apiKey) throw new Error('2Captcha apiKey is required')
    this.apiKey    = config.apiKey
    this.timeoutMs = config.timeoutMs ?? 120_000
    this.client    = axios.create({ timeout: 30_000 })
  }

  async fetchImageAsBase64(imageUrl: string, cookies: string): Promise<string> {
    const response = await this.client.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: { ...GDT_HEADERS, 'Cookie': cookies }
    })
    return Buffer.from(response.data).toString('base64')
  }

  async solve(imageBase64: string): Promise<{ text: string; captchaId: string }> {
    // Step 1: Submit captcha
    const submitRes = await this.client.post('https://2captcha.com/in.php', {
      key: this.apiKey,
      method: 'base64',
      body: imageBase64,
      json: 1
    }, { headers: { 'Content-Type': 'application/json' } })

    if (submitRes.data.status !== 1) {
      throw new Error(`2Captcha submit failed: ${submitRes.data.request}`)
    }
    const captchaId = String(submitRes.data.request)

    // Step 2: Poll for result every 3 seconds
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3_000))
      
      const pollRes = await this.client.get('https://2captcha.com/res.php', {
        params: { key: this.apiKey, action: 'get', id: captchaId, json: 1 }
      })

      if (pollRes.data.status === 1) {
        const text = String(pollRes.data.request).trim()
        console.log(`[CaptchaService] Solved captchaId=${captchaId} text="${text}"`)
        return { text, captchaId }
      }

      if (pollRes.data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2Captcha error: ${pollRes.data.request}`)
      }
    }
    throw new Error('CAPTCHA_TIMEOUT: exceeded ' + this.timeoutMs + 'ms')
  }

  async reportBad(captchaId: string): Promise<void> {
    try {
      await this.client.get('https://2captcha.com/res.php', {
        params: { key: this.apiKey, action: 'reportbad', id: captchaId }
      })
      console.log(`[CaptchaService] Reported bad captchaId=${captchaId}`)
    } catch (err) {
      console.error('[CaptchaService] Failed to report bad captcha:', err)
    }
  }

  async solveFromUrl(imageUrl: string, cookies: string): Promise<{ text: string; captchaId: string }> {
    const base64 = await this.fetchImageAsBase64(imageUrl, cookies)
    return this.solve(base64)
  }
}

// Singleton — configure from env
export const captchaService = new CaptchaService({
  apiKey:    process.env.TWO_CAPTCHA_API_KEY ?? '',
  timeoutMs: 120_000
})
```

---

### BOT-SEC-04 — GDT Auth Service (Login + Session Management)
```
[Respond in Vietnamese]
Create /bot/src/gdt-auth.service.ts — handles GDT portal authentication.

IMPORTANT: The actual login endpoint URLs must be discovered by inspecting
DevTools Network tab on hoadondientu.gdt.gov.vn. Placeholders marked [TODO].

import axios, { AxiosInstance, AxiosProxyConfig } from 'axios'
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import { captchaService } from './captcha.service'
import { parseProxyForAxios } from './proxy-manager'

export interface GdtSession {
  accessToken:   string
  sessionCookie: string
  expiresAt:     number   // Unix ms
  mst:           string
}

const GDT_BASE = 'https://hoadondientu.gdt.gov.vn'
const COMMON_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer':         GDT_BASE + '/',
  'Origin':          GDT_BASE,
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'vi-VN,vi;q=0.9',
}

export class GdtAuthService {
  private buildClient(proxyUrl?: string | null): AxiosInstance {
    const jar    = new CookieJar()
    const proxy  = parseProxyForAxios(proxyUrl ?? process.env.PROXY_URL ?? null)
    
    const client = wrapper(axios.create({
      baseURL:  GDT_BASE,
      jar,
      withCredentials: true,
      timeout:  30_000,
      headers:  COMMON_HEADERS,
      ...(proxy !== false && { proxy: proxy as AxiosProxyConfig })
    }))
    return client
  }

  async login(
    credentials: { mst: string; username: string; password: string },
    proxyUrl?: string
  ): Promise<GdtSession> {
    const client = this.buildClient(proxyUrl)
    let lastCaptchaId: string | undefined

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[GdtAuth] Login attempt ${attempt}/3 for MST=${credentials.mst}`)
      
      try {
        // Step 1: GET homepage to initialize session cookie
        await client.get('/')

        // Step 2: Fetch captcha image
        // TODO: Replace with actual captcha endpoint after DevTools inspection
        const captchaUrl = GDT_BASE + '/captcha-endpoint'   // [TODO: inspect Network tab]
        const cookieHeader = await this.getCookieString(client)
        const { text: captchaText, captchaId } = await captchaService.solveFromUrl(
          captchaUrl, cookieHeader
        )
        lastCaptchaId = captchaId

        // Step 3: POST login
        // TODO: Replace with actual login endpoint and payload structure after inspection
        const loginRes = await client.post('/login-endpoint', {  // [TODO]
          username: credentials.username,
          password: this.hashPassword(credentials.password),
          captcha:  captchaText,
          mst:      credentials.mst
        })

        // Check if captcha was wrong
        const body = loginRes.data
        if (JSON.stringify(body).toLowerCase().includes('captcha')) {
          console.warn('[GdtAuth] Wrong captcha, reporting bad and retrying...')
          await captchaService.reportBad(captchaId)
          continue
        }

        // Step 4: Extract Bearer token
        // TODO: Adjust field names after inspecting actual response
        const accessToken = body.token ?? body.accessToken ?? body.access_token
        if (!accessToken) throw new Error('No access token in GDT response')

        const cookieStr = await this.getCookieString(client)
        const session: GdtSession = {
          accessToken,
          sessionCookie: cookieStr,
          expiresAt:     Date.now() + 60 * 60 * 1000,  // 1 hour TTL
          mst:           credentials.mst
        }
        console.log(`[GdtAuth] Login successful for MST=${credentials.mst}`)
        return session

      } catch (err: any) {
        if (err.message === 'WRONG_CAPTCHA' && attempt < 3) continue
        throw err
      }
    }
    throw new Error('GDT login failed after 3 captcha attempts')
  }

  hashPassword(password: string): string {
    // TODO: Inspect Angular bundle on GDT portal to find actual hash algorithm
    // Common patterns: MD5(password), SHA-256(password), or plain text
    // Look for: CryptoJS.MD5, forge.md5, or btoa in minified JS
    return password  // placeholder — replace after reverse engineering
  }

  isExpired(session: GdtSession): boolean {
    return Date.now() >= session.expiresAt - 60_000  // 1 minute buffer
  }

  private async getCookieString(client: AxiosInstance): Promise<string> {
    // Extract cookies from the axios-cookiejar for use in captcha request
    const jar = (client.defaults as any).jar as CookieJar
    const cookies = await jar.getCookies(GDT_BASE)
    return cookies.map(c => `${c.key}=${c.value}`).join('; ')
  }
}

export const gdtAuthService = new GdtAuthService()

// IMPORTANT — README comment for developer:
// After getting access to hoadondientu.gdt.gov.vn:
// 1. Open Chrome DevTools → Network tab → filter by XHR/Fetch
// 2. Navigate to login page, fill form, submit
// 3. Look for POST request → copy exact URL and request body format
// 4. Look for captcha GET request → copy exact URL pattern
// 5. Check response headers for Set-Cookie and Authorization patterns
// 6. Update the [TODO] placeholders above with real values
// 7. Update hashPassword() with actual algorithm from Angular bundle
```

---

### BOT-SEC-05 — BullMQ Sync Worker (Queue + Anti-block + Scale)
```
[Respond in Vietnamese]
Create /bot/src/sync.worker.ts — BullMQ worker for multi-tenant GDT sync.

import { Worker, Job, UnrecoverableError } from 'bullmq'
import IORedis from 'ioredis'
import { decryptCredentials } from './encryption.service'
import { gdtAuthService } from './gdt-auth.service'
import { proxyManager } from './proxy-manager'
import { db } from './db'

export interface SyncJobData {
  jobId:                string
  encryptedCredentials: string      // AES-256-GCM from encryption.service
  direction:            'input' | 'output' | 'both'
  fromDate:             string      // ISO date
  toDate:               string
  tenantId:             string      // = company_id
  callbackUrl?:         string
}

const QUEUE_NAME = 'gdt-invoice-sync'
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY ?? '5')

const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null
})

// Jittered delay: baseMs ± 30% random to avoid synchronized requests
const jitteredDelay = (baseMs: number) =>
  new Promise(r => setTimeout(r, baseMs * (0.7 + Math.random() * 0.6)))

async function processGdtSync(job: Job<SyncJobData>): Promise<void> {
  const { jobId, tenantId, direction, fromDate, toDate, callbackUrl } = job.data
  const log = (msg: string) => console.log(`[Worker][${jobId}][tenant:${tenantId}] ${msg}`)

  // Step 1 — Decrypt credentials
  await job.updateProgress(5)
  const creds = decryptCredentials(job.data.encryptedCredentials)
  log('Credentials decrypted')

  // Step 2 — Get proxy (rotate per job)
  const proxyUrl = proxyManager.next()
  if (proxyUrl) log(`Using proxy: ${proxyUrl.replace(/:([^@:]+)@/, ':****@')}`)
  else log('No proxy configured — using direct connection')

  // Step 3 — Login GDT
  await job.updateProgress(10)
  let session
  try {
    session = await gdtAuthService.login(creds, proxyUrl ?? undefined)
    log('GDT login successful')
  } catch (err: any) {
    if (err.message?.includes('INVALID_CREDENTIALS') || err.message?.includes('Sai tài khoản')) {
      // Permanently deactivate this tenant's bot — don't retry
      await db.query(
        "UPDATE gdt_bot_configs SET is_active=false, last_error=$1 WHERE company_id=$2",
        ['Invalid credentials — bot deactivated', tenantId]
      )
      throw new UnrecoverableError(`Invalid GDT credentials for tenant ${tenantId}`)
    }
    if (proxyUrl) proxyManager.markFailed(proxyUrl)
    throw err  // triggers retry
  }

  // Step 4 — Fetch invoice list
  await job.updateProgress(20)
  const directions = direction === 'both' ? ['output', 'input'] : [direction]
  let totalProcessed = 0

  for (const dir of directions) {
    log(`Fetching ${dir} invoices from ${fromDate} to ${toDate}`)
    
    // TODO: Replace with actual GDT API call after endpoint discovery
    // const invoiceList = await gdtApiService.fetchAllPages(session, dir, fromDate, toDate)
    const invoiceList: any[] = []  // placeholder

    log(`Found ${invoiceList.length} ${dir} invoices`)
    const total = invoiceList.length

    for (let i = 0; i < total; i++) {
      // Re-check session expiry
      if (gdtAuthService.isExpired(session)) {
        log('Session expired — re-authenticating')
        session = await gdtAuthService.login(creds, proxyUrl ?? undefined)
      }

      // Process one invoice
      const inv = invoiceList[i]
      try {
        // TODO: download XML, parse, upsert to DB
        await upsertInvoice(inv, tenantId, dir as 'input' | 'output')
        totalProcessed++
      } catch (parseErr) {
        log(`Parse error on invoice ${inv.soHoaDon}: ${parseErr}`)
        // Continue — don't abort entire batch for one bad invoice
      }

      // Anti-block: jittered delay every 10 invoices
      if ((i + 1) % 10 === 0) {
        log(`Progress: ${i + 1}/${total} — pausing to avoid rate limit`)
        await jitteredDelay(5_000)  // 3.5–6.5 seconds random
      }

      // Update progress: 40% → 95%
      await job.updateProgress(40 + Math.round((i / total) * 55))
    }
  }

  // Step 5 — Finalize
  await job.updateProgress(100)
  
  await db.query(`
    UPDATE gdt_bot_configs SET
      last_run_at=$1, last_run_status='success',
      consecutive_failures=0, last_error=NULL
    WHERE company_id=$2`,
    [new Date(), tenantId]
  )
  
  if (proxyUrl) proxyManager.markHealthy(proxyUrl)
  log(`Sync complete — ${totalProcessed} invoices processed`)

  if (callbackUrl) {
    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, tenantId, count: totalProcessed, status: 'success' })
      })
    } catch { /* callback is best-effort */ }
  }
}

async function upsertInvoice(raw: any, companyId: string, direction: 'input' | 'output') {
  // TODO: Implement after parser is built (BOT-03, BOT-04)
  // await db.query('INSERT INTO invoices (...) ON CONFLICT (...) DO UPDATE SET ...')
}

// Create and start worker
export const worker = new Worker<SyncJobData>(QUEUE_NAME, processGdtSync, {
  connection:         redis,
  concurrency:        CONCURRENCY,
  stalledInterval:    30_000,
  maxStalledCount:    2,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },  // 1m, 2m, 4m
    timeout:  300_000  // 5 minutes max per job
  }
})

// Worker event logging
worker.on('completed', job => console.log(`[Worker] Job ${job.id} completed`))
worker.on('failed', (job, err) => console.error(`[Worker] Job ${job?.id} failed:`, err.message))
worker.on('stalled', jobId => console.warn(`[Worker] Job ${jobId} stalled`))

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Worker] SIGTERM received — graceful shutdown...')
  await worker.close()
  await redis.quit()
  process.exit(0)
})

console.log(`[Worker] Started — concurrency=${CONCURRENCY}, queue=${QUEUE_NAME}`)
```

---

### BOT-SEC-06 — Rotating Proxy Manager
```
[Respond in Vietnamese]
Create /bot/src/proxy-manager.ts — rotating proxy pool with health tracking.

import { EventEmitter } from 'events'
import type { AxiosProxyConfig } from 'axios'

interface ProxyEntry {
  url:       string
  failed:    boolean
  failedAt?: number
}

class ProxyManager extends EventEmitter {
  private proxies: ProxyEntry[] = []
  private cursor = 0

  constructor() {
    super()
    this.loadFromEnv()
  }

  private loadFromEnv() {
    const list = process.env.PROXY_LIST ?? ''
    this.proxies = list
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(url => ({ url, failed: false }))
    
    if (this.proxies.length > 0) {
      console.log(`[ProxyManager] Loaded ${this.proxies.length} proxies`)
    } else {
      console.log('[ProxyManager] No proxies configured — direct connection mode')
    }
  }

  next(): string | null {
    const available = this.proxies.filter(p => !p.failed)
    if (available.length === 0) {
      if (this.proxies.length > 0) {
        console.error('[ProxyManager] All proxies failed — resetting pool')
        this.reset()
        this.emit('all-proxies-failed')
      }
      return null
    }

    // Round-robin over available proxies
    const proxy = available[this.cursor % available.length]
    this.cursor = (this.cursor + 1) % available.length
    return proxy.url
  }

  markFailed(proxyUrl: string): void {
    const entry = this.proxies.find(p => p.url === proxyUrl)
    if (entry) {
      entry.failed = true
      entry.failedAt = Date.now()
      const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@')
      console.warn(`[ProxyManager] Marked failed: ${maskedUrl} — ${this.getStats().available} remaining`)
    }
  }

  markHealthy(proxyUrl: string): void {
    const entry = this.proxies.find(p => p.url === proxyUrl)
    if (entry) {
      entry.failed  = false
      entry.failedAt = undefined
    }
  }

  getStats(): { total: number; available: number; failed: number } {
    const failed = this.proxies.filter(p => p.failed).length
    return { total: this.proxies.length, available: this.proxies.length - failed, failed }
  }

  reset(): void {
    this.proxies.forEach(p => { p.failed = false; p.failedAt = undefined })
    this.cursor = 0
    console.log('[ProxyManager] Pool reset — all proxies re-enabled')
  }
}

export function parseProxyForAxios(proxyUrl: string | null): AxiosProxyConfig | false {
  if (!proxyUrl) return false
  
  try {
    const parsed = new URL(proxyUrl)
    const protocol = parsed.protocol.replace(':', '')  // 'socks5' | 'http' | 'https'
    const config: AxiosProxyConfig = {
      protocol,
      host: parsed.hostname,
      port: parseInt(parsed.port),
    }
    if (parsed.username) {
      config.auth = {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password)
      }
    }
    return config
  } catch {
    const maskedUrl = proxyUrl.replace(/:([^@:]+)@/, ':****@')
    console.error(`[ProxyManager] Invalid proxy URL format: ${maskedUrl}`)
    return false
  }
}

export const proxyManager = new ProxyManager()
```

---

### BOT-SEC-07 — Environment variables + Bot startup script
```
[Respond in Vietnamese]
Add all new bot-related environment variables to .env.example
and create the bot startup entry point.

1. Append to .env.example:
# ── GDT Bot ──────────────────────────────────────────────────────
ENCRYPTION_KEY=your-64-hex-character-key-here-generate-with-openssl-rand-hex-32
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

TWO_CAPTCHA_API_KEY=your-2captcha-api-key
# Register at https://2captcha.com — ~$3 per 1000 captchas

PROXY_LIST=socks5://user:pass@proxy1.example.com:1080,http://user:pass@proxy2.example.com:8080
# Comma-separated. Leave empty for direct connection.
# Recommended: buy residential proxies in Vietnam (viettel/vnpt IPs)
# Providers: brightdata.com, oxylabs.io, or local Vietnamese VPS

WORKER_CONCURRENCY=3
# Max concurrent GDT sessions. Start with 3, increase carefully.
# Too high = GDT blocks your IPs.

WORKER_DB_URL=postgresql://gdt_worker:worker_pass@localhost:5432/hddtdb
# Separate DB role for worker — bypasses RLS

BOT_SYNC_FREQUENCY_HOURS=6
# Default sync frequency for all companies

2. Create /bot/src/index.ts — main entry:
import 'dotenv/config'
import { worker } from './sync.worker'
import { proxyManager } from './proxy-manager'

console.log('[Bot] GDT Sync Bot starting...')
console.log(`[Bot] Proxy pool: ${JSON.stringify(proxyManager.getStats())}`)
console.log('[Bot] Workers active — listening for jobs')

// Auto-restart failed proxies every 30 minutes
setInterval(() => {
  const stats = proxyManager.getStats()
  if (stats.failed > 0 && stats.available === 0) {
    proxyManager.reset()
  }
}, 30 * 60 * 1000)

3. Add to /bot/package.json scripts:
{
  "scripts": {
    "start":      "node dist/index.js",
    "dev":        "tsx watch src/index.ts",
    "build":      "tsc",
    "test:enc":   "tsx src/encryption.service.test.ts",
    "install-browsers": "npx playwright install chromium"
  }
}

4. Security reminder — add comment in BOT-SEC-04:
// PROXY RECOMMENDATION for Vietnam:
// To avoid GDT blocking your server IP:
// - Use Vietnamese residential IPs (Viettel/VNPT range preferred)
// - Each tenant should ideally have a dedicated proxy
// - Rotate proxy per job (handled by ProxyManager.next())
// - If no proxy: bot still works but risk of IP block if running many companies
// - Add to gdt_bot_configs.proxy_url for per-tenant proxy assignment
```


---

## GROUP 36 — DANH MỤC TỰ ĐỘNG + TỰ SINH MÃ

### CAT-01 — Auto-code generation engine cho hàng hóa và khách hàng
```
[Respond in Vietnamese]
Create /backend/src/services/AutoCodeService.ts
Auto-generate codes for products and customers from invoice data.

Goal: Every item and customer extracted from invoices gets a unique, human-readable code.
Codes must be deterministic (same input = same code) and sequential within each company.

1. Product code generation:
   Format: HH-{CATEGORY_PREFIX}-{4-digit-seq}
   Examples: HH-VPPM-0001 (văn phòng phẩm), HH-TPCN-0045, HH-XDCT-0012
   
   Category prefixes (auto-detected from item name via Gemini or keyword rules):
     VPPM: văn phòng phẩm (giấy, bút, mực...)
     TPCN: thực phẩm & đồ uống
     XDCT: xây dựng & công trình
     MTBM: máy tính & thiết bị
     BBHH: bao bì & đóng gói
     VLSX: vật liệu sản xuất
     DVVU: dịch vụ vận tải
     DVTU: dịch vụ tư vấn
     DVKH: dịch vụ khác
     HHKH: hàng hóa khác (default)

2. Customer code generation:
   Format: KH-{PROVINCE_PREFIX}-{4-digit-seq}
   Examples: KH-HNO-0001, KH-HCM-0023, KH-DAN-0005
   
   Province prefix from buyer_tax_code first 2 digits:
     01xx: HNO (Hà Nội), 02xx: HAI (Hải Phòng), 03xx: QNI (Quảng Ninh)
     04xx: BAC (Bắc Ninh), 05xx: HAB (Hà Nam), 07xx: HCM (Hồ Chí Minh)
     09xx: DAN (Đà Nẵng), 10xx: CAN (Cần Thơ)... (full map in code)
     Unknown MST prefix: XXX

3. Supplier (vendor) code generation:
   Format: NCC-{PROVINCE_PREFIX}-{4-digit-seq}
   Same logic as customer but for seller_tax_code

4. DB schema additions:
   ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS
     item_code VARCHAR(20) UNIQUE,       -- auto-generated: HH-XXXX-0001
     category_code VARCHAR(10),
     category_name VARCHAR(100),
     is_service BOOLEAN DEFAULT false,
     unit VARCHAR(50),
     avg_purchase_price NUMERIC(18,2),   -- latest from input invoices
     avg_sale_price NUMERIC(18,2);       -- latest from output invoices

   CREATE TABLE IF NOT EXISTS customer_catalog (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id UUID REFERENCES companies(id),
     customer_code VARCHAR(20),          -- KH-HCM-0001
     tax_code VARCHAR(20),
     name VARCHAR(255),
     address TEXT,
     phone VARCHAR(20),
     province_code VARCHAR(10),
     total_revenue_12m NUMERIC(18,2),
     invoice_count_12m INT DEFAULT 0,
     last_invoice_date DATE,
     rfm_segment VARCHAR(30),
     created_at TIMESTAMPTZ DEFAULT NOW(),
     UNIQUE(company_id, tax_code)
   );

   CREATE TABLE IF NOT EXISTS supplier_catalog (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     company_id UUID REFERENCES companies(id),
     supplier_code VARCHAR(20),          -- NCC-HNO-0001
     tax_code VARCHAR(20),
     name VARCHAR(255),
     total_spend_12m NUMERIC(18,2),
     invoice_count_12m INT DEFAULT 0,
     last_invoice_date DATE,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     UNIQUE(company_id, tax_code)
   );

5. Sequence management:
   CREATE SEQUENCE IF NOT EXISTS product_code_seq START 1;
   CREATE SEQUENCE IF NOT EXISTS customer_code_seq START 1;
   CREATE SEQUENCE IF NOT EXISTS supplier_code_seq START 1;
   -- Per-company sequences stored in: code_sequences(company_id, type, current_val)

6. Auto-run after every import/sync:
   - Scan all invoices for new buyer_tax_code → create customer_catalog entry + assign code
   - Scan all line_items for new item_name → create product_catalog entry + assign code
   - Scan all invoices for new seller_tax_code → create supplier_catalog entry + assign code
   - Never re-assign codes (idempotent — same tax_code always gets same code)

7. Frontend pages:
   /catalogs/products  → searchable product list, show code, category, prices
   /catalogs/customers → customer list with codes (linked to CRM data)
   /catalogs/suppliers → supplier list with codes (linked to vendor data)
   Each page: [Xuất Excel] button, [Sửa] per row, search by code/name/MST
```

---

## GROUP 37 — XUẤT NHẬP TỒN (INVENTORY TRACKING)

### INV-01 — Inventory movement engine
```
[Respond in Vietnamese]
Create inventory tracking from invoice line items.
This derives inventory movements WITHOUT requiring a separate warehouse system —
purely from purchase (input) and sales (output) invoices.

Concept:
  Input invoice line item  → NHẬP KHO (stock in)
  Output invoice line item → XUẤT KHO (stock out)
  Tồn = cumulative (nhập - xuất) per item per period

DB Schema:
CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  invoice_id UUID REFERENCES invoices(id),
  line_item_id UUID REFERENCES invoice_line_items(id),
  movement_type VARCHAR(10),            -- 'IN' (nhập) | 'OUT' (xuất)
  item_code VARCHAR(20),                -- from product_catalog
  item_name TEXT,
  normalized_item_name TEXT,
  unit VARCHAR(50),
  quantity NUMERIC(18,4),
  unit_cost NUMERIC(18,2),              -- giá vốn (from input invoice)
  unit_price NUMERIC(18,2),             -- giá bán (from output invoice)
  total_value NUMERIC(18,2),            -- quantity × unit_cost or unit_price
  movement_date DATE,
  partner_name VARCHAR(255),
  partner_tax_code VARCHAR(20),
  source VARCHAR(20),                   -- 'invoice' | 'manual_adjust' | 'opening_balance'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_inv_mov_company_date ON inventory_movements(company_id, movement_date DESC);
CREATE INDEX idx_inv_mov_item ON inventory_movements(company_id, normalized_item_name);

-- Materialized view for fast balance queries
CREATE MATERIALIZED VIEW inventory_balance AS
SELECT
  company_id,
  item_code,
  normalized_item_name,
  item_name,
  unit,
  SUM(CASE WHEN movement_type='IN'  THEN quantity ELSE 0 END) AS total_in,
  SUM(CASE WHEN movement_type='OUT' THEN quantity ELSE 0 END) AS total_out,
  SUM(CASE WHEN movement_type='IN'  THEN quantity ELSE 0 END) -
  SUM(CASE WHEN movement_type='OUT' THEN quantity ELSE 0 END) AS balance_qty,
  SUM(CASE WHEN movement_type='IN'  THEN total_value ELSE 0 END) AS total_in_value,
  SUM(CASE WHEN movement_type='OUT' THEN total_value ELSE 0 END) AS total_out_value,
  AVG(CASE WHEN movement_type='IN'  THEN unit_cost END) AS avg_cost_price,
  MAX(movement_date) AS last_movement_date
FROM inventory_movements
GROUP BY company_id, item_code, normalized_item_name, item_name, unit;

REFRESH MATERIALIZED VIEW CONCURRENTLY inventory_balance;

Create /backend/src/services/InventoryService.ts:
  buildMovements(companyId, month, year): scan invoice_line_items → insert inventory_movements
  getBalanceReport(companyId, asOfDate): query inventory_balance
  getMovementDetail(companyId, itemCode, from, to): list all IN/OUT for one item
  
Run buildMovements() after each import/sync.
```

### INV-02 — Báo cáo Xuất Nhập Tồn page
```
[Respond in Vietnamese]
Create /reports/inventory page — Báo cáo Xuất Nhập Tồn (XNT report).
Standard Vietnamese accounting report format.

Backend: GET /api/reports/inventory?companyId=&month=&year=&itemCode=

Report structure (matches Vietnamese accounting standard):
  Header: Công ty [name] | MST: [tax_code] | Kỳ: Tháng [M]/[Y]
  
  Table columns (chuẩn báo cáo XNT):
    STT | Mã hàng | Tên hàng hóa | ĐVT | 
    TỒN ĐẦU KỲ (SL - Giá trị) |
    NHẬP TRONG KỲ (SL - Giá trị) |
    XUẤT TRONG KỲ (SL - Giá trị) |
    TỒN CUỐI KỲ (SL - Giá trị)
  
  Tồn đầu kỳ = Tồn cuối kỳ trước
  Tồn cuối kỳ = Tồn đầu + Nhập - Xuất
  Giá trị tồn = Bình quân gia quyền (weighted average cost)
  
  Footer: Tổng cộng row (sum of all value columns)

Features:
  - Filter by item category, item code, item name
  - Toggle: show items with zero balance | hide zero-balance items
  - Negative balance warning: highlight red (sold more than bought — data gap)
  - [Xuất Excel] → download properly formatted Excel (chuẩn kế toán VN)
  - [In báo cáo] → print-optimized A4 layout

Alert box if negative balance items exist:
  "⚠️ [N] mặt hàng có tồn kho âm — có thể do thiếu dữ liệu đầu vào.
  Kiểm tra lại hóa đơn mua vào hoặc nhập số dư đầu kỳ."

Opening balance import:
  Button: "Nhập số dư đầu kỳ" → modal to enter initial stock quantities/values
  Stored as movement_type='opening_balance'

Mobile view: show as cards (item name + opening + net movement + closing)
```

---

## GROUP 38 — SỔ QUỸ TIỀN (CASH BOOK)

### CASH-01 — Cash book data model + auto-population
```
[Respond in Vietnamese]
Create /backend/src/services/CashBookService.ts — sổ quỹ tiền mặt.

Important context: Invoice data does not directly give us cash flow timing.
We derive cash entries from:
  - Output invoices + payment_date (thu tiền khi khách thanh toán)
  - Input invoices + payment_date (chi tiền khi trả NCC)
  - Manual entries (thu/chi không có hóa đơn)

DB Schema:
CREATE TABLE cash_book_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  entry_type VARCHAR(10),             -- 'receipt' (thu) | 'payment' (chi) | 'transfer'
  entry_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  description TEXT,
  partner_name VARCHAR(255),
  partner_tax_code VARCHAR(20),
  invoice_id UUID REFERENCES invoices(id) NULL,  -- linked invoice if any
  reference_number VARCHAR(50),       -- số phiếu thu/chi
  category VARCHAR(50),               -- 'bán hàng'|'mua hàng'|'lương'|'thuê mặt bằng'|'khác'
  payment_method VARCHAR(20),         -- 'cash'|'bank_transfer'|'check'
  bank_account VARCHAR(50),           -- if bank transfer
  is_auto_generated BOOLEAN DEFAULT false,  -- true if from invoice.payment_date
  running_balance NUMERIC(18,2),      -- calculated field
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cash_book_date ON cash_book_entries(company_id, entry_date DESC);

Auto-populate from paid invoices:
  When invoice.payment_date is set:
    - Output invoice paid → INSERT receipt entry (thu tiền bán hàng)
    - Input invoice paid → INSERT payment entry (chi tiền mua hàng)
    - is_auto_generated = true, invoice_id = that invoice

Manual entry support:
  POST /api/cash-book/entries — add manual thu/chi
  PUT  /api/cash-book/entries/:id — edit
  DELETE /api/cash-book/entries/:id — soft delete

Running balance recalculation:
  After any insert/update/delete: recalculate running_balance for all entries
  from that date forward (use window function: SUM OVER ORDER BY entry_date, id)
  
Opening balance:
  Special entry: entry_type='opening', description='Số dư đầu kỳ'
  Always the first entry for a company — user inputs manually
```

### CASH-02 — Sổ Quỹ page
```
[Respond in Vietnamese]
Create /reports/cash-book page — Sổ Quỹ Tiền Mặt.
Format matches Vietnamese accounting standard for cash journal.

Backend: GET /api/cash-book?companyId=&month=&year=&method=cash|bank|all

Page layout:

Header section:
  Company name + MST | Kỳ: Tháng [M]/[Y] | Đơn vị tiền: VND
  Opening balance: [amount] (carried from previous period)

Main table (chuẩn sổ quỹ VN):
  Ngày | Số chứng từ | Diễn giải | Đối tác | Thu (Nợ) | Chi (Có) | Tồn quỹ
  
  Rows auto-sorted by entry_date ASC, then by id
  Color coding: Thu rows (green left border) | Chi rows (red left border)
  Auto-generated rows (from invoices): gray background with HĐ icon
  Manual entries: white background with pencil icon
  
  Last row: CỘNG PHÁT SINH (sum of thu, sum of chi)
  After that: TỒN QUỸ CUỐI KỲ = Đầu kỳ + Thu - Chi

Features:
  [+ Phiếu Thu] button → modal: date, amount, partner, category, description, reference#
  [+ Phiếu Chi] button → same modal with type=payment
  Click row → expand: link to invoice (if auto-generated), edit/delete for manual entries
  
  Filter tabs: Tất cả | Tiền mặt | Chuyển khoản | Tự động (từ HĐ) | Thủ công
  
  Discrepancy alert: if running_balance goes negative → red warning
  "⚠️ Tồn quỹ âm ngày [date]: kiểm tra số dư đầu kỳ hoặc nhập thiếu phiếu thu"

  [Xuất Excel] → A4 format, standard VN cash book layout
  [Đối chiếu ngân hàng] → compare cash book with bank statement (future feature)

Tab toggle: Tiền Mặt | Tiền Gửi Ngân Hàng (separate books per bank account)
```

---

## GROUP 39 — NHẬT KÝ MUA BÁN + BÁO CÁO DOANH THU / CHI PHÍ

### JRN-01 — Purchase & Sales journals (Nhật ký mua/bán hàng)
```
[Respond in Vietnamese]
Create /reports/purchase-journal and /reports/sales-journal pages.
These are standard Vietnamese accounting journals derived from invoice data.

Backend: GET /api/reports/sales-journal?companyId=&month=&year=
         GET /api/reports/purchase-journal?companyId=&month=&year=

Sales Journal (Nhật ký bán hàng) format:
  Header: Tên DN | MST | Nhật ký bán hàng | Tháng [M]/[Y]
  
  Table columns:
    STT | Ngày | Số HĐ | Ký hiệu | Tên khách hàng | MST khách |
    Doanh thu 0% | Doanh thu 5% | Doanh thu 8% | Doanh thu 10% |
    Thuế GTGT 5% | Thuế GTGT 8% | Thuế GTGT 10% |
    Tổng tiền thanh toán

  Footer: CỘNG PHÁT SINH THÁNG (sum each column)
  Grand total row: tổng doanh thu + tổng thuế

Purchase Journal (Nhật ký mua hàng) format:
  Same structure but:
    STT | Ngày | Số HĐ | Ký hiệu | Tên nhà cung cấp | MST NCC |
    Hàng mua 0% | Hàng mua 5% | Hàng mua 8% | Hàng mua 10% |
    Thuế GTGT được khấu trừ 5% | ... 8% | ... 10% |
    Tổng tiền

Query logic:
  - Group output invoices by VAT rate → split into separate columns
  - Sort by invoice_date ASC, then invoice_number
  - Only include status='valid' invoices (exclude cancelled/replaced)

Both pages share the same UI structure:
  - Period selector (month/year)
  - Summary totals at top: Tổng HĐ | Tổng doanh thu | Tổng thuế
  - Full scrollable table
  - [Xuất Excel] → properly formatted Excel for accountants
  - [In báo cáo] → A4 print layout

Note: These journals are the source data for:
  - VAT declaration form 01/GTGT (already built)
  - Revenue/expense reports (this group)
  - P&L statement (next group)
```

### JRN-02 — Revenue & Expense Report (Báo cáo Doanh Thu & Chi Phí)
```
[Respond in Vietnamese]
Create /reports/revenue-expense page — detailed revenue and expense report.
More detailed than dashboard charts — this is the accountant-facing report.

Backend: GET /api/reports/revenue-expense?companyId=&month=&year=&groupBy=category|partner|vatRate

Report sections:

SECTION 1 — DOANH THU (Revenue from output invoices):
  By VAT rate:
    Doanh thu chịu thuế 0%:    [subtotal] | [vat: 0]
    Doanh thu chịu thuế 5%:    [subtotal] | [vat: X]
    Doanh thu chịu thuế 8%:    [subtotal] | [vat: X]
    Doanh thu chịu thuế 10%:   [subtotal] | [vat: X]
    Doanh thu không chịu thuế: [subtotal] | [vat: 0]
    ─────────────────────────────────────────────────
    TỔNG DOANH THU:            [total]    | [total VAT]

  By top customers (collapsible):
    Khách hàng A | MST | [invoice count] | [revenue] | [vat]
    ...

SECTION 2 — CHI PHÍ MUA HÀNG (Costs from input invoices):
  By VAT rate: same structure as revenue
  By top suppliers: same structure as customers
  TỔNG CHI PHÍ MUA HÀNG: [total]

SECTION 3 — TỔNG HỢP:
  Doanh thu thuần:     [revenue]
  Chi phí mua hàng:    [cost]
  Lợi nhuận gộp:       [revenue - cost]
  Tỉ lệ lợi nhuận gộp: [%]

  VAT phải nộp:        [output_vat - input_vat]

Period selector: Tháng | Quý | Năm | Tùy chỉnh
Compare toggle: "So với kỳ trước" → show delta columns
[Xuất Excel] → multi-sheet workbook (revenue sheet + expense sheet + summary)
[In báo cáo] → A4 landscape format
```

---

## GROUP 40 — KẾT QUẢ KINH DOANH (P&L STATEMENT)

### PL-01 — P&L calculation engine (chuẩn VN)
```
[Respond in Vietnamese]
Create /backend/src/services/ProfitLossService.ts
P&L following Vietnamese accounting standard (Thông tư 200/2014/TT-BTC or TT133/2016).

Function calculatePL(companyId: string, month: number, year: number): Promise<PLStatement>

Data sources:
  Revenue (DT):    output invoices, status=valid, direction=output
  COGS (GVHB):     input invoices matched to items sold in same period (from line_items cross-match)
  Other expenses:  cash_book_entries WHERE entry_type='payment' AND category != 'mua hàng'

P&L structure (mẫu chuẩn B02-DN Thông tư 200):

  1. Doanh thu bán hàng và CCDV (01) = SUM(output subtotal)
  2. Các khoản giảm trừ doanh thu (02) = 0 (unless returns tracked)
  3. Doanh thu thuần về BH và CCDV (10) = (01) - (02)
  4. Giá vốn hàng bán (11) = SUM(input subtotal matched to sold items)
     [If no line_item match: use industry COGS ratio as estimate, mark as estimated]
  5. Lợi nhuận gộp về BH và CCDV (20) = (10) - (11)
  6. Doanh thu hoạt động tài chính (21) = 0 (bank interest — manual entry)
  7. Chi phí tài chính (22) = 0 (loan interest — manual entry)
  8. Chi phí bán hàng (25) = cash_book WHERE category='chi phí bán hàng'
  9. Chi phí QLDN (26) = cash_book WHERE category='chi phí quản lý'
  10. Lợi nhuận thuần từ HĐKD (30) = (20) + (21) - (22) - (25) - (26)
  11. Thu nhập khác (31) = cash_book WHERE entry_type='receipt' AND category='thu nhập khác'
  12. Chi phí khác (32) = cash_book WHERE entry_type='payment' AND category='chi phí khác'
  13. Lợi nhuận khác (40) = (31) - (32)
  14. Tổng LN trước thuế (50) = (30) + (40)
  15. Chi phí thuế TNDN hiện hành (51) = (50) × 20% (nếu là DN, if positive)
      Hộ KD: thuế khoán hoặc theo bảng biểu riêng (see HKD-01)
  16. Lợi nhuận sau thuế TNDN (60) = (50) - (51)

Store result in:
  profit_loss_statements(id, company_id, period_month, period_year,
    line_01 through line_60 as NUMERIC(22,2), has_estimates BOOLEAN,
    estimate_notes TEXT, generated_at TIMESTAMPTZ)
```

### PL-02 — Báo cáo Kết Quả Kinh Doanh page
```
[Respond in Vietnamese]
Create /reports/profit-loss page — P&L statement display.

Backend: GET /api/reports/profit-loss?companyId=&month=&year=
         POST /api/reports/profit-loss/generate → recalculate

Page layout:

Header:
  "BÁO CÁO KẾT QUẢ HOẠT ĐỘNG KINH DOANH"
  Công ty: [name] | MST: [code] | Kỳ: Tháng [M]/[Y]
  
If has_estimates = true: show orange banner:
  "⚠️ Một số chỉ tiêu được ước tính do chưa đủ dữ liệu giá vốn hàng bán.
  Kết quả sẽ chính xác hơn khi có đầy đủ hóa đơn đầu vào với chi tiết hàng hóa."

Main table (2 columns: Chỉ tiêu | Mã số | Kỳ này | Kỳ trước):
  
  Row group 1 — DOANH THU:
    Doanh thu BH và CCDV          01  [+value]
    Các khoản giảm trừ DT         02  [-value]
    Doanh thu thuần                10  [=value]  (bold)
  
  Row group 2 — CHI PHÍ & LN GỘP:
    Giá vốn hàng bán               11  [-value]
    Lợi nhuận gộp                  20  [=value]  (bold, green if positive)
  
  Row group 3 — CHI PHÍ HOẠT ĐỘNG:
    DT hoạt động tài chính         21  [+value]
    Chi phí tài chính              22  [-value]
    Chi phí bán hàng               25  [-value]
    Chi phí quản lý DN             26  [-value]
    Lợi nhuận thuần HĐKD           30  [=value]  (bold, red if negative)
  
  Row group 4 — THU NHẬP/CHI PHÍ KHÁC:
    Thu nhập khác                  31  [+value]
    Chi phí khác                   32  [-value]
    Lợi nhuận khác                 40  [=value]
  
  Row group 5 — KẾT QUẢ:
    Tổng lợi nhuận trước thuế      50  [=value]  (bold, large font)
    Thuế thu nhập DN               51  [-value]
    LỢI NHUẬN SAU THUẾ             60  [=value]  (bold, large, green/red)

Visual: 
  Positive final P&L = green background on row 60
  Negative final P&L = red background on row 60
  Mini sparkline: 6-month P&L trend above the table
  
Actions:
  [+ Nhập chi phí thủ công] → add cash_book entry for QLDN/bán hàng/khác
  [Tính lại] → POST recalculate
  [Xuất Excel] → standard B02-DN format
  [In báo cáo] → A4 portrait, official format
  
Year comparison: toggle to show 12-month table (each month = one column)
```

---

## GROUP 41 — THUẾ GTGT HỘ KINH DOANH (VAT FOR HKD)

### HKD-01 — Hộ Kinh Doanh tax forms + calculation
```
[Respond in Vietnamese]
Create VAT and tax forms specifically for Hộ Kinh Doanh (HKD) — small businesses.
HKD uses different tax forms than enterprises (DN).

Context: Vietnam has 2 tax regimes for small businesses:
  A) Thuế khoán (fixed tax): lump sum, no monthly declaration needed
  B) Thuế theo doanh thu thực tế (actual revenue): declare monthly if >100M/year

DB addition:
  ALTER TABLE companies ADD COLUMN IF NOT EXISTS
    business_type ENUM('DN','HKD','HND','CA_NHAN') DEFAULT 'DN',
    tax_regime ENUM('khoan','thuc_te','khau_tru') DEFAULT 'khau_tru',
    -- khau_tru = deduction method (DN default)
    -- thuc_te  = actual revenue method (HKD option)
    -- khoan    = fixed tax (small HKD)
    vat_rate_hkd NUMERIC(4,2) DEFAULT 1.0;  -- tỉ lệ thuế GTGT HKD (1% or 3% or 5%)

Form 01/GTGT for DN (already built in P9.1) stays as-is.

New form for HKD — Tờ khai thuế theo phương pháp trực tiếp (Mẫu 04/GTGT):
  Used by: HKD nộp thuế theo doanh thu thực tế
  
  Function calculateHkdTax(companyId, month, year): HkdTaxStatement
    revenue = SUM(output invoices subtotal) for period
    vat_rate = company.vat_rate_hkd  -- typically 1% for trading, 3% for services, 5% for others
    vat_payable = revenue × vat_rate
    personal_income_tax = revenue × 0.5%  -- thuế TNCN (HKD pays both VAT + PIT)
    total_payable = vat_payable + personal_income_tax
    deadline = 20th of following month

New form for HKD — Tờ khai thuế khoán:
  Form 01/TK-HKDBSS (annual fixed tax declaration)
  Filled once per year, not monthly
  Fields: estimated annual revenue, tax authority pre-assigned fixed amount
  Manual input — system can't auto-calculate (fixed by tax authority)

Tỉ lệ thuế GTGT theo ngành (HKD - Thông tư 40/2021):
  Phân phối, cung cấp hàng hóa: 1%
  Dịch vụ, xây dựng không bao thầu VLXD: 5%
  Sản xuất, vận tải, dịch vụ gắn với hàng hóa: 3%
  Hoạt động khác: 2%

Frontend: When company.business_type = 'HKD':
  - Replace "Tờ khai 01/GTGT" with "Tờ khai thuế HKD (04/GTGT)"
  - Show VAT rate selector: 1% | 2% | 3% | 5%
  - Show both: VAT payable + Personal income tax payable
  - Display in separate card: "Tổng thuế phải nộp = [VAT] + [TNCN]"
  - Alert if monthly revenue > 8.33M (100M/year threshold for mandatory declaration)
```

### HKD-02 — Business type selector in company settings
```
[Respond in Vietnamese]
Update company setup and settings to support different business types.

In /settings/companies and company onboarding:
Add section "Loại hình & Chế độ thuế":

  Loại hình kinh doanh: (radio)
    ○ Doanh nghiệp (Công ty TNHH, CP, DNTW...)  → DN
    ○ Hộ Kinh Doanh                               → HKD
    ○ Hộ Gia Đình Kinh Doanh                      → HND
    ○ Cá nhân kinh doanh                          → CA_NHAN

  [IF HKD/HND/CA_NHAN selected, show:]
  
  Phương pháp nộp thuế: (radio)
    ○ Thuế khoán (cơ quan thuế ấn định)
    ○ Thuế theo doanh thu thực tế (nộp hàng tháng nếu DT > 100 triệu/năm)
  
  [IF thuế thực tế selected:]
  
  Tỉ lệ thuế GTGT áp dụng: (select)
    ○ 1% — Phân phối, bán hàng hóa
    ○ 2% — Hoạt động khác
    ○ 3% — Sản xuất, vận tải, dịch vụ gắn hàng hóa
    ○ 5% — Dịch vụ, xây dựng

  Tỉ lệ thuế TNCN: 0.5% (fixed per TT40/2021, display only)

When business_type is set:
  - All tax reports automatically switch to correct form
  - Dashboard labels change: "Thuế GTGT" → "Thuế GTGT + TNCN"
  - Tờ Khai page shows correct form template
  - VAT rate used in calculations updates accordingly

API: PATCH /api/companies/:id/tax-settings
  Body: { businessType, taxRegime, vatRateHkd }
```


---

## GROUP 42 — DATA MANAGEMENT & MAINTENANCE

> Mục tiêu: Cho phép user kiểm soát dữ liệu hóa đơn mà không sợ mất vĩnh viễn,
> đồng thời đảm bảo GDT Bot không bao giờ tái nhập những HĐ đã bị chủ động loại bỏ.

### P42.1 — Soft Delete Logic + RLS Filter
```
[Respond in Vietnamese]
Implement soft delete across all invoice-related tables.
Currently invoices are never deleted — add controlled deletion with recovery support.

STEP 1 — DB migration /scripts/011_soft_delete.sql:

-- Ensure deleted_at column exists on all relevant tables
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS delete_reason VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_permanently_ignored BOOLEAN DEFAULT false;
  -- is_permanently_ignored = true means: bot will NEVER re-import this invoice

ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE cash_book_entries
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Index to make "active only" queries fast
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_not_deleted
  ON invoices(company_id, invoice_date DESC)
  WHERE deleted_at IS NULL AND is_permanently_ignored = false;

STEP 2 — Update ALL existing queries to filter soft-deleted rows:
  Every SELECT on invoices must add: WHERE deleted_at IS NULL
  This applies to: dashboard stats, VAT reconciliation, P&L, cash book, reports,
  inventory movements, RFM calculation, anomaly detection, repurchase predictions.

  Create a DB view for convenience:
  CREATE OR REPLACE VIEW active_invoices AS
    SELECT * FROM invoices
    WHERE deleted_at IS NULL
      AND is_permanently_ignored = false;
  
  Update all backend services to query active_invoices view instead of invoices table
  directly. This ensures no soft-deleted or ignored invoice ever appears in any report.

STEP 3 — Update Row-Level Security:
  -- Existing RLS policy on invoices — update to also exclude deleted rows
  DROP POLICY IF EXISTS invoices_company_isolation ON invoices;
  
  CREATE POLICY invoices_company_isolation ON invoices
    USING (
      company_id IN (
        SELECT company_id FROM user_companies
        WHERE user_id = current_setting('app.current_user_id', true)::uuid
      )
      AND deleted_at IS NULL          -- RLS automatically hides soft-deleted rows
      AND is_permanently_ignored = false
    );

  -- Separate policy for OWNER/ADMIN role: can see trash bin (deleted_at IS NOT NULL)
  CREATE POLICY invoices_trash_access ON invoices
    AS PERMISSIVE
    USING (
      company_id IN (
        SELECT company_id FROM user_companies
        WHERE user_id = current_setting('app.current_user_id', true)::uuid
          AND role IN ('OWNER', 'ADMIN')
      )
      -- no deleted_at filter here — allows seeing deleted rows in trash
    );

  Note: Use SET LOCAL for the policy switch:
    To query trash: SET LOCAL app.include_deleted = 'true';

STEP 4 — Soft delete API endpoints:
  DELETE /api/invoices/:id
    Body: { reason: 'duplicate'|'invalid'|'test_data'|'other', note?: string }
    Action: SET deleted_at=NOW(), deleted_by=userId, delete_reason=reason
    Do NOT physically delete. Return 200.
  
  DELETE /api/invoices/:id/permanent-ignore
    Body: { reason: string }
    Action: SET deleted_at=NOW(), is_permanently_ignored=true
    This invoice will NEVER be re-imported by the bot.
    Require confirmation: must send { confirm: 'IGNORE_PERMANENTLY' } in body.
  
  POST /api/invoices/:id/restore
    Action: SET deleted_at=NULL, deleted_by=NULL, delete_reason=NULL
    Only works if is_permanently_ignored=false.
    Log restore action to audit_logs.

STEP 5 — Bulk operations:
  DELETE /api/invoices/bulk-delete
    Body: { ids: string[], reason: string }
    Max 500 IDs per request.
  
  POST /api/invoices/bulk-restore
    Body: { ids: string[] }
```

### P42.2 — Trash Bin UI (Thùng Rác)
```
[Respond in Vietnamese]
Create /invoices/trash page — Thùng Rác Hóa Đơn.
Accessible from /invoices page via button "Thùng rác ([count])" in top-right area.

Backend: GET /api/invoices/trash?companyId=&page=1&pageSize=50
  Query invoices WHERE deleted_at IS NOT NULL AND company_id=X
  (requires bypassing RLS — use admin DB role for this endpoint)
  Require role: OWNER or ADMIN only (403 for ACCOUNTANT/VIEWER)
  
  Return: same invoice fields + deleted_at + deleted_by (user name) + delete_reason + is_permanently_ignored

Page layout:

Header:
  "Thùng Rác" + back arrow to /invoices
  Subtitle: "Hóa đơn đã ẩn — [N] mục | Vĩnh viễn bị bỏ qua: [M] mục"
  
  Info banner (blue):
  "Hóa đơn trong thùng rác không xuất hiện trong bất kỳ báo cáo nào.
  Khôi phục để đưa trở lại hệ thống, hoặc xóa vĩnh viễn nếu chắc chắn."

Filter tabs:
  Đã ẩn (có thể khôi phục) | Bỏ qua vĩnh viễn (bot sẽ không tải lại)

Invoice list (same card style as /invoices but with muted/gray styling):
  Each card shows:
    [Gray background, 0.5 opacity]
    Số HĐ | Ngày | Tên đối tác | Số tiền | VAT%
    Reason badge: "Trùng lặp" | "Không hợp lệ" | "Dữ liệu test" | "Khác"
    Deleted info: "Đã ẩn bởi [username] lúc [time]"
    [is_permanently_ignored=true]: Show "⛔ Bot không tải lại" badge in red
  
  Per-card actions (OWNER/ADMIN only):
    [Khôi phục] button (green) — only shown if is_permanently_ignored=false
      → POST /api/invoices/:id/restore
      → Toast: "Đã khôi phục — hóa đơn xuất hiện lại trong báo cáo"
      → Card disappears from trash list
    
    [Xóa vĩnh viễn] button (red, text only — no fill)
      → Confirmation dialog: "Thao tác này không thể hoàn tác. Hóa đơn sẽ bị xóa hoàn toàn khỏi database."
      → Type "XÓA" to confirm
      → DELETE /api/invoices/:id/hard-delete (OWNER only, requires 2nd password confirm)

Bulk actions (checkbox selection):
  Select all on page | Deselect all
  [Khôi phục X hóa đơn đã chọn] | [Xóa vĩnh viễn X hóa đơn]

Empty state:
  Trash icon + "Thùng rác trống"
  "Khi bạn ẩn hóa đơn, chúng sẽ xuất hiện ở đây"

Access from /invoices page:
  Add to invoice list header: "Thùng rác ([count])" as a small text link
  count = number of soft-deleted invoices for active company (cached, refresh every 5 min)
  Only visible to OWNER/ADMIN role
```

### P42.3 — Permanent Ignore: Bot Blocklist
```
[Respond in Vietnamese]
Create the "Permanent Ignore" mechanism so the GDT Bot never re-imports
invoices that the user has intentionally removed.

This is critical: without this, every time the bot syncs, it will re-import
deleted invoices and they will reappear in reports — defeating the purpose of deletion.

STEP 1 — Ignored invoice registry:
  The is_permanently_ignored=true flag on invoices table (added in P42.1) is the
  source of truth. But we also need a separate blocklist for invoices that were
  NEVER imported (e.g., user wants to pre-block a known bad invoice number).

  CREATE TABLE invoice_ignore_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id),
    invoice_number VARCHAR(50) NOT NULL,
    seller_tax_code VARCHAR(20),          -- NULL = ignore this number from ANY seller
    invoice_date DATE,                    -- NULL = ignore regardless of date
    reason VARCHAR(200),
    ignored_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, invoice_number, seller_tax_code)
  );
  
  CREATE INDEX idx_ignore_list_lookup
    ON invoice_ignore_list(company_id, invoice_number, seller_tax_code);

STEP 2 — Bot integration (update sync.worker.ts and GDT parsers):
  Before inserting any invoice from the bot or import:
  
  async function shouldIgnoreInvoice(
    companyId: string,
    invoiceNumber: string,
    sellerTaxCode: string
  ): Promise<boolean> {
    // Check 1: is it in invoice_ignore_list?
    const inList = await db.query(`
      SELECT 1 FROM invoice_ignore_list
      WHERE company_id = $1
        AND invoice_number = $2
        AND (seller_tax_code IS NULL OR seller_tax_code = $3)
      LIMIT 1
    `, [companyId, invoiceNumber, sellerTaxCode])
    if (inList.rowCount > 0) return true
    
    // Check 2: is it already in invoices with is_permanently_ignored=true?
    const inInvoices = await db.query(`
      SELECT 1 FROM invoices
      WHERE company_id = $1
        AND invoice_number = $2
        AND seller_tax_code = $3
        AND is_permanently_ignored = true
      LIMIT 1
    `, [companyId, invoiceNumber, sellerTaxCode])
    return (inInvoices.rowCount ?? 0) > 0
  }
  
  // In bulkUpsertInvoices(): filter before insert
  const filtered = await Promise.all(
    invoices.map(async inv => ({
      inv,
      ignored: await shouldIgnoreInvoice(companyId, inv.invoice_number, inv.seller_tax_code)
    }))
  )
  const toInsert = filtered.filter(x => !x.ignored).map(x => x.inv)
  
  // Log skipped count
  const skippedCount = filtered.length - toInsert.length
  if (skippedCount > 0) {
    logger.info(`[Sync] Skipped ${skippedCount} permanently ignored invoices for company ${companyId}`)
  }

STEP 3 — UI: "Bỏ qua vĩnh viễn" action on invoice cards:
  On /invoices page, each invoice card action menu (⋮ icon):
    [Ẩn hóa đơn]             → soft delete, recoverable
    [Bỏ qua vĩnh viễn...]    → soft delete + add to ignore_list (bot won't reimport)
  
  "Bỏ qua vĩnh viễn" confirmation modal:
    Warning icon (red)
    "Hóa đơn này sẽ bị ẩn khỏi tất cả báo cáo và bot sẽ KHÔNG BAO GIỜ tải lại."
    "Thao tác này có thể hoàn tác trong Thùng Rác nếu bạn chưa xóa vĩnh viễn."
    [Hủy] [Xác nhận bỏ qua]
    
  On confirm: 
    1. SET invoices.is_permanently_ignored = true, deleted_at = NOW()
    2. INSERT INTO invoice_ignore_list (company_id, invoice_number, seller_tax_code, reason)
    3. Toast: "Đã bỏ qua — bot sẽ không tải lại hóa đơn này"

STEP 4 — Ignore list management page:
  /settings/data/ignore-list — for OWNER/ADMIN only
  
  "Danh sách hóa đơn bỏ qua vĩnh viễn"
  Table: Số HĐ | MST người bán | Ngày bỏ qua | Lý do | Người thực hiện | Hành động
  
  [Xóa khỏi danh sách bỏ qua] per row:
    → DELETE from invoice_ignore_list
    → SET invoices.is_permanently_ignored = false WHERE matching
    → Note: Invoice itself stays soft-deleted — user must manually restore from trash if needed
    → Toast: "Đã gỡ bỏ khỏi danh sách. Lần đồng bộ sau bot có thể tải lại hóa đơn này."
  
  [+ Thêm thủ công] button: add invoice to ignore list without it existing in DB
    Fields: Số hóa đơn, MST người bán (optional), Lý do
    Use case: pre-block known bad invoices before they're imported

STEP 5 — Audit log for all deletion actions:
  Every delete/restore/ignore action must be logged:
  INSERT INTO audit_logs(user_id, company_id, action, entity_type, entity_id, 
    old_values, new_values, ip_address, created_at)
  
  Actions to log:
    'INVOICE_SOFT_DELETE'
    'INVOICE_PERMANENT_IGNORE'
    'INVOICE_RESTORE'
    'INVOICE_HARD_DELETE'
    'IGNORE_LIST_ADD'
    'IGNORE_LIST_REMOVE'
  
  This gives the owner a full audit trail of who deleted what and when.
```


---

## GROUP 43 — KIỂM TRA CÔNG TY MA (GHOST COMPANY DETECTION)

> Tính năng này hoàn toàn CHƯA CÓ trong dự án. Đây là gap rủi ro pháp lý cao nhất:
> khấu trừ VAT từ hóa đơn của công ty ma → bị truy thu 100% số thuế + phạt 20%.
> Nguồn chính thức: tracuunnt.gdt.gov.vn (GDT) + dangkykinhdoanh.gov.vn (Bộ KH&ĐT)

### GHOST-01 — DB Schema + Company Verification Service
```
[Respond in Vietnamese]
Create the company verification infrastructure to detect ghost/shell companies
from invoice seller_tax_code and buyer_tax_code data.

STEP 1 — DB Schema /scripts/012_company_verification.sql:

CREATE TABLE company_verification_cache (
  tax_code          VARCHAR(20) PRIMARY KEY,
  company_name      VARCHAR(500),
  company_name_en   VARCHAR(500),
  legal_rep         VARCHAR(255),         -- Người đại diện pháp luật
  address           VARCHAR(1000),
  province_code     VARCHAR(10),
  registered_date   DATE,                 -- Ngày đăng ký
  dissolved_date    DATE,                 -- Ngày giải thể (NULL = active)
  mst_status        VARCHAR(30),          -- 'active'|'suspended'|'dissolved'|'not_found'
  business_type     VARCHAR(100),         -- Loại hình DN
  industry_code     VARCHAR(20),          -- Mã ngành nghề chính
  source            VARCHAR(30),          -- 'gdt'|'dkkd'|'masothue'
  raw_data          JSONB,                -- Full response for audit
  verified_at       TIMESTAMPTZ DEFAULT NOW(),
  expires_at        TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  CONSTRAINT valid_status CHECK (mst_status IN ('active','suspended','dissolved','not_found','error'))
);

CREATE INDEX idx_company_verify_status ON company_verification_cache(mst_status);
CREATE INDEX idx_company_verify_expires ON company_verification_cache(expires_at);

-- Risk flags per invoice-company relationship
CREATE TABLE company_risk_flags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID REFERENCES companies(id),
  tax_code          VARCHAR(20),            -- the partner being flagged
  partner_type      VARCHAR(10),            -- 'seller' | 'buyer'
  risk_level        VARCHAR(10),            -- 'critical'|'high'|'medium'|'low'
  flag_types        TEXT[],                 -- array of flag codes (see below)
  flag_details      JSONB,                  -- details per flag
  invoice_ids       UUID[],                 -- affected invoices
  total_vat_at_risk NUMERIC(22,2),          -- total VAT from this partner at risk
  is_acknowledged   BOOLEAN DEFAULT false,
  acknowledged_by   UUID REFERENCES users(id),
  acknowledged_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, tax_code)
);

Flag codes (flag_types array values):
  'MST_NOT_FOUND'       -- MST không tồn tại trên GDT
  'MST_DISSOLVED'       -- DN đã giải thể/bị thu hồi MST
  'MST_SUSPENDED'       -- DN đang tạm ngừng hoạt động
  'NAME_MISMATCH'       -- Tên DN trên HĐ khác tên trên GDT >70%
  'ADDRESS_MISMATCH'    -- Địa chỉ không khớp
  'NEW_COMPANY_BIG_INV' -- DN mới (<6 tháng) với HĐ lớn (>50M)
  'SPLIT_INVOICE'       -- Nhiều HĐ nhỏ cùng ngày cùng MST (tránh duyệt)
  'HIGH_FREQUENCY'      -- Tần suất HĐ bất thường (>3 HĐ/tuần)
  'ZERO_HISTORY'        -- Không có lịch sử HĐ với bất kỳ DN nào trước đây
  'ROUND_AMOUNTS'       -- Tất cả HĐ đều số tiền tròn (dấu hiệu làm giả)

STEP 2 — Verification queue table:
CREATE TABLE verification_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code    VARCHAR(20) NOT NULL,
  priority    SMALLINT DEFAULT 5,    -- 1=highest (new critical partner), 10=lowest (refresh)
  status      VARCHAR(20) DEFAULT 'pending',
  attempts    SMALLINT DEFAULT 0,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tax_code)
);
```

### GHOST-02 — Company Lookup Service (GDT + DKKD)
```
[Respond in Vietnamese]
Create /backend/src/services/CompanyVerificationService.ts

This service looks up company information from official Vietnamese government sources
to detect ghost/inactive companies.

Data sources (in priority order):
  1. Internal cache: company_verification_cache (check expires_at first)
  2. GDT portal: http://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp
     Method: HTTP POST form submission (no public API — must scrape)
     Returns: company name, address, status, registration date
  3. DKKD portal: https://dangkykinhdoanh.gov.vn
     Returns: legal rep, business type, registered capital
  4. Fallback masothue.com: GET https://masothue.com/Search/Party?s={MST}
     Semi-official aggregator, useful for quick checks

import axios from 'axios'
import * as cheerio from 'cheerio'  // npm install cheerio

const GDT_LOOKUP_URL = 'http://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'http://tracuunnt.gdt.gov.vn/',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'vi-VN,vi;q=0.9',
  'Content-Type': 'application/x-www-form-urlencoded'
}

export class CompanyVerificationService {

  async verify(taxCode: string, forceRefresh = false): Promise<CompanyInfo> {
    // 1. Check cache first
    if (!forceRefresh) {
      const cached = await this.getFromCache(taxCode)
      if (cached && new Date(cached.expires_at) > new Date()) {
        return cached
      }
    }

    // 2. Lookup from GDT
    const result = await this.lookupFromGdt(taxCode)
    
    // 3. Save to cache
    await this.saveToCache(taxCode, result)
    return result
  }

  private async lookupFromGdt(taxCode: string): Promise<CompanyInfo> {
    try {
      // GDT uses form POST with MST parameter
      const response = await axios.post(GDT_LOOKUP_URL,
        new URLSearchParams({ 'mst': taxCode.trim() }),
        { headers: HEADERS, timeout: 15_000 }
      )

      const $ = cheerio.load(response.data)
      
      // Parse GDT response table (structure may change — use flexible selectors)
      const rows: Record<string, string> = {}
      $('table tr').each((_, row) => {
        const cells = $(row).find('td')
        if (cells.length >= 2) {
          const key   = $(cells[0]).text().trim()
          const value = $(cells[1]).text().trim()
          if (key && value) rows[key] = value
        }
      })

      // Check if company was found
      const pageText = $('body').text()
      if (pageText.includes('Không tìm thấy') || pageText.includes('không tồn tại')) {
        return {
          taxCode,
          mst_status: 'not_found',
          source: 'gdt',
          verified_at: new Date()
        }
      }

      // Extract fields (Vietnamese label matching)
      const name       = rows['Tên người nộp thuế:'] || rows['Tên đơn vị:'] || ''
      const address    = rows['Địa chỉ:'] || rows['Địa chỉ trụ sở:'] || ''
      const statusRaw  = rows['Tình trạng người nộp thuế:'] || rows['Trạng thái:'] || ''
      const regDate    = rows['Ngày bắt đầu hoạt động:'] || rows['Ngày cấp MST:'] || ''

      // Normalize status
      let mst_status: string
      if (statusRaw.toLowerCase().includes('đang hoạt động')) mst_status = 'active'
      else if (statusRaw.toLowerCase().includes('tạm ngừng'))  mst_status = 'suspended'
      else if (statusRaw.toLowerCase().includes('giải thể') ||
               statusRaw.toLowerCase().includes('thu hồi'))    mst_status = 'dissolved'
      else mst_status = 'active'  // default if status unclear

      return {
        taxCode, company_name: name, address, mst_status,
        registered_date: this.parseVnDate(regDate),
        source: 'gdt',
        raw_data: rows,
        verified_at: new Date()
      }
    } catch (err: any) {
      console.error(`[CompanyVerify] GDT lookup failed for ${taxCode}:`, err.message)
      // Fallback to masothue.com
      return this.lookupFromMasothue(taxCode)
    }
  }

  private async lookupFromMasothue(taxCode: string): Promise<CompanyInfo> {
    try {
      const res = await axios.get(
        `https://masothue.com/Search/Party?s=${taxCode}`,
        { headers: { ...HEADERS, 'Accept': 'application/json' }, timeout: 10_000 }
      )
      // Parse masothue JSON response
      const data = res.data
      if (!data || data.length === 0) {
        return { taxCode, mst_status: 'not_found', source: 'masothue', verified_at: new Date() }
      }
      const company = Array.isArray(data) ? data[0] : data
      return {
        taxCode,
        company_name:   company.name || company.ten || '',
        address:        company.address || company.diaChi || '',
        legal_rep:      company.legalRep || company.nguoiDaiDien || '',
        mst_status:     (company.status === '00' || !company.status) ? 'active' : 'dissolved',
        registered_date: this.parseVnDate(company.regDate || ''),
        source:         'masothue',
        raw_data:       company,
        verified_at:    new Date()
      }
    } catch {
      return { taxCode, mst_status: 'error', source: 'masothue', verified_at: new Date() }
    }
  }

  // Compare company name on invoice vs GDT — flag if very different
  compareNames(invoiceName: string, gdtName: string): number {
    // Simple similarity: normalize both and check word overlap
    const normalize = (s: string) => s.toLowerCase()
      .replace(/công ty|tnhh|cổ phần|cp|hd|ltd|co\.|,|\./g, '')
      .replace(/\s+/g, ' ').trim()
    const a = normalize(invoiceName).split(' ')
    const b = normalize(gdtName).split(' ')
    const common = a.filter(w => b.includes(w) && w.length > 2).length
    return common / Math.max(a.length, b.length)  // 0-1, higher = more similar
  }

  private parseVnDate(str: string): Date | undefined {
    if (!str) return undefined
    const match = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)
    if (!match) return undefined
    return new Date(`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`)
  }

  private async getFromCache(taxCode: string) {
    const res = await db.query(
      'SELECT * FROM company_verification_cache WHERE tax_code=$1', [taxCode]
    )
    return res.rows[0] || null
  }

  private async saveToCache(taxCode: string, info: CompanyInfo) {
    await db.query(`
      INSERT INTO company_verification_cache
        (tax_code, company_name, address, legal_rep, mst_status, registered_date,
         dissolved_date, source, raw_data, verified_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+INTERVAL '30 days')
      ON CONFLICT (tax_code) DO UPDATE SET
        company_name=EXCLUDED.company_name, address=EXCLUDED.address,
        mst_status=EXCLUDED.mst_status, verified_at=NOW(), expires_at=NOW()+INTERVAL '30 days'
    `, [taxCode, info.company_name, info.address, info.legal_rep,
        info.mst_status, info.registered_date, info.dissolved_date,
        info.source, JSON.stringify(info.raw_data)])
  }
}
```

### GHOST-03 — Risk Analysis Engine (Phát hiện công ty ma)
```
[Respond in Vietnamese]
Create /backend/src/services/GhostCompanyDetector.ts
Runs after each sync to analyze all unique seller/buyer tax codes in input invoices.

import { CompanyVerificationService } from './CompanyVerificationService'

export class GhostCompanyDetector {
  private verifier = new CompanyVerificationService()

  async analyzeCompany(
    companyId: string,
    partnerTaxCode: string,
    partnerType: 'seller' | 'buyer'
  ): Promise<RiskFlag[]> {
    const flags: RiskFlag[] = []

    // Get verification data
    const info = await this.verifier.verify(partnerTaxCode)

    // Get all invoices with this partner
    const invoices = await db.query(`
      SELECT * FROM invoices
      WHERE company_id=$1 AND deleted_at IS NULL
        AND CASE WHEN $3='seller' THEN seller_tax_code ELSE buyer_tax_code END = $2
      ORDER BY invoice_date DESC`, 
      [companyId, partnerTaxCode, partnerType]
    )
    const invList = invoices.rows
    const totalVatAtRisk = invList.reduce((s, i) => s + parseFloat(i.vat_amount || 0), 0)

    // ─── FLAG 1: MST không tồn tại ───────────────────────────────
    if (info.mst_status === 'not_found') {
      flags.push({
        code: 'MST_NOT_FOUND',
        level: 'critical',
        message: `MST ${partnerTaxCode} không tồn tại trên hệ thống GDT`,
        vat_at_risk: totalVatAtRisk
      })
    }

    // ─── FLAG 2: MST đã giải thể / thu hồi ────────────────────────
    if (info.mst_status === 'dissolved') {
      const lastInv = invList[0]
      if (lastInv && info.dissolved_date) {
        if (new Date(lastInv.invoice_date) > new Date(info.dissolved_date)) {
          flags.push({
            code: 'MST_DISSOLVED',
            level: 'critical',
            message: `${info.company_name} đã giải thể từ ${info.dissolved_date} nhưng vẫn xuất HĐ`,
            vat_at_risk: totalVatAtRisk,
            details: { dissolved_date: info.dissolved_date }
          })
        }
      }
    }

    // ─── FLAG 3: MST đang tạm ngừng ────────────────────────────────
    if (info.mst_status === 'suspended') {
      flags.push({
        code: 'MST_SUSPENDED',
        level: 'high',
        message: `${info.company_name} đang tạm ngừng hoạt động — HĐ có thể không hợp lệ`,
        vat_at_risk: totalVatAtRisk
      })
    }

    // ─── FLAG 4: Tên không khớp ────────────────────────────────────
    if (info.company_name && invList.length > 0) {
      const invName = partnerType === 'seller' ? invList[0].seller_name : invList[0].buyer_name
      const similarity = this.verifier.compareNames(invName, info.company_name)
      if (similarity < 0.4) {  // less than 40% word match
        flags.push({
          code: 'NAME_MISMATCH',
          level: 'high',
          message: `Tên trên HĐ "${invName}" khác biệt với GDT "${info.company_name}"`,
          details: { similarity: Math.round(similarity * 100) + '%' }
        })
      }
    }

    // ─── FLAG 5: DN mới + HĐ lớn ───────────────────────────────────
    if (info.registered_date && partnerType === 'seller') {
      const monthsOld = (Date.now() - new Date(info.registered_date).getTime())
                        / (1000 * 60 * 60 * 24 * 30)
      const bigInvoices = invList.filter(i => parseFloat(i.total_amount) > 50_000_000)
      if (monthsOld < 6 && bigInvoices.length > 0) {
        flags.push({
          code: 'NEW_COMPANY_BIG_INV',
          level: 'high',
          message: `DN mới thành lập ${Math.round(monthsOld)} tháng nhưng đã xuất ${bigInvoices.length} HĐ > 50 triệu`,
          details: { months_old: Math.round(monthsOld), big_invoice_count: bigInvoices.length }
        })
      }
    }

    // ─── FLAG 6: Phân nhỏ HĐ (nhiều HĐ nhỏ cùng ngày) ────────────
    const byDate: Record<string, number> = {}
    invList.forEach(i => {
      const d = i.invoice_date?.toISOString().slice(0, 10)
      byDate[d] = (byDate[d] || 0) + 1
    })
    const splitDays = Object.values(byDate).filter(count => count >= 3)
    if (splitDays.length > 0) {
      flags.push({
        code: 'SPLIT_INVOICE',
        level: 'medium',
        message: `Phát hiện ${splitDays.length} ngày có từ 3+ HĐ từ cùng 1 NCC — có thể chia nhỏ để tránh duyệt`,
        details: { affected_days: splitDays.length }
      })
    }

    // ─── FLAG 7: Toàn bộ HĐ có số tiền tròn ────────────────────────
    if (invList.length >= 3) {
      const roundCount = invList.filter(i => {
        const amt = parseFloat(i.total_amount)
        return amt > 0 && amt % 1_000_000 === 0
      }).length
      if (roundCount / invList.length > 0.9) {
        flags.push({
          code: 'ROUND_AMOUNTS',
          level: 'medium',
          message: `${roundCount}/${invList.length} HĐ có số tiền tròn chính xác (triệu VND) — dấu hiệu bất thường`,
        })
      }
    }

    return flags
  }

  async runForCompany(companyId: string): Promise<void> {
    // Get all unique seller tax codes from input invoices (direction='input')
    const sellers = await db.query(`
      SELECT DISTINCT seller_tax_code, seller_name,
        SUM(vat_amount) as total_vat, COUNT(*) as invoice_count
      FROM invoices
      WHERE company_id=$1 AND direction='input'
        AND deleted_at IS NULL AND is_permanently_ignored=false
        AND seller_tax_code IS NOT NULL AND seller_tax_code != 'B2C'
      GROUP BY seller_tax_code, seller_name
      HAVING SUM(vat_amount) > 0
      ORDER BY SUM(vat_amount) DESC
    `, [companyId])

    for (const seller of sellers.rows) {
      // Rate limit: 1 verification per 2 seconds
      await new Promise(r => setTimeout(r, 2_000))
      
      const flags = await this.analyzeCompany(companyId, seller.seller_tax_code, 'seller')
      if (flags.length > 0) {
        await this.saveRiskFlags(companyId, seller.seller_tax_code, 'seller', flags, seller.total_vat)
      }
    }
  }

  private async saveRiskFlags(
    companyId: string, taxCode: string, partnerType: string,
    flags: RiskFlag[], totalVatAtRisk: number
  ) {
    const maxLevel = flags.some(f => f.level === 'critical') ? 'critical'
                   : flags.some(f => f.level === 'high') ? 'high' : 'medium'
    
    await db.query(`
      INSERT INTO company_risk_flags
        (company_id, tax_code, partner_type, risk_level, flag_types, flag_details, total_vat_at_risk)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (company_id, tax_code) DO UPDATE SET
        risk_level=$4, flag_types=$5, flag_details=$6,
        total_vat_at_risk=$7, updated_at=NOW(), is_acknowledged=false
    `, [companyId, taxCode, partnerType, maxLevel,
        flags.map(f => f.code), JSON.stringify(flags), totalVatAtRisk])

    // Create notification for critical flags
    if (maxLevel === 'critical') {
      const info = await this.verifier.verify(taxCode)
      await createNotification(companyId, {
        type: 'GHOST_COMPANY_CRITICAL',
        title: '🚨 Phát hiện công ty nghi ngờ ma',
        body: `NCC "${info.company_name || taxCode}" có dấu hiệu bất thường nghiêm trọng — ${flags[0].message}. VAT đầu vào có nguy cơ: ${formatVND(totalVatAtRisk)}`
      })
    }
  }
}
```

### GHOST-04 — Ghost Company Alert UI
```
[Respond in Vietnamese]
Create /audit/ghost-companies page — "Kiểm Tra Công Ty Ma" dashboard.
This is a critical compliance feature — accountants check this before finalizing VAT declaration.

Backend:
  GET /api/audit/ghost-companies?companyId=&riskLevel=&acknowledged=false
  GET /api/audit/ghost-companies/summary?companyId=
    Returns: { critical: N, high: N, medium: N, total_vat_at_risk: amount }
  POST /api/audit/ghost-companies/:taxCode/verify-now → trigger immediate re-verification
  PATCH /api/audit/ghost-companies/:taxCode/acknowledge → mark as reviewed
  GET /api/audit/ghost-companies/:taxCode/detail → full company info + all flags + invoices

Page layout:

Header: "Kiểm Tra Đối Tác — Phát Hiện Công Ty Ma" + shield icon

Summary alert banner (RED if critical > 0):
  "🚨 Phát hiện [N] nhà cung cấp có dấu hiệu bất thường
  Tổng VAT đầu vào có thể bị loại khỏi khấu trừ: [amount]
  [Xem chi tiết] button"

Explanation card (collapsible, shown first time):
  "Công ty ma là doanh nghiệp đã giải thể, tạm ngừng hoặc không tồn tại
  nhưng vẫn xuất hóa đơn. Nếu DN bạn khấu trừ VAT từ các hóa đơn này,
  cơ quan thuế có thể truy thu 100% số thuế + phạt 20%."

Severity filter tabs:
  🔴 Nghiêm trọng ([N]) | 🟠 Cảnh báo ([N]) | 🟡 Lưu ý ([N]) | ✅ Đã kiểm tra

Risk company cards:
  Left border color: red=critical, orange=high, yellow=medium
  
  Card header:
    Tên công ty (from GDT) vs Tên trên HĐ (from invoice) — show both if different
    MST: [tax_code] | Trạng thái GDT: [badge: Đã giải thể / Tạm ngừng / Không tồn tại / Đang hoạt động]
    VAT đầu vào có nguy cơ: [total_vat_at_risk] (red, large font)
    [N] hóa đơn bị ảnh hưởng
  
  Flag list (inside card):
    Each flag as a row:
      [FLAG ICON] [FLAG NAME] — [explanation in Vietnamese]
    Examples:
      🚫 MST đã giải thể — Công ty này đã giải thể từ 01/2024 nhưng vẫn xuất HĐ trong T3/2026
      ⚠️ Tên không khớp — "Cty TNHH ABC" (HĐ) vs "Công ty TNHH Alpha Beta" (GDT) — chỉ 30% tương đồng
      📋 DN mới, HĐ lớn — Mới thành lập 3 tháng, đã xuất 5 HĐ > 50 triệu
  
  Company info (from GDT, collapsible):
    Tên chính thức | Người đại diện | Địa chỉ đăng ký | Ngày thành lập | Trạng thái
  
  Action buttons:
    [Xem hóa đơn liên quan] → /invoices?sellerTaxCode=X (filtered)
    [Kiểm tra lại ngay] → POST verify-now (re-fetch from GDT)
    [Đánh dấu đã kiểm tra] → acknowledge with note
      Modal: "Ghi chú xác nhận" textarea + "Tôi xác nhận đã kiểm tra và chấp nhận rủi ro" checkbox
    [Bỏ qua toàn bộ HĐ] → bulk permanent-ignore all invoices from this partner

Warning box at bottom of page:
  "Lưu ý: Dữ liệu từ tracuunnt.gdt.gov.vn được cập nhật mỗi 30 ngày.
  Bấm 'Kiểm tra lại ngay' để lấy thông tin mới nhất trước khi nộp tờ khai thuế."
```

### GHOST-05 — Integration: Auto-verify on import + dashboard widget
```
[Respond in Vietnamese]
Integrate ghost company detection into the existing workflows.

1. Auto-run after every import/sync:
   In SyncWorker (sync.worker.ts) and manual import flow:
   After bulkUpsertInvoices() completes:
     const detector = new GhostCompanyDetector()
     await detector.runForCompany(companyId)
     -- runs in background, don't block main sync flow
     -- queue it as a BullMQ job: 'ghost-detection-queue' with delay 5000ms

2. Dashboard widget — "Kiểm Tra Đối Tác" card:
   Add to dashboard (next to AI Anomaly widget):
   
   GET /api/audit/ghost-companies/summary?companyId= (cached 1h)
   
   If critical > 0:
     Red card: "🚨 [N] đối tác nghi ngờ công ty ma | VAT nguy cơ: [amount]"
     [Kiểm tra ngay →] link to /audit/ghost-companies
   
   If high > 0 but no critical:
     Orange card: "⚠️ [N] đối tác cần xem xét | VAT nguy cơ: [amount]"
   
   If all clear:
     Green card: "✅ Tất cả [N] đối tác đã được xác minh — không phát hiện bất thường"
     Sub: "Cập nhật lúc: [last_run_time]"

3. VAT Reconciliation gate:
   In TaxDeclarationEngine.calculateDeclaration():
   Before finalizing [23] (deductible input VAT):
   
   const criticalPartners = await db.query(`
     SELECT tax_code, total_vat_at_risk FROM company_risk_flags
     WHERE company_id=$1 AND risk_level='critical' AND is_acknowledged=false
   `, [companyId])
   
   If criticalPartners.rows.length > 0:
     declaration.warnings.push({
       type: 'UNVERIFIED_CRITICAL_PARTNERS',
       message: `Có ${criticalPartners.rows.length} NCC nghi ngờ công ty ma chưa được xác nhận.
                 VAT đầu vào có nguy cơ bị loại: ${totalAtRisk}.
                 Kiểm tra tại /audit/ghost-companies trước khi nộp tờ khai.`
     })
     declaration.ct23_confidence = 'low'  -- flag as uncertain

4. Rate limiting for GDT verification:
   BullMQ queue 'ghost-detection-queue':
     Rate limiter: max 1 verification per 3 seconds (avoid GDT blocking)
     concurrency: 1 (sequential, not parallel)
     Process new companies first (priority by total_vat_at_risk DESC)
     Re-verify existing cache every 30 days automatically
```


---

## GROUP 44 — ADMIN LICENSE MANAGEMENT SYSTEM

> Hệ thống Admin quản lý license và quota cho toàn bộ user của platform HĐĐT.
> Admin là superuser riêng biệt — không phải OWNER/ADMIN của một công ty.
> Quota = số hóa đơn đồng bộ từ GDT về mỗi tháng (đầu vào + đầu ra tính chung).

### LIC-01 — DB Schema: License Plans + User Subscriptions
```
[Respond in Vietnamese]
Create migration /scripts/013_license_system.sql

-- 1. License plans (admin-managed pricing tiers)
CREATE TABLE license_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(30) UNIQUE NOT NULL,   -- 'BASIC_1K','BASIC_2500','ENT_100K'
  name            VARCHAR(100) NOT NULL,           -- "Gói 1.000 HĐ/tháng"
  tier            VARCHAR(20) NOT NULL,            -- 'basic' | 'enterprise'
  invoice_quota   INT NOT NULL,                    -- max invoices per month
  price_per_month NUMERIC(12,0) NOT NULL,          -- VND/month
  price_per_invoice NUMERIC(8,0),                  -- VND per invoice (display only)
  max_companies   INT DEFAULT 5,                   -- max companies per subscription
  max_users       INT DEFAULT 3,                   -- max team members
  features        JSONB DEFAULT '{}',              -- { ai_chat, anomaly_detection, ... }
  is_active       BOOLEAN DEFAULT true,
  sort_order      SMALLINT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Seed from pricing table in image
INSERT INTO license_plans (code, name, tier, invoice_quota, price_per_month, price_per_invoice, max_companies, max_users) VALUES
  ('BASIC_1K',    'Gói 1.000 HĐ/tháng',    'basic',      1000,   250000,  250, 2,  2),
  ('BASIC_2500',  'Gói 2.500 HĐ/tháng',    'basic',      2500,   500000,  200, 3,  3),
  ('BASIC_5K',    'Gói 5.000 HĐ/tháng',    'basic',      5000,   750000,  150, 5,  5),
  ('BASIC_10K',   'Gói 10.000 HĐ/tháng',   'basic',      10000,  1000000, 100, 10, 10),
  ('ENT_20K',     'Gói 20.000 HĐ/tháng',   'enterprise', 20000,  1600000, 80,  20, 20),
  ('ENT_50K',     'Gói 50.000 HĐ/tháng',   'enterprise', 50000,  3500000, 70,  50, 50),
  ('ENT_80K',     'Gói 80.000 HĐ/tháng',   'enterprise', 80000,  4800000, 60,  100,100),
  ('ENT_100K',    'Gói 100.000 HĐ/tháng',  'enterprise', 100000, 5000000, 50,  999,999);

-- 2. User subscriptions
CREATE TABLE user_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           UUID NOT NULL REFERENCES license_plans(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
  -- 'trial'|'active'|'suspended'|'expired'|'cancelled'
  
  -- Billing period
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,           -- end of current period
  trial_ends_at     TIMESTAMPTZ,                    -- NULL if not trial
  
  -- Quota tracking (reset monthly by cron)
  quota_total       INT NOT NULL,                   -- copy from plan at purchase
  quota_used        INT NOT NULL DEFAULT 0,         -- invoices synced this month
  quota_reset_at    TIMESTAMPTZ,                    -- when quota was last reset
  
  -- Admin management
  granted_by        UUID REFERENCES users(id),      -- admin who issued this license
  grant_notes       TEXT,                            -- admin notes
  is_manually_set   BOOLEAN DEFAULT false,           -- true = admin override
  
  -- Payment (basic tracking, not full billing system)
  last_paid_at      TIMESTAMPTZ,
  payment_reference VARCHAR(100),                   -- bank transfer reference, etc.
  
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)  -- one active subscription per user
);

-- 3. Quota usage log (for audit + analytics)
CREATE TABLE quota_usage_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  company_id    UUID REFERENCES companies(id),
  invoices_added INT NOT NULL,
  source        VARCHAR(20),    -- 'gdt_bot'|'manual_import'|'provider_sync'
  logged_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Admin users (separate from regular users)
-- Add to existing users table:
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- 5. License history (audit trail)
CREATE TABLE license_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id),
  action        VARCHAR(30),  -- 'grant'|'renew'|'upgrade'|'downgrade'|'suspend'|'enable'|'cancel'
  old_plan_id   UUID REFERENCES license_plans(id),
  new_plan_id   UUID REFERENCES license_plans(id),
  old_status    VARCHAR(20),
  new_status    VARCHAR(20),
  expires_at    TIMESTAMPTZ,
  performed_by  UUID REFERENCES users(id),  -- admin user
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Indexes
CREATE INDEX idx_subscriptions_user    ON user_subscriptions(user_id);
CREATE INDEX idx_subscriptions_status  ON user_subscriptions(status);
CREATE INDEX idx_subscriptions_expires ON user_subscriptions(expires_at);
CREATE INDEX idx_quota_log_user_month  ON quota_usage_log(user_id, logged_at DESC);
```

### LIC-02 — Quota Enforcement Service
```
[Respond in Vietnamese]
Create /backend/src/services/QuotaService.ts
This service enforces invoice sync limits and is called before every sync operation.

export class QuotaService {

  async getSubscription(userId: string): Promise<Subscription | null> {
    const res = await db.query(`
      SELECT s.*, p.invoice_quota, p.code as plan_code, p.name as plan_name,
             p.tier, p.max_companies, p.max_users
      FROM user_subscriptions s
      JOIN license_plans p ON s.plan_id = p.id
      WHERE s.user_id = $1
    `, [userId])
    return res.rows[0] || null
  }

  async checkCanSync(userId: string, estimatedInvoices: number = 1): Promise<QuotaCheck> {
    const sub = await this.getSubscription(userId)
    
    if (!sub) {
      return { allowed: false, reason: 'NO_SUBSCRIPTION', message: 'Tài khoản chưa có gói dịch vụ' }
    }
    if (sub.status === 'suspended') {
      return { allowed: false, reason: 'SUSPENDED', message: 'Tài khoản đã bị tạm ngừng. Liên hệ admin.' }
    }
    if (sub.status === 'expired') {
      return { allowed: false, reason: 'EXPIRED', message: 'Gói dịch vụ đã hết hạn. Vui lòng gia hạn.' }
    }
    if (new Date(sub.expires_at) < new Date()) {
      await this.expireSubscription(sub.id)
      return { allowed: false, reason: 'EXPIRED', message: 'Gói dịch vụ đã hết hạn. Vui lòng gia hạn.' }
    }
    
    const remaining = sub.quota_total - sub.quota_used
    const usedPct   = (sub.quota_used / sub.quota_total) * 100
    
    if (remaining <= 0) {
      return {
        allowed: false, reason: 'QUOTA_EXCEEDED',
        message: `Đã dùng hết ${sub.quota_total.toLocaleString()} HĐ trong tháng này.`,
        quota: { used: sub.quota_used, total: sub.quota_total, remaining: 0, usedPct: 100 }
      }
    }
    if (remaining < estimatedInvoices) {
      return {
        allowed: false, reason: 'QUOTA_INSUFFICIENT',
        message: `Chỉ còn ${remaining} HĐ trong hạn mức, không đủ để đồng bộ ${estimatedInvoices} HĐ.`,
        quota: { used: sub.quota_used, total: sub.quota_total, remaining, usedPct }
      }
    }

    return {
      allowed: true, reason: null,
      warning: usedPct >= 80 ? this.buildWarning(usedPct, remaining, sub) : null,
      quota: { used: sub.quota_used, total: sub.quota_total, remaining, usedPct }
    }
  }

  async consumeQuota(userId: string, companyId: string, count: number, source: string): Promise<void> {
    await db.query('BEGIN')
    try {
      await db.query(`
        UPDATE user_subscriptions
        SET quota_used = quota_used + $2, updated_at = NOW()
        WHERE user_id = $1 AND status = 'active'
      `, [userId, count])
      
      await db.query(`
        INSERT INTO quota_usage_log (user_id, company_id, invoices_added, source)
        VALUES ($1, $2, $3, $4)
      `, [userId, companyId, count, source])
      
      await db.query('COMMIT')
    } catch (err) {
      await db.query('ROLLBACK')
      throw err
    }
    
    // Check if warning threshold crossed — send notification
    const sub = await this.getSubscription(userId)
    if (sub) {
      const usedPct = (sub.quota_used / sub.quota_total) * 100
      if (usedPct >= 90 && usedPct - (count / sub.quota_total * 100) < 90) {
        await this.sendQuotaWarning(userId, usedPct, sub.quota_total - sub.quota_used)
      }
    }
  }

  // Cron job: reset quota on 1st of each month
  async resetMonthlyQuotas(): Promise<void> {
    const res = await db.query(`
      UPDATE user_subscriptions
      SET quota_used = 0, quota_reset_at = NOW(), updated_at = NOW()
      WHERE status IN ('active', 'trial')
      RETURNING user_id
    `)
    console.log(`[QuotaService] Reset quotas for ${res.rowCount} active subscriptions`)
  }

  private buildWarning(usedPct: number, remaining: number, sub: any) {
    if (usedPct >= 95) return {
      level: 'critical',
      message: `Còn ${remaining} HĐ (${(100-usedPct).toFixed(0)}%) — Gần hết hạn mức!`,
      action: 'upgrade'
    }
    if (usedPct >= 80) return {
      level: 'warning',
      message: `Đã dùng ${usedPct.toFixed(0)}% hạn mức tháng này`,
      action: 'consider_upgrade'
    }
    return null
  }

  private async sendQuotaWarning(userId: string, usedPct: number, remaining: number) {
    await createNotification(userId, null, {
      type: 'QUOTA_WARNING',
      title: usedPct >= 95 ? '🚨 Sắp hết hạn mức đồng bộ' : '⚠️ Hạn mức sắp cạn',
      body: `Đã dùng ${usedPct.toFixed(0)}% hạn mức — còn ${remaining} hóa đơn. Nâng gói để tiếp tục đồng bộ.`
    })
    // Also push to VAPID
  }

  private async expireSubscription(subId: string) {
    await db.query(
      "UPDATE user_subscriptions SET status='expired', updated_at=NOW() WHERE id=$1",
      [subId]
    )
  }
}

export const quotaService = new QuotaService()

-- Integrate into SyncWorker (sync.worker.ts):
-- BEFORE starting sync:
  const userId = await getUserIdForCompany(companyId)
  const check  = await quotaService.checkCanSync(userId, estimatedCount)
  if (!check.allowed) {
    throw new UnrecoverableError(`Sync blocked: ${check.reason} — ${check.message}`)
  }

-- AFTER successful sync:
  await quotaService.consumeQuota(userId, companyId, actualCount, 'gdt_bot')
```

### LIC-03 — Admin Panel Backend APIs
```
[Respond in Vietnamese]
Create /backend/src/routes/admin.ts — Admin-only API routes.
All routes require: is_platform_admin = true (checked in middleware).

Create middleware /backend/src/middleware/adminAuth.ts:
  Check: decoded JWT user has is_platform_admin=true
  If not: return 403 { error: 'ADMIN_ONLY', message: 'Chỉ Admin hệ thống mới có quyền truy cập' }

Admin API endpoints:

-- USER MANAGEMENT
GET  /admin/users
  Query params: status, plan, search (name/email), page, pageSize=20
  Returns: users with subscription info, usage stats, company count
  SQL: JOIN users + user_subscriptions + license_plans
       + subquery: company count, total invoices this month

GET  /admin/users/:id
  Returns: full user profile + subscription + license history + all companies with stats

PATCH /admin/users/:id/status
  Body: { status: 'active'|'suspended', reason: string }
  If suspended: also suspend subscription
  Log to license_history

-- LICENSE MANAGEMENT
POST /admin/users/:id/grant-license
  Body: { planCode: string, months: number, notes?: string, paymentRef?: string }
  Logic:
    1. Find plan by code
    2. Calculate expires_at = NOW() + months
    3. Upsert user_subscriptions (reset quota_used=0)
    4. Log to license_history (action='grant')
    5. Send welcome notification to user
  Return: { subscription, plan }

PATCH /admin/users/:id/renew
  Body: { months: number, notes?: string, paymentRef?: string }
  Logic: extend expires_at by N months from current expiry (not from now)
  Log to license_history (action='renew')

PATCH /admin/users/:id/upgrade
  Body: { newPlanCode: string, notes?: string }
  Logic: change plan, update quota_total, keep quota_used, recalculate expires_at
  Log to license_history (action='upgrade' or 'downgrade')

PATCH /admin/users/:id/suspend
  Body: { reason: string }
  Set subscription.status='suspended', user active=false
  Send notification to user

PATCH /admin/users/:id/enable
  Body: { notes?: string }
  Set subscription.status='active', user active=true
  Send notification to user

DELETE /admin/users/:id/subscription
  Body: { reason: string, confirm: 'CANCEL_SUBSCRIPTION' }
  Soft-cancel: set status='cancelled', keep data

-- QUOTA MANAGEMENT
GET /admin/users/:id/quota
  Returns: current quota usage + monthly history (last 6 months)

PATCH /admin/users/:id/quota/adjust
  Body: { adjustment: number, reason: string }
  Add or subtract from quota_used (admin override)
  Example: { adjustment: -500, reason: 'Error correction — refund 500 invoices' }
  Log to quota_usage_log with source='admin_adjustment'

POST /admin/quota/reset-all
  Reset all active subscriptions to quota_used=0
  Typically run on 1st of month by cron, but admin can trigger manually
  Require: { confirm: 'RESET_ALL_QUOTAS' } in body

-- PLAN MANAGEMENT
GET    /admin/plans             → list all plans
POST   /admin/plans             → create new plan
PATCH  /admin/plans/:id        → update plan (price, quota, features)
DELETE /admin/plans/:id        → deactivate plan (set is_active=false)

-- OVERVIEW & ANALYTICS
GET /admin/overview
  Returns:
    total_users, active_users, trial_users, suspended_users, expired_users
    total_revenue_this_month (sum of plan prices for active subs)
    total_invoices_synced_this_month (across all users)
    top_usage_users: top 10 by quota_used this month
    expiring_soon: users with expires_at < NOW()+7 days
    new_signups_this_month: count

GET /admin/analytics/usage
  Returns monthly usage stats: invoices synced, active users, new users (12 months)
```

### LIC-04 — Admin Frontend: /admin pages
```
[Respond in Vietnamese]
Create the complete Admin Panel frontend.
Admin panel lives at /admin/* routes — completely separate from user-facing /dashboard etc.
Redirect non-admin users away immediately.

Admin layout (/admin/layout.tsx):
  Sidebar navigation:
    📊 Tổng quan (/admin)
    👥 Quản lý User (/admin/users)
    📋 Gói dịch vụ (/admin/plans)
    📈 Báo cáo (/admin/reports)
  Header: "Admin Panel" badge + logged-in admin name
  Dark/professional theme option (optional)

Page 1 — /admin (Overview Dashboard):

  Top stats row (4 cards):
    Tổng user: [N] | Active: [N] (green) | Trial: [N] (blue) | Hết hạn: [N] (red)
  
  Revenue summary card:
    Doanh thu ước tính tháng này: SUM of plan prices for active subs
    Format: [amount VND]
    Sub: "[N] gói đang hoạt động"
  
  Expiring soon alert table:
    Users whose expires_at < NOW() + 7 days
    Columns: Tên user | Email | Gói | Hết hạn | Ngày còn lại | [Gia hạn ngay]
    Sort by days remaining ASC (most urgent first)
  
  Top usage users table:
    Top 10 users by quota_used this month
    Columns: User | Gói | Hạn mức | Đã dùng | % | Số công ty | [Xem chi tiết]
    Progress bar in % column
  
  Recent activity feed:
    Last 20 license_history entries
    "[Admin] cấp gói ENT_20K cho [user] — 1 tháng | 2h trước"

Page 2 — /admin/users (User Management):

  Search + filter bar:
    Search: email/name | Filter: Status dropdown | Plan dropdown | Tier dropdown
    Sort: by created_at | quota_used | expires_at
  
  User table (sortable):
    Avatar | Tên | Email | Gói hiện tại | Trạng thái | Hạn mức (bar) | Hết hạn | Số CT | Hành động
  
  Status badges: Active(green) | Trial(blue) | Suspended(red) | Expired(gray) | Cancelled(dark)
  
  Quota column: mini progress bar [██████░░] 65% (color: green<80, orange<95, red>=95)
  
  Action menu per row (⋮):
    [Xem chi tiết]
    [Cấp / Đổi gói]
    [Gia hạn]
    [Điều chỉnh hạn mức]
    [Tạm ngừng] / [Kích hoạt]
    [Xem lịch sử]

Page 3 — /admin/users/:id (User Detail):

  User profile section:
    Avatar + Name + Email + Phone | Created at | Last login
    [Tạm ngừng tài khoản] / [Kích hoạt] button (top-right)
  
  Current subscription card:
    Plan name + tier badge | Status badge
    Hết hạn: [date] — Còn [N] ngày (red if < 7)
    Quota: [used] / [total] HĐ — [N] còn lại
    Progress bar (full width)
    [Gia hạn] [Đổi gói] [Điều chỉnh quota] buttons
  
  Companies section:
    Table: Tên CT | MST | Số HĐ tháng này | Tổng DT | Tổng CP | Kết nối
  
  License history table:
    Action | Gói cũ → Gói mới | Admin | Ghi chú | Thời gian
  
  Grant/Renew modal (shared):
    Select plan: radio list of all active plans (show price + quota per plan)
    Duration: [1 tháng] [3 tháng] [6 tháng] [12 tháng] (radio, price shown)
    Ghi chú admin: textarea
    Mã thanh toán: text (bank transfer ref)
    [Xác nhận cấp license]

Page 4 — /admin/plans (Plan Management):

  Plan list table:
    Code | Tên gói | Tier | Hạn mức | Giá/tháng | Đ.giá/HĐ | Max CT | Đang dùng | Trạng thái | Sửa
  
  "Đang dùng" = COUNT of active subscriptions with this plan
  
  [+ Tạo gói mới] button → form modal:
    Code, Name, Tier, invoice_quota, price_per_month, max_companies, max_users
    Features checkboxes: AI Chat, Anomaly Detection, Ghost Company Check, ESG Report
  
  Edit plan: same form, pre-filled
  Deactivate: confirm dialog "Gói này đang có [N] user đang dùng. Họ sẽ giữ nguyên cho đến khi hết hạn."
```

### LIC-05 — User-Facing Quota UI (Warnings + Upgrade Prompts)
```
[Respond in Vietnamese]
Create quota status components visible to end users (non-admin).

1. Quota status bar (show in app header or settings):
   GET /api/subscription/me → returns current subscription + quota info
   
   QuotaStatusBar component (show in settings or /dashboard header):
     Label: "Hạn mức tháng này:"
     Progress bar: [████████░░] 82% — 1.800 / 2.500 HĐ
     Color: green<80%, orange 80-95%, red≥95%
     Sub-text: "Còn [N] HĐ | Làm mới ngày 01/[next month]"
     [Nâng gói] button (shown when >80%)

2. Warning Banner (sticky, dismissible):
   Show when quota_used/quota_total >= 80%

   Level WARNING (80-95%): orange background
     "⚠️ Bạn đã dùng [X]% hạn mức đồng bộ tháng này — còn [N] hóa đơn.
     Nâng gói để không bị gián đoạn."
     [Nâng gói ngay] [Nhắc sau]

   Level CRITICAL (95-99%): red background
     "🚨 Chỉ còn [N] hóa đơn trong hạn mức! Đồng bộ sẽ bị dừng khi hết."
     [Nâng gói ngay] — no dismiss option

3. Quota Exceeded State (quota_used >= quota_total):
   Full-screen overlay (not blocking navigation, but blocking sync actions):
   
   Modal / large card:
     Lock icon (🔒)
     "Đã hết hạn mức đồng bộ tháng này"
     Sub: "Bạn đã đồng bộ [N] hóa đơn — đã đạt giới hạn gói [Plan Name]."
     
     Upgrade options (show 2 next tiers):
       Current plan:   [Plan Name]     [N] HĐ/tháng    [price]    Hiện tại
       Next tier:      [Plan Name+1]   [N] HĐ/tháng    [price]    [Nâng cấp]
       Skip tier:      [Plan Name+2]   [N] HĐ/tháng    [price]    [Nâng cấp]
     
     "Hoặc liên hệ admin để được hỗ trợ: [admin email/phone]"
     [Đóng] — user can still view existing data, just can't sync

4. Subscription Expired State:
   Show when status='expired' OR expires_at < NOW():
   
   Banner (persistent, top of every page):
     "📅 Gói dịch vụ của bạn đã hết hạn ngày [date].
     Dữ liệu của bạn vẫn được lưu trữ an toàn — hãy gia hạn để tiếp tục sử dụng."
     [Liên hệ gia hạn] → mailto or contact form
   
   Disabled features (gray out, show lock icon):
     Đồng bộ hóa đơn → locked
     Export dữ liệu → locked (can still view)
     AI features → locked
     (Can still view/read all existing data)

5. Suspended State:
   Full-page block (can't access any features):
   
   "Tài khoản tạm ngừng hoạt động"
   "Tài khoản của bạn đã bị tạm ngừng. Vui lòng liên hệ quản trị viên để biết thêm chi tiết."
   [Liên hệ Admin] button
   [Đăng xuất]

6. Trial State (trial_ends_at is set):
   Small banner (dismissible):
   "🎁 Bạn đang dùng thử — còn [N] ngày | [N] HĐ còn lại trong gói thử"
   [Đăng ký gói chính thức]

Component integration:
  - Add QuotaStatusBar to /settings/profile and /dashboard
  - Check quota state in layout.tsx and show appropriate banners
  - In SyncWorker error handling: catch QUOTA_EXCEEDED → update UI state via WebSocket or polling
  - Cache subscription state in React Context, refresh every 5 minutes
```

### LIC-06 — Billing & Notifications
```
[Respond in Vietnamese]
Create subscription lifecycle notifications and basic billing tracking.

1. Automated notification schedule (BullMQ cron jobs):

  Job: ExpiryReminderJob (runs daily at 9:00 AM)
    Find subscriptions where expires_at BETWEEN NOW() AND NOW()+7 days
    AND last_reminder_sent < NOW()-2 days (avoid spam)
    
    For each: send push + Telegram (if configured):
      7 days before: "📅 Gói dịch vụ hết hạn sau 7 ngày — [date]. Liên hệ admin để gia hạn."
      3 days before: "⚠️ Còn 3 ngày! Gói [plan] hết hạn ngày [date]."
      1 day before:  "🚨 KHẨN: Gói hết hạn ngày mai! Liên hệ ngay để tránh gián đoạn."
      On expiry day: "❌ Gói dịch vụ đã hết hạn hôm nay. Đồng bộ đã bị dừng."

  Job: QuotaResetJob (runs at 00:01 on 1st of each month)
    Call quotaService.resetMonthlyQuotas()
    Send notification to all active users:
      "🔄 Hạn mức đồng bộ đã được làm mới — [N] HĐ/tháng cho tháng [M]/[Y]"

  Job: QuotaWarningJob (runs every 6 hours)
    Find subscriptions where quota_used/quota_total >= 0.80
    AND no warning sent in last 3 days
    Send push notification (see LIC-05 warning messages)

2. Admin notification:
  When any user reaches 95% quota: notify platform admin
  When any user's subscription expires: notify platform admin
  
  Admin daily digest email (optional, 8:00 AM):
    Summary: N expiring this week | N at quota limit | N new signups | Revenue estimate

3. Invoice for subscription (basic):
  POST /admin/users/:id/generate-invoice
    Generate simple text/PDF invoice:
      Đơn vị cung cấp: [Your company]
      Người dùng: [name, email]
      Gói dịch vụ: [plan name]
      Kỳ sử dụng: [from] → [to]
      Số tiền: [price VND]
      Hình thức thanh toán: Chuyển khoản
    
    Save to user_invoices table (simple, not linked to HĐĐT invoices)
    Email PDF to user

4. Subscription status API for frontend:
  GET /api/subscription/me
  Response: {
    plan: { name, code, tier, invoice_quota },
    status: 'active'|'trial'|'suspended'|'expired',
    expires_at: ISO date,
    days_remaining: number,
    quota: {
      total: number,
      used: number,
      remaining: number,
      used_pct: number,
      reset_at: ISO date  -- 1st of next month
    },
    warnings: [{ level: 'critical'|'warning', message: string }],
    upgrade_suggestions: [{ planCode, name, quota, price }]  -- next 2 tiers
  }
  Cache: Redis TTL 5 minutes per userId
```


---

## GROUP 45 — CONFIG-DRIVEN TAX DECLARATION ENGINE

> Vấn đề hiện tại: tờ khai 01/GTGT được hardcode trong TaxDeclarationEngine.ts.
> Khi Bộ Tài chính thay đổi mẫu biểu (thêm chỉ tiêu, đổi công thức) → phải sửa code → deploy.
> Giải pháp: toàn bộ cấu trúc form, công thức tính, validation rules lưu JSON trong DB.
> Khi thay đổi: admin edit JSON → hiệu lực ngay, không cần deploy.

### TAX-CFG-01 — DB Schema: Form Definition + Formula Engine
```
[Respond in Vietnamese]
Create migration /scripts/014_tax_form_config.sql
Implement a config-driven tax declaration system.

-- 1. Tax form versions (mỗi lần Bộ TC ban hành mẫu mới = 1 version)
CREATE TABLE tax_form_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_code       VARCHAR(30) NOT NULL,        -- '01/GTGT', '04/GTGT', '01/TNCN'
  version_name    VARCHAR(50) NOT NULL,         -- 'TT80/2021', 'TT13/2023'
  effective_from  DATE NOT NULL,                -- ngày bắt đầu áp dụng
  effective_to    DATE,                         -- NULL = đang hiệu lực
  is_current      BOOLEAN DEFAULT false,        -- chỉ 1 version is_current per form_code
  description     TEXT,                        -- ghi chú thay đổi so với version trước
  decree_ref      VARCHAR(100),                -- số Thông tư/Nghị định áp dụng
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(form_code, version_name)
);

-- 2. Form field definitions (mỗi chỉ tiêu trên tờ khai = 1 row)
CREATE TABLE tax_form_fields (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      UUID NOT NULL REFERENCES tax_form_versions(id) ON DELETE CASCADE,
  field_code      VARCHAR(20) NOT NULL,         -- '22', '23', '25', '40a', '41'
  field_label     TEXT NOT NULL,               -- "Tổng thuế GTGT đầu vào"
  field_label_short VARCHAR(100),               -- short label for mobile
  section         VARCHAR(50),                  -- 'I', 'II', 'PL01-1', 'PL01-2'
  section_label   TEXT,                         -- "I. Kê khai thuế GTGT phải nộp"
  sort_order      SMALLINT NOT NULL,
  field_type      VARCHAR(20) DEFAULT 'calculated',
  -- 'calculated': auto từ HĐ data
  -- 'manual':     user nhập tay (không tính từ HĐ)
  -- 'derived':    tính từ fields khác
  -- 'readonly':   hiển thị nhưng không sửa
  -- 'header':     tiêu đề section (không có giá trị)
  
  -- Formula definition (DSL - Domain Specific Language)
  formula         JSONB,
  -- Examples:
  -- Calculated from invoices:
  -- {"type": "invoice_sum", "direction": "input", "field": "vat_amount",
  --  "where": {"status": "valid", "gdt_validated": true}}
  --
  -- Derived from other fields:
  -- {"type": "expr", "expr": "MAX(0, [40a] - [25])"}
  -- {"type": "expr", "expr": "[23] + [24]"}
  -- {"type": "expr", "expr": "SUM([33], [35], [37])"}
  --
  -- Sum of invoice subtotals by VAT rate:
  -- {"type": "invoice_sum", "direction": "output", "field": "subtotal",
  --  "where": {"vat_rate": 10, "status": "valid"}}
  
  is_required     BOOLEAN DEFAULT false,
  is_editable     BOOLEAN DEFAULT false,        -- user có thể override không
  default_value   NUMERIC(22,2),
  min_value       NUMERIC(22,2),
  max_value       NUMERIC(22,2),
  help_text       TEXT,                         -- tooltip giải thích chỉ tiêu
  tax_law_ref     VARCHAR(200),                 -- căn cứ pháp lý
  
  UNIQUE(version_id, field_code)
);

-- 3. Validation rules (kiểm tra trước khi nộp)
CREATE TABLE tax_form_validation_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      UUID NOT NULL REFERENCES tax_form_versions(id) ON DELETE CASCADE,
  rule_code       VARCHAR(50) NOT NULL UNIQUE,  -- 'CHECK_25_EQUALS_23_PLUS_24'
  rule_type       VARCHAR(20) NOT NULL,
  -- 'error':   chặn nộp (sai bắt buộc phải sửa)
  -- 'warning': cảnh báo (có thể bỏ qua với xác nhận)
  -- 'info':    thông tin tham khảo
  -- 'ai':      gửi sang Gemini để phân tích
  
  rule_expr       TEXT NOT NULL,               -- biểu thức kiểm tra
  -- Examples:
  -- '[25] = [23] + [24]'
  -- '[40] = [30] + [32] + [34] + [36]'
  -- '[41] >= 0'
  -- '[29] = [40]'
  -- 'ABS([41] - previous_period.[41]) / previous_period.[41] <= 3.0'
  -- 'IF [41] > 0 THEN [43] = 0'
  
  error_message   TEXT NOT NULL,               -- "Chỉ tiêu [25] phải = [23] + [24]"
  fix_suggestion  TEXT,                        -- "Kiểm tra lại thuế kỳ trước chuyển sang [24]"
  affected_fields TEXT[],                      -- ['25', '23', '24']
  severity_score  SMALLINT DEFAULT 5,          -- 1-10, dùng để sort/prioritize
  is_active       BOOLEAN DEFAULT true
);

-- 4. Saved declarations now reference form version
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS form_version_id UUID REFERENCES tax_form_versions(id),
  ADD COLUMN IF NOT EXISTS field_values JSONB DEFAULT '{}',
  -- field_values = { "22": 1500000, "23": 1200000, "24": 0, ... }
  -- Replaces the individual ct22_, ct23_... columns (keep those for backward compat)
  ADD COLUMN IF NOT EXISTS validation_result JSONB,
  -- { errors: [...], warnings: [...], ai_review: "..." }
  ADD COLUMN IF NOT EXISTS user_overrides JSONB DEFAULT '{}';
  -- fields that user manually overrode + their reason

-- 5. Seed current 01/GTGT version (TT80/2021)
INSERT INTO tax_form_versions (form_code, version_name, effective_from, is_current, decree_ref)
VALUES ('01/GTGT', 'TT80/2021', '2021-07-01', true, 'Thông tư 80/2021/TT-BTC');

-- Then seed all fields for this version via the admin UI or a separate seed script
-- (see TAX-CFG-02 for the seeding approach)
```

### TAX-CFG-02 — Formula Engine + Dynamic Calculator
```
[Respond in Vietnamese]
Create /backend/src/services/TaxFormEngine.ts
Replace the hardcoded TaxDeclarationEngine with a config-driven version.

The engine reads form definition from DB and executes formulas dynamically.

import { db } from '../db'

interface FormulaContext {
  companyId: string
  month: number
  year: number
  fieldValues: Record<string, number>  // accumulated as fields are calculated
  invoiceData: InvoiceAggregates       // pre-fetched from DB
  previousPeriod?: Record<string, number>  // ct values from previous month
}

export class TaxFormEngine {

  async calculateDeclaration(companyId: string, month: number, year: number): Promise<TaxDeclarationResult> {
    // 1. Find applicable form version for this period
    const version = await this.getFormVersion('01/GTGT', new Date(year, month - 1, 1))
    if (!version) throw new Error('No active tax form version found for 01/GTGT')

    // 2. Load field definitions (sorted by sort_order)
    const fields = await db.query(`
      SELECT * FROM tax_form_fields
      WHERE version_id = $1 AND field_type != 'header'
      ORDER BY sort_order ASC
    `, [version.id])

    // 3. Pre-fetch all invoice aggregates (one query, not N queries)
    const invoiceData = await this.fetchInvoiceAggregates(companyId, month, year)
    const previousPeriod = await this.getPreviousPeriodValues(companyId, month, year)

    // 4. Calculate each field in order (sequential — later fields depend on earlier)
    const context: FormulaContext = {
      companyId, month, year,
      fieldValues: {},
      invoiceData,
      previousPeriod
    }

    for (const field of fields.rows) {
      if (field.field_type === 'manual') continue  // skip — user fills
      if (!field.formula) { context.fieldValues[field.field_code] = 0; continue }

      try {
        const value = await this.executeFormula(field.formula, context)
        context.fieldValues[field.field_code] = Math.round(value)  // VND = integers
      } catch (err) {
        console.error(`[TaxFormEngine] Formula error for field ${field.field_code}:`, err)
        context.fieldValues[field.field_code] = 0
      }
    }

    return {
      versionId: version.id,
      formCode: '01/GTGT',
      period: { month, year },
      fieldValues: context.fieldValues,
      fields: fields.rows  // for UI rendering
    }
  }

  private async executeFormula(formula: any, ctx: FormulaContext): Promise<number> {
    switch (formula.type) {

      case 'invoice_sum': {
        // Sum invoice field filtered by conditions
        const { direction, field, where } = formula
        const conditions = this.buildWhereClause(where)
        const res = await db.query(`
          SELECT COALESCE(SUM(${field}), 0) as total
          FROM active_invoices
          WHERE company_id = $1
            AND direction = $2
            AND EXTRACT(MONTH FROM invoice_date) = $3
            AND EXTRACT(YEAR FROM invoice_date) = $4
            ${conditions.sql}
        `, [ctx.companyId, direction, ctx.month, ctx.year, ...conditions.params])
        return parseFloat(res.rows[0].total)
      }

      case 'expr': {
        // Evaluate arithmetic expression like "[40a] - [25]" or "MAX(0, [40a] - [25])"
        let expr = formula.expr as string
        
        // Replace field references [XX] with actual values
        expr = expr.replace(/\[([^\]]+)\]/g, (_, code) => {
          const val = ctx.fieldValues[code] ?? 0
          return String(val)
        })

        // Replace previous period references
        expr = expr.replace(/previous_period\.\[([^\]]+)\]/g, (_, code) => {
          return String(ctx.previousPeriod?.[code] ?? 0)
        })

        // Evaluate safe math expressions (no eval — use math parser)
        return this.safeEval(expr)
      }

      case 'constant':
        return formula.value ?? 0

      case 'previous_period':
        return ctx.previousPeriod?.[formula.field_code] ?? 0

      default:
        console.warn(`[TaxFormEngine] Unknown formula type: ${formula.type}`)
        return 0
    }
  }

  private safeEval(expr: string): number {
    // Safe math evaluator — supports: +, -, *, /, MAX(), MIN(), ABS(), IF()
    // Use a simple recursive descent parser (no eval, no new Function)
    // Library option: use 'expr-eval' npm package (safe, no code injection)
    const Parser = require('expr-eval').Parser
    const parser = new Parser()
    return parser.evaluate(expr.replace(/MAX/g, 'max').replace(/MIN/g, 'min').replace(/ABS/g, 'abs'))
  }

  private async getFormVersion(formCode: string, forDate: Date) {
    const res = await db.query(`
      SELECT * FROM tax_form_versions
      WHERE form_code = $1
        AND effective_from <= $2
        AND (effective_to IS NULL OR effective_to >= $2)
      ORDER BY effective_from DESC LIMIT 1
    `, [formCode, forDate])
    return res.rows[0]
  }

  private buildWhereClause(where: Record<string, any>) {
    const clauses: string[] = []
    const params: any[] = []
    let paramIdx = 5  // $1-$4 used by main query

    for (const [key, val] of Object.entries(where)) {
      if (key === 'status') { clauses.push(`status = $${paramIdx++}`); params.push(val) }
      else if (key === 'gdt_validated') { clauses.push(`gdt_validated = $${paramIdx++}`); params.push(val) }
      else if (key === 'vat_rate') { clauses.push(`vat_rate = $${paramIdx++}`); params.push(val) }
    }
    return { sql: clauses.map(c => `AND ${c}`).join(' '), params }
  }

  // Seed field definitions for 01/GTGT (run once or via admin)
  async seedGtgtFields(versionId: string): Promise<void> {
    const fields = [
      { code:'22', label:'Tổng thuế GTGT đầu vào', type:'calculated', sort:1,
        formula: { type:'invoice_sum', direction:'input', field:'vat_amount',
                   where:{ status:'valid' }}},
      { code:'23', label:'Thuế GTGT đầu vào đủ điều kiện khấu trừ', type:'calculated', sort:2,
        formula: { type:'invoice_sum', direction:'input', field:'vat_amount',
                   where:{ status:'valid', gdt_validated:true }}},
      { code:'24', label:'Thuế GTGT đầu vào kỳ trước chuyển sang', type:'derived', sort:3,
        formula: { type:'previous_period', field_code:'43' }},
      { code:'25', label:'Tổng thuế GTGT đầu vào được khấu trừ', type:'derived', sort:4,
        formula: { type:'expr', expr:'[23] + [24]' }},
      { code:'29', label:'Tổng doanh thu HHDV bán ra', type:'calculated', sort:5,
        formula: { type:'invoice_sum', direction:'output', field:'subtotal',
                   where:{ status:'valid' }}},
      { code:'30', label:'Doanh thu không chịu thuế', type:'calculated', sort:6,
        formula: { type:'invoice_sum', direction:'output', field:'subtotal',
                   where:{ status:'valid', vat_rate:0 }}},
      { code:'32', label:'Doanh thu 5%', type:'calculated', sort:7,
        formula: { type:'invoice_sum', direction:'output', field:'subtotal',
                   where:{ status:'valid', vat_rate:5 }}},
      { code:'33', label:'Thuế GTGT 5%', type:'calculated', sort:8,
        formula: { type:'invoice_sum', direction:'output', field:'vat_amount',
                   where:{ status:'valid', vat_rate:5 }}},
      { code:'34', label:'Doanh thu 8%', type:'calculated', sort:9,
        formula: { type:'invoice_sum', direction:'output', field:'subtotal',
                   where:{ status:'valid', vat_rate:8 }}},
      { code:'35', label:'Thuế GTGT 8%', type:'calculated', sort:10,
        formula: { type:'invoice_sum', direction:'output', field:'vat_amount',
                   where:{ status:'valid', vat_rate:8 }}},
      { code:'36', label:'Doanh thu 10%', type:'calculated', sort:11,
        formula: { type:'invoice_sum', direction:'output', field:'subtotal',
                   where:{ status:'valid', vat_rate:10 }}},
      { code:'37', label:'Thuế GTGT 10%', type:'calculated', sort:12,
        formula: { type:'invoice_sum', direction:'output', field:'vat_amount',
                   where:{ status:'valid', vat_rate:10 }}},
      { code:'40',  label:'Tổng doanh thu chịu thuế', type:'derived', sort:13,
        formula: { type:'expr', expr:'[30] + [32] + [34] + [36]' }},
      { code:'40a', label:'Tổng thuế GTGT đầu ra', type:'derived', sort:14,
        formula: { type:'expr', expr:'[33] + [35] + [37]' }},
      { code:'41', label:'Thuế GTGT phải nộp', type:'derived', sort:15,
        formula: { type:'expr', expr:'max(0, [40a] - [25])' }},
      { code:'43', label:'Thuế được khấu trừ kỳ sau', type:'derived', sort:16,
        formula: { type:'expr', expr:'max(0, [25] - [40a])' }},
    ]

    for (const f of fields) {
      await db.query(`
        INSERT INTO tax_form_fields (version_id, field_code, field_label, field_type, sort_order, formula)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (version_id, field_code) DO UPDATE SET
          field_label=$3, formula=$6, updated_at=NOW()
      `, [versionId, f.code, f.label, f.type, f.sort, JSON.stringify(f.formula)])
    }
  }
}
```

### TAX-CFG-03 — Admin: Form Version Management UI
```
[Respond in Vietnamese]
Create /admin/tax-forms page — Admin interface to manage tax form versions and formulas.
This is where admin adds new versions when the Ministry of Finance updates tax forms.
No code deployment needed — just JSON editing in this UI.

Page layout:

Header: "Quản lý Mẫu Biểu Tờ Khai Thuế" + info tooltip explaining the system

Section 1 — Version list:
  Table: Mã tờ khai | Phiên bản | Thông tư | Hiệu lực từ | Hiệu lực đến | Đang dùng | Hành động
  
  Status badge: "Đang hiệu lực" (green) | "Đã hết hạn" (gray) | "Sắp áp dụng" (blue)
  
  [+ Thêm phiên bản mới] button → version creation wizard (see below)
  
  Per-version actions:
    [Xem chỉ tiêu] → expand field list below
    [Nhân bản] → clone version as starting point for new version
    [Cài làm mặc định] → set is_current=true (with confirmation)

Section 2 — Field editor (when a version is selected):
  Table of fields sorted by sort_order:
  
  Columns: Thứ tự | Mã chỉ tiêu | Nhãn | Loại | Công thức | Bắt buộc | Sửa
  
  Inline edit for each field:
    - Field label (text)
    - Formula type (select: invoice_sum / expr / manual / previous_period)
    - Formula params (dynamic form based on type):
      invoice_sum: direction + field + where conditions (tag-based)
      expr:        text editor with syntax highlighting + [field] autocomplete
    - Help text (textarea)
  
  [+ Thêm chỉ tiêu] → add new field with sort_order at end
  Drag-and-drop to reorder fields (updates sort_order)
  [Xem trước] → modal showing the form as users will see it

Section 3 — Validation rules for selected version:
  Table: Mã rule | Loại | Biểu thức | Thông báo | Mức độ | Active
  
  [+ Thêm quy tắc] → rule editor:
    Rule type: error/warning/info/ai
    Expression: text with [field_code] references + autocomplete
    Error message: what users see if rule fails
    Fix suggestion: how to fix it
    Affected fields: select multiple (highlighted in UI when rule fails)

Section 4 — Add new version wizard (modal, 3 steps):
  Step 1: Basic info — form code, version name, decree reference, effective date
  Step 2: Source — Start from scratch | Clone existing version [select version]
  Step 3: Review — show diff if cloning (fields added/removed/changed vs source)
  [Tạo phiên bản] → creates version + fields + copies validation rules from source

Testing panel (bottom of page):
  "Kiểm tra phiên bản mới với dữ liệu thực"
  Select company + month → run TaxFormEngine with this version → show results vs previous version
  Compare: field [X] was [old_value] → now [new_value] (for all fields)
```

---

## GROUP 46 — PRE-SUBMISSION VALIDATION GATE

> Người dùng thường nhầm lẫn giữa các chỉ tiêu, quên kê khai, hoặc sai số.
> Thêm một bước kiểm tra bắt buộc TRƯỚC KHI nộp — gồm auto-check + AI review + user confirm.

### VAL-01 — Validation Rule Engine
```
[Respond in Vietnamese]
Create /backend/src/services/TaxValidationEngine.ts
Runs all validation rules from tax_form_validation_rules table against calculated values.

interface ValidationResult {
  passed: boolean
  errors:   ValidationIssue[]   // must fix before submitting
  warnings: ValidationIssue[]   // can proceed with confirmation
  infos:    ValidationIssue[]   // FYI only
  aiReview: string | null       // Gemini analysis
  score:    number              // 0-100 confidence score
}

interface ValidationIssue {
  ruleCode:       string
  type:           'error' | 'warning' | 'info'
  message:        string
  fixSuggestion?: string
  affectedFields: string[]
  fieldValues:    Record<string, number>  // actual values causing the issue
  severityScore:  number
}

export class TaxValidationEngine {

  async validate(
    companyId: string,
    declarationId: string,
    fieldValues: Record<string, number>
  ): Promise<ValidationResult> {
    
    // Load rules for this form version
    const decl = await db.query('SELECT form_version_id FROM tax_declarations WHERE id=$1', [declarationId])
    const versionId = decl.rows[0]?.form_version_id

    const rules = await db.query(`
      SELECT * FROM tax_form_validation_rules
      WHERE version_id = $1 AND is_active = true
      ORDER BY severity_score DESC
    `, [versionId])

    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []
    const infos: ValidationIssue[] = []

    for (const rule of rules.rows) {
      if (rule.rule_type === 'ai') continue  // handled separately

      const passes = await this.evaluateRule(rule.rule_expr, fieldValues)
      if (!passes) {
        const issue: ValidationIssue = {
          ruleCode:       rule.rule_code,
          type:           rule.rule_type,
          message:        this.interpolateMessage(rule.error_message, fieldValues),
          fixSuggestion:  rule.fix_suggestion,
          affectedFields: rule.affected_fields || [],
          fieldValues:    this.extractAffectedValues(rule.affected_fields, fieldValues),
          severityScore:  rule.severity_score
        }
        if (rule.rule_type === 'error')   errors.push(issue)
        if (rule.rule_type === 'warning') warnings.push(issue)
        if (rule.rule_type === 'info')    infos.push(issue)
      }
    }

    // Calculate confidence score
    const score = this.calculateScore(errors, warnings, fieldValues)

    // AI review (only if no hard errors — save API calls)
    let aiReview: string | null = null
    if (errors.length === 0) {
      aiReview = await this.requestAiReview(companyId, fieldValues, warnings)
    }

    // Save validation result to declaration
    const result: ValidationResult = {
      passed: errors.length === 0,
      errors, warnings, infos, aiReview, score
    }
    
    await db.query(
      "UPDATE tax_declarations SET validation_result=$1, updated_at=NOW() WHERE id=$2",
      [JSON.stringify(result), declarationId]
    )

    return result
  }

  private async evaluateRule(expr: string, values: Record<string, number>): Promise<boolean> {
    // Replace [field_code] with actual values
    let evalExpr = expr.replace(/\[([^\]]+)\]/g, (_, code) => String(values[code] ?? 0))
    
    // Handle special operators
    evalExpr = evalExpr
      .replace(/ABS\(([^)]+)\)/g, (_, inner) => `Math.abs(${inner})`)
      .replace(/MAX\(([^)]+)\)/g, (_, inner) => `Math.max(${inner})`)
      .replace(/IF (.+) THEN (.+)/g, (_, cond, then) => `(!(${cond})) || (${then})`)
    
    // Safe evaluation using expr-eval parser
    try {
      const Parser = require('expr-eval').Parser
      return Boolean(new Parser().evaluate(evalExpr))
    } catch {
      return true  // if rule can't be parsed, don't block
    }
  }

  private interpolateMessage(template: string, values: Record<string, number>): string {
    return template.replace(/\[([^\]]+)\]/g, (match, code) => {
      const val = values[code]
      return val !== undefined
        ? `[${code}]=${val.toLocaleString('vi-VN')}đ`
        : match
    })
  }

  private calculateScore(errors: any[], warnings: any[], values: Record<string, number>): number {
    let score = 100
    score -= errors.length * 20
    score -= warnings.length * 5
    if (!values['29'] || values['29'] === 0) score -= 10  // no revenue is suspicious
    return Math.max(0, score)
  }

  private async requestAiReview(
    companyId: string,
    values: Record<string, number>,
    warnings: ValidationIssue[]
  ): Promise<string> {
    // Get previous period for comparison
    const prev = await this.getPreviousPeriodValues(companyId)
    
    const prompt = `Bạn là chuyên gia thuế GTGT Việt Nam. Hãy xem xét tờ khai 01/GTGT sau và đưa ra nhận xét ngắn gọn bằng tiếng Việt (tối đa 150 từ):

Chỉ tiêu kỳ này:
[29] Tổng doanh thu: ${(values['29'] || 0).toLocaleString('vi-VN')}đ
[40a] VAT đầu ra: ${(values['40a'] || 0).toLocaleString('vi-VN')}đ
[23] VAT đầu vào được khấu trừ: ${(values['23'] || 0).toLocaleString('vi-VN')}đ
[25] Tổng được khấu trừ: ${(values['25'] || 0).toLocaleString('vi-VN')}đ
[41] VAT phải nộp: ${(values['41'] || 0).toLocaleString('vi-VN')}đ
[43] Kết chuyển kỳ sau: ${(values['43'] || 0).toLocaleString('vi-VN')}đ

Kỳ trước: [41]=${(prev?.['41'] || 0).toLocaleString('vi-VN')}đ, [29]=${(prev?.['29'] || 0).toLocaleString('vi-VN')}đ

${warnings.length > 0 ? 'Cảnh báo đã phát hiện:\n' + warnings.map(w => `- ${w.message}`).join('\n') : ''}

Hãy nhận xét: số liệu có hợp lý không? Có dấu hiệu bất thường nào không? Tỉ lệ VAT/DT có phù hợp không?`

    try {
      const response = await callGemini(prompt, 300)
      return response
    } catch {
      return ''
    }
  }

  // Seed default validation rules for 01/GTGT
  async seedDefaultRules(versionId: string): Promise<void> {
    const rules = [
      // HARD ERRORS (chặn nộp)
      { code:'CHK_25_SUM', type:'error', sort:10,
        expr:'[25] = [23] + [24]',
        msg:'Chỉ tiêu [25] phải bằng [23] + [24] (hiện: [25] ≠ [23]+[24])',
        fix:'Kiểm tra lại thuế GTGT đầu vào kỳ trước chuyển sang [24]',
        fields:['25','23','24'] },

      { code:'CHK_40_SUM', type:'error', sort:9,
        expr:'[40] = [30] + [32] + [34] + [36]',
        msg:'Chỉ tiêu [40] phải bằng tổng doanh thu các thuế suất',
        fix:'Kiểm tra lại số liệu doanh thu theo từng thuế suất',
        fields:['40','30','32','34','36'] },

      { code:'CHK_40a_SUM', type:'error', sort:9,
        expr:'[40a] = [33] + [35] + [37]',
        msg:'Chỉ tiêu [40a] phải bằng tổng VAT các thuế suất',
        fix:'Kiểm tra lại VAT theo từng thuế suất',
        fields:['40a','33','35','37'] },

      { code:'CHK_41_OR_43', type:'error', sort:8,
        expr:'!([41] > 0 && [43] > 0)',
        msg:'Không thể đồng thời có [41] > 0 (phải nộp) và [43] > 0 (kết chuyển)',
        fix:'Kiểm tra lại: [41] và [43] không thể cùng dương',
        fields:['41','43'] },

      { code:'CHK_41_GTE_0', type:'error', sort:7,
        expr:'[41] >= 0',
        msg:'Thuế phải nộp [41] không thể âm',
        fix:'Nếu VAT đầu vào > đầu ra, điền [43] (kết chuyển kỳ sau)',
        fields:['41'] },

      // WARNINGS (cảnh báo — có thể bỏ qua)
      { code:'WARN_29_NEQL_40', type:'warning', sort:5,
        expr:'[29] = [40]',
        msg:'Doanh thu [29] và tổng [40] không khớp — kiểm tra HĐ thiếu phân loại thuế suất',
        fix:'Đảm bảo mọi HĐ đầu ra đều được phân loại theo thuế suất',
        fields:['29','40'] },

      { code:'WARN_VAT_SPIKE', type:'warning', sort:4,
        expr:'abs([41] - previous_period.[41]) / (previous_period.[41] + 1) <= 3',
        msg:'VAT phải nộp kỳ này chênh lệch >300% so với kỳ trước — kiểm tra lại',
        fix:'Nếu có giao dịch lớn bất thường, hãy giải thích trong phần ghi chú',
        fields:['41'] },

      { code:'WARN_HIGH_INPUT_RATIO', type:'warning', sort:3,
        expr:'[23] / ([40a] + 1) <= 0.95',
        msg:'VAT đầu vào được khấu trừ [23] chiếm >95% VAT đầu ra — tỉ lệ bất thường',
        fix:'Kiểm tra lại HĐ đầu vào có đủ điều kiện khấu trừ không',
        fields:['23','40a'] },

      // INFOS (thông tin)
      { code:'INFO_ZERO_REVENUE', type:'info', sort:1,
        expr:'[29] > 0',
        msg:'Doanh thu kỳ này bằng 0 — xác nhận không có HĐ bán ra trong kỳ',
        fix:'',
        fields:['29'] },

      { code:'INFO_CARRY_FORWARD', type:'info', sort:1,
        expr:'[43] = 0 || [24] = [43_prev]',
        msg:'Số kết chuyển kỳ này khác với [43] kỳ trước — đảm bảo nhập đúng vào [24]',
        fix:'[24] kỳ này phải bằng [43] của kỳ trước',
        fields:['24','43'] },
    ]

    for (const r of rules) {
      await db.query(`
        INSERT INTO tax_form_validation_rules
          (version_id, rule_code, rule_type, rule_expr, error_message, fix_suggestion,
           affected_fields, severity_score)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (rule_code) DO UPDATE SET rule_expr=$4, error_message=$5
      `, [versionId, r.code, r.type, r.expr, r.msg, r.fix, r.fields, r.sort])
    }
  }
}
```

### VAL-02 — Pre-Submission Validation UI
```
[Respond in Vietnamese]
Create the pre-submission validation gate in /declarations/[id]/review page.
Users MUST pass through this gate before submitting.

Backend: POST /api/declarations/:id/validate → runs TaxValidationEngine → returns ValidationResult
         POST /api/declarations/:id/acknowledge-warnings → user confirms warnings are OK
         POST /api/declarations/:id/finalize → changes status to 'ready', allows XML download

Flow: Calculate → Review (this page) → Acknowledge Warnings → Finalize → Download/Submit

Page layout: "/declarations/[id]/review"

Step indicator at top: 1.Tính toán → 2.Kiểm tra ✓ → 3.Xác nhận → 4.Nộp

Header card:
  "Kiểm tra Tờ Khai Trước Khi Nộp"
  Company: [name] | Kỳ: Tháng [M]/[Y] | Form: 01/GTGT
  
  CONFIDENCE SCORE badge (right side):
    ≥90: "✅ Độ tin cậy: 95%" (green)
    70-89: "⚠️ Độ tin cậy: 75%" (orange)
    <70: "🔴 Độ tin cậy: 55%" (red)

Section 1 — ERRORS (if any) — RED card, cannot proceed:
  Header: "🚫 Lỗi bắt buộc sửa — Không thể nộp khi còn lỗi"
  
  Each error:
    Red left border
    Error title: e.g., "[25] ≠ [23] + [24]"
    Detail: "Chỉ tiêu [25]=1.500.000đ nhưng [23]+[24]=1.200.000đ+0đ=1.200.000đ"
    Highlighted fields: show the field codes in red pill badges
    Fix suggestion: "💡 Kiểm tra lại thuế GTGT kỳ trước chuyển sang [24]"
    [Sửa] button → scroll to declaration form, highlight that field

  [Quay lại sửa tờ khai] button (prominent, shown only when errors exist)

Section 2 — WARNINGS (if any) — ORANGE card:
  Header: "⚠️ Cảnh báo — Kiểm tra trước khi xác nhận"
  
  Each warning (same structure as errors but orange):
    [Đã kiểm tra và xác nhận] checkbox per warning
  
  All warnings must be checked before proceeding.

Section 3 — AI Review — BLUE card:
  Header: "🤖 Nhận xét từ AI"
  Gemini analysis text (2-3 sentences)
  "Nhận xét này chỉ mang tính tham khảo — không phải ý kiến pháp lý chính thức"
  Loading skeleton while AI thinks (5-10 seconds)

Section 4 — Infos — GRAY card (collapsible):
  "ℹ️ Thông tin cần lưu ý ([N])"
  Each info item — no checkbox needed

Section 5 — Declaration Summary (always shown):
  Clean table of all calculated fields with values
  Highlight [41] (must pay) in RED if > 0
  Highlight [43] (carry forward) in GREEN if > 0

Section 6 — Actions (bottom):
  IF errors > 0:
    [Quay lại sửa] (only option)
  
  IF no errors AND all warnings checked:
    [Xác nhận và hoàn tất tờ khai] (green, primary)
      → POST /api/declarations/:id/finalize
      → Navigate to /declarations/[id] with download options

  IF no errors AND warnings exist but not all checked:
    "Xác nhận tất cả cảnh báo ở trên để tiếp tục"
    [Xác nhận và hoàn tất] (disabled, gray)

After finalization:
  Toast: "✅ Tờ khai đã hoàn tất — sẵn sàng để nộp"
  Options: [Tải XML HTKK] [Hướng dẫn nộp thủ công] [Nộp qua T-VAN]
```

### VAL-03 — Dynamic Form Renderer (UI that reads from DB config)
```
[Respond in Vietnamese]
Create a dynamic form renderer that displays tax declarations based on DB config.
No hardcoded fields — the UI reads field definitions and renders accordingly.

Component: TaxDeclarationForm({ declarationId, versionId, readOnly?: boolean })

Fetch on mount:
  1. GET /api/declarations/:id → gets fieldValues + userOverrides + validationResult
  2. GET /api/tax-forms/fields?versionId=X → gets field definitions (sorted by sort_order)
  
  Cache field definitions for 1 hour (they rarely change)

Rendering logic:
  Group fields by section, render section headers as dividers
  
  For each field:
    Row layout: [Sort#] [Field code badge] [Field label] [Value] [Override indicator]
    
    Field types:
      'calculated': show value + source tooltip ("Tính từ X hóa đơn đầu vào")
      'derived':    show value + formula tooltip ("[23] + [24]")
      'manual':     show editable input field (user must fill)
      'header':     show as section divider with bold styling
    
    If user has overridden a calculated field:
      Show orange "Đã điều chỉnh" badge
      Hover/click: show original calculated value + override reason
    
    If field has validation error:
      Red border, red background, show error message below
    
    Edit mode (readOnly=false):
      Calculated fields: show lock icon but allow override with reason
      Override modal: "Nhập giá trị ghi đè" + "Lý do điều chỉnh" (required)
      Override is saved to declaration.user_overrides JSONB
      
  Key visual design:
    [41] Thuế GTGT phải nộp: RED large font if > 0 ("11.900.000 đ")
    [43] Kết chuyển kỳ sau: GREEN if > 0
    All other values: normal muted style

API: GET /api/tax-forms/fields?versionId=X
  Returns array of field definitions including formula descriptions for tooltips

API: PATCH /api/declarations/:id/override
  Body: { fieldCode: string, value: number, reason: string }
  Sets user_overrides[fieldCode] = { value, reason, overriddenAt, overriddenBy }
  Recalculates derived fields that depend on overridden field
```


---

## GROUP 47 — INVOICE TYPE HANDLING + SERIAL NUMBER DECODER

### INV-TYPE-01 — Invoice serial number parser + type classification
```
[Respond in Vietnamese]
Create /backend/src/utils/InvoiceSerialParser.ts
Parse and classify Vietnamese e-invoice serial numbers following TT78/2021 standard.

Serial number format (Ký hiệu hóa đơn): C26TDL
  Position 1:   C = Có mã CQT (has tax authority code)
                K = Không có mã CQT (no tax authority code — types 6 & 8)
  Position 2-3: 26 = year of invoice (e.g., 2026)
  Position 4:   T = Hóa đơn thường (standard invoice)
                M = Hóa đơn từ máy tính tiền (POS/cash register invoice)
                D = Hóa đơn điện (electricity)
                ...
  Position 5+:  DL, ABC, XYZ = company identifier code (DN tự đặt)

export interface ParsedSerial {
  raw: string
  hasCqtCode: boolean       // true = C (có mã), false = K (không mã)
  invoiceYear: number       // 26 → 2026
  invoiceType: string       // 'T'|'M'|'D'...
  invoiceTypeLabel: string  // "Hóa đơn thường" | "Máy tính tiền"
  companyCode: string       // 'DL', 'ABC'...
  // Derived classification:
  invoiceGroup: 5 | 6 | 8 | null
  // Group 5: C-prefix → có mã CQT → full detail available
  // Group 6: K-prefix, T-type → không mã CQT, hóa đơn thường → header only
  // Group 8: K-prefix, M-type → không mã CQT, máy tính tiền → header only
  isDetailAvailable: boolean  // false for groups 6 & 8
}

export function parseInvoiceSerial(serial: string): ParsedSerial {
  if (!serial || serial.length < 4) {
    return { raw: serial, hasCqtCode: false, invoiceYear: 0,
             invoiceType: '', invoiceTypeLabel: 'Không xác định',
             companyCode: '', invoiceGroup: null, isDetailAvailable: false }
  }

  const s = serial.toUpperCase().trim()
  const hasCqtCode  = s[0] === 'C'
  const yearStr     = s.substring(1, 3)
  const invoiceYear = 2000 + parseInt(yearStr || '0')
  const invoiceType = s[3] || 'T'
  const companyCode = s.substring(4)

  const typeLabels: Record<string, string> = {
    'T': 'Hóa đơn thường',
    'M': 'Hóa đơn máy tính tiền',
    'D': 'Hóa đơn điện',
    'N': 'Hóa đơn nước',
    'V': 'Hóa đơn viễn thông',
    'X': 'Hóa đơn xăng dầu',
  }

  // Group classification per TT78/2021:
  // Group 5: Có mã CQT (C-prefix) → GDT cấp mã → có đầy đủ chi tiết
  // Group 6: Không mã CQT (K-prefix), hóa đơn thường (T) → chỉ header
  // Group 8: Không mã CQT (K-prefix), máy tính tiền (M) → chỉ header
  let invoiceGroup: 5 | 6 | 8 | null = null
  if (hasCqtCode)                    invoiceGroup = 5
  else if (invoiceType === 'M')      invoiceGroup = 8
  else                               invoiceGroup = 6

  return {
    raw: serial, hasCqtCode, invoiceYear, invoiceType,
    invoiceTypeLabel: typeLabels[invoiceType] || `Loại ${invoiceType}`,
    companyCode, invoiceGroup,
    isDetailAvailable: hasCqtCode  // only group 5 has line item detail
  }
}

// Update invoice normalization to always parse and store serial info:
// In InvoiceNormalizer: const parsed = parseInvoiceSerial(invoice.serial_number)
// Store: invoice.invoice_group = parsed.invoiceGroup
// Store: invoice.has_line_items = parsed.isDetailAvailable

// DB: Add columns
// ALTER TABLE invoices
//   ADD COLUMN IF NOT EXISTS invoice_group SMALLINT,    -- 5|6|8
//   ADD COLUMN IF NOT EXISTS serial_has_cqt BOOLEAN,   -- C vs K
//   ADD COLUMN IF NOT EXISTS has_line_items BOOLEAN DEFAULT false;
```

### INV-TYPE-02 — Handling Group 6 & 8 in VAT reconciliation
```
[Respond in Vietnamese]
PROBLEM: Group 6 and Group 8 input invoices (K-prefix, no CQT code) have NO line item
detail — only header VAT amount is available. This creates a gap in:
  - Product catalog (no item names/quantities)
  - Inventory tracking (can't know what was bought)
  - VAT reconciliation: VAT amount IS available, so [22] and [23] CAN include these

SOLUTION: Use the header-level VAT data for tax purposes, flag for manual detail input.

1. Update TaxFormEngine VAT calculation to include groups 6 & 8:

   For chỉ tiêu [22] (Total input VAT collected):
     Include ALL input invoices regardless of group:
     WHERE direction='input' AND status='valid'
     -- Group 5: has full detail, vat_amount from line items aggregation
     -- Group 6/8: vat_amount at header level (directly from GDT)

   For chỉ tiêu [23] (Deductible input VAT):
     Include group 6 & 8 BUT with conditions:
     WHERE direction='input' AND status='valid'
       AND (
         -- Group 5: normal deductibility rules
         (invoice_group = 5 AND gdt_validated = true)
         OR
         -- Group 6 & 8: CQT code not required, but still deductible if:
         -- 1. Invoice number traceable (can verify via seller's records)
         -- 2. Amount <= threshold or payment method verified
         (invoice_group IN (6, 8) AND total_amount <= 20000000)
         OR
         (invoice_group IN (6, 8) AND payment_method != 'cash' AND total_amount > 20000000)
       )

2. Visual treatment in invoice list for Group 6 & 8:
   Badge: "Chưa có mã CQT" (orange badge next to serial number)
   Badge: "Không có chi tiết" (gray badge)
   In detail view: show header data only, no line items section
   Instead of empty line items: show info box:
     "ℹ️ Hóa đơn loại K (không mã CQT) — chi tiết mặt hàng không có trên hệ thống GDT.
      VAT đầu vào: [amount] vẫn được tổng hợp vào tờ khai."

3. Manual detail input option for Group 6 & 8:
   In invoice detail view, show button: [Nhập chi tiết thủ công]
   Opens form to add line items manually:
     - Tên hàng hóa, Số lượng, Đơn giá, VAT%
     - These are saved to invoice_line_items with source='manual'
     - Useful for inventory tracking and product catalog

4. Tax declaration note:
   In declaration review page, if group 6/8 invoices exist:
   Show info box:
     "ℹ️ Tờ khai bao gồm [N] hóa đơn loại K (không mã CQT — loại 6 & 8)
      với tổng VAT: [amount]. Các hóa đơn này được tổng hợp theo header VAT."

5. Report: Group breakdown in VAT report
   In /reports/purchase-journal: add column "Loại HĐ" (5/6/8)
   Add summary row: "Tổng HĐ có mã CQT: [N] | Không mã: [M] (Loại 6: [X], Loại 8: [Y])"
```

---

## GROUP 48 — SYNC BUTTON: DATE CONSTRAINTS + HUMAN-LIKE BEHAVIOR + REAL-TIME PROGRESS

### SYNC-UI-01 — Sync date picker with GDT constraints
```
[Respond in Vietnamese]
PROBLEM: GDT portal only accepts exact calendar month ranges.
If user picks 2026-02-05 to 2026-02-20, GDT rejects it.
Must send exactly 2026-02-01 to 2026-02-28 (or full quarter split into 3 full months).

Create a custom SyncDatePicker component with these constraints built in.

Component: SyncDatePicker({ onConfirm: (jobs: SyncJob[]) => void })

UI — 2 tabs: "Theo tháng" | "Theo quý"

Tab 1 — Theo tháng:
  Month/Year selector:
    Dropdown: "Tháng 1/2026", "Tháng 2/2026"... (last 24 months only, no future)
    DO NOT show day pickers — always uses full month
  
  On confirm: automatically set
    fromDate = first day of selected month (e.g., 2026-02-01)
    toDate   = last day of selected month  (e.g., 2026-02-28)
  
  Preview text: "Đồng bộ HĐ từ 01/02/2026 đến 28/02/2026"

Tab 2 — Theo quý:
  Quarter selector: "Quý 1/2026" (Jan-Mar), "Quý 2/2026" (Apr-Jun)...
  
  IMPORTANT: Quarter must be split into 3 SEPARATE sync jobs (one per month).
  GDT cannot handle 3-month ranges.
  
  On confirm: returns array of 3 SyncJob objects:
    [
      { fromDate: '2026-01-01', toDate: '2026-01-31', label: 'Tháng 1' },
      { fromDate: '2026-02-01', toDate: '2026-02-28', label: 'Tháng 2' },
      { fromDate: '2026-03-01', toDate: '2026-03-31', label: 'Tháng 3' },
    ]
  
  Preview text: "Đồng bộ Quý 1/2026 — sẽ chạy 3 lần (Tháng 1, 2, 3)"
  Warning note: "Thuế chỉ cho phép lấy theo từng tháng — hệ thống sẽ tự động tách"

Direction checkboxes (always show):
  ☑ Hóa đơn đầu ra (bán hàng)
  ☑ Hóa đơn đầu vào (mua hàng)

[Bắt đầu đồng bộ] button → submits jobs to queue

Helper functions:
  getMonthRange(year, month): { from: Date, to: Date }
    // Always returns 1st → last day of that calendar month
    // Use date-fns: startOfMonth(), endOfMonth()
  
  getQuarterJobs(year, quarter): SyncJob[]
    // Q1→months[1,2,3], Q2→[4,5,6], Q3→[7,8,9], Q4→[10,11,12]
    // Returns 3 SyncJob objects with exact month ranges
```

### SYNC-UI-02 — Human-like bot behavior for quarter sync
```
[Respond in Vietnamese]
PROBLEM: Running 3 months back-to-back in fixed intervals looks like a bot.
GDT may block if requests are too regular. Simulate human behavior.

Update /bot/src/sync.worker.ts to handle quarter jobs with human-like timing:

When processing a batch of 3 monthly jobs for the same company (quarter sync):

1. Randomized inter-month delay:
   Between month 1 → month 2: wait 45-90 seconds (random)
   Between month 2 → month 3: wait 30-120 seconds (random)
   
   const humanDelay = (minSec: number, maxSec: number) =>
     new Promise(r => setTimeout(r, (minSec + Math.random() * (maxSec - minSec)) * 1000))

2. Vary request patterns within each month:
   - Random page size: 20-50 (not always 50)
   - Random delay between pages: 2-8 seconds
   - Occasionally "pause to read": 10-30 second pause every 5-8 pages
   - Random order: sometimes start from last page instead of first

3. Session behavior:
   - Logout and re-login between months (not same session for 3 months)
   - Each re-login: fresh captcha solve
   - Random time "browsing" the portal after login before starting fetch (5-15 sec)

4. Queue ordering:
   If multiple companies need quarter sync, interleave them:
   Instead of: Company A (M1, M2, M3) → Company B (M1, M2, M3)
   Do:         Company A M1 → Company B M1 → Company A M2 → Company B M2...
   
   This looks more like multiple real users than one bot cycling companies.

5. Time-of-day awareness:
   Prefer running during business hours Vietnam time (8am-6pm GMT+7)
   If a sync is triggered at 2am: delay start by random 5-30 minutes
   Avoid running exactly on-the-hour (humans don't do that)

Implementation in QueueManager:
  scheduleQuarterSync(companyId, year, quarter): void
    Create 3 BullMQ jobs with:
    - job1: delay=0
    - job2: delay=randomBetween(45000, 90000)  // 45-90s after job1
    - job3: delay=job2.delay + randomBetween(30000, 120000)
    Set jobGroupId so they can be tracked together in UI
```

### SYNC-UI-03 — Real-time progress display
```
[Respond in Vietnamese]
Create real-time sync progress UI using Server-Sent Events (SSE).

Backend: GET /api/sync/progress/:jobId (SSE endpoint)
  Use Node.js response streaming (not WebSocket — simpler, no library needed):
  
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  
  Subscribe to BullMQ job progress events:
  const job = await queue.getJob(jobId)
  
  // Poll every 1 second and emit progress
  const interval = setInterval(async () => {
    const progress = await job.progress()
    const state    = await job.getState()
    
    res.write(`data: ${JSON.stringify({
      jobId,
      state,          // 'waiting'|'active'|'completed'|'failed'
      progress,       // 0-100
      invoicesFetched: job.data.invoicesFetched ?? 0,
      currentPage:     job.data.currentPage ?? 0,
      totalPages:      job.data.totalPages ?? null,
      currentMonth:    job.data.currentMonth ?? '',  // for quarter sync
      message:         job.data.statusMessage ?? '',
      error:           job.failedReason ?? null
    })}\n\n`)
    
    if (state === 'completed' || state === 'failed') {
      clearInterval(interval)
      res.end()
    }
  }, 1000)
  
  req.on('close', () => clearInterval(interval))

Frontend: SyncProgressPanel component

When user clicks [Bắt đầu đồng bộ]:
  1. POST /api/sync/start → returns { jobIds: string[] } (1 for month, 3 for quarter)
  2. Open progress panel (slide-up on mobile, inline below button on desktop)
  3. Connect SSE for each jobId

Progress panel layout:
  Header: "Đang đồng bộ hóa đơn" + spinning icon
  
  For quarter sync — show 3 rows (one per month):
    Tháng 1/2026: [██████████░░░░░░] 65% — 234 HĐ
    Tháng 2/2026: [░░░░░░░░░░░░░░░░] Chờ...
    Tháng 3/2026: [░░░░░░░░░░░░░░░░] Chờ...
  
  For month sync — single row:
    Tháng 2/2026: [████████████░░░░] 78% — 456 HĐ đầu ra, 89 HĐ đầu vào
  
  Live updating text (changes every few seconds):
    "Đang lấy trang 5/12..."
    "Đang xử lý hóa đơn C26TDL00123..."
    "Đã lưu 234 hóa đơn đầu ra..."
  
  When completed:
    Green checkmark + "✅ Hoàn thành — Đã đồng bộ 567 hóa đơn"
    [Xem hóa đơn vừa đồng bộ] button → /invoices?syncJobId=X
    [Đóng] button
  
  When failed:
    Red X + error message
    [Thử lại] button
    [Xem chi tiết lỗi] expandable

On worker side — update progress messages throughout sync:
  job.updateData({ statusMessage: `Đang lấy trang ${page}/${totalPages}...`, currentPage: page })
  job.updateData({ invoicesFetched: count, statusMessage: `Đã xử lý ${count} hóa đơn...` })
```

---

## GROUP 49 — SETTINGS PAGE OVERHAUL: HIDE PROVIDERS, GDT BOT + IMPORT ONLY

### SET-01 — Hide old provider connectors, keep GDT Bot + Import
```
[Respond in Vietnamese]
CHANGE: /settings/connectors page must be redesigned.
Remove/hide MISA, Viettel, BKAV sections completely.
Keep ONLY: GDT Bot section + Import thủ công section.

Changes to /settings/connectors page:

1. Remove old provider cards:
   Delete or comment out: MisaCard, ViettelCard, BkavCard components.
   Do NOT show them even in a collapsed state.
   If company_connectors table still has old records: they remain in DB but UI hides them.

2. New page layout — only 2 sections:

SECTION 1: GDT BOT
  Card title: "GDT Bot — Đồng bộ tự động từ Cổng Thuế"
  Description: "Bot tự động đăng nhập vào hoadondientu.gdt.gov.vn và tải về toàn bộ
  hóa đơn đầu vào + đầu ra của doanh nghiệp theo lịch."
  
  [IF NOT CONFIGURED — show setup form]
  
  Setup form fields:
    Tên đăng nhập cổng thuế: text input
      Placeholder: "Thường là MST hoặc email đăng ký"
    
    Mật khẩu: password field with show/hide toggle
      Note text below: "🔒 Mật khẩu được mã hóa AES-256 trước khi lưu.
      Chúng tôi không lưu mật khẩu dạng văn bản thô."
    
    Tần suất đồng bộ tự động:
      Radio: Tắt tự động | Mỗi 6 giờ | Mỗi 12 giờ | Mỗi 24 giờ
    
    Terms of service checkbox (REQUIRED to enable):
      ☐ Tôi đồng ý với [Điều khoản sử dụng dịch vụ] và xác nhận rằng mật khẩu
        cổng thuế được cung cấp cho mục đích đồng bộ dữ liệu hóa đơn của doanh nghiệp tôi.
      
      Link "Điều khoản sử dụng dịch vụ" → opens /legal/terms in new tab (or modal)
      
      [Lưu & Kích hoạt Bot] button → DISABLED until checkbox checked
  
  [IF CONFIGURED — show status]
    Status: green dot "Đang hoạt động" or red "Lỗi" etc.
    Last sync: "23/03/2026 14:32 — 156 HĐ đầu ra, 89 HĐ đầu vào"
    Next auto sync: "23/03/2026 20:32 (sau 6 giờ)"
    Username: masked (show only first 2 chars + ***@domain)
    Password: [Đổi mật khẩu] button only — never show password field with value
    
    Buttons:
      [Đồng bộ ngay] → opens SyncDatePicker (from SYNC-UI-01)
      [Tạm dừng tự động] toggle
      [Xóa cấu hình] → confirmation: "Sẽ xóa thông tin đăng nhập. Dữ liệu HĐ vẫn được giữ lại."

SECTION 2: IMPORT THỦ CÔNG
  Card title: "Import Hóa Đơn Thủ Công"
  Description: "Tải file từ hoadondientu.gdt.gov.vn và import vào hệ thống.
  Hỗ trợ: XML (chi tiết), ZIP (chứa nhiều file XML)."
  
  [Hướng dẫn xuất file từ cổng thuế] link → opens help modal (reuse IMP-05 stepper)
  [Đi đến trang Import] button → /import

  Quick stats (if imports exist):
    "Đã import [N] lần | Lần gần nhất: [date] — [count] HĐ"
```

### SET-02 — Enhanced Import: XML + ZIP + Multi-file + Per-file validation
```
[Respond in Vietnamese]
Enhance the /import page to support XML, ZIP (containing XMLs), and multiple files.

CHANGES TO IMPORT UI:

1. Upload area enhancement:
   Accept: ".xml, .zip, application/xml, application/zip"
   Multiple attribute: true (allow selecting multiple files at once)
   
   Drag-and-drop text:
   "Kéo thả hoặc click để chọn file
   Hỗ trợ: XML · ZIP (chứa file XML) · Nhiều file cùng lúc
   Tối đa 50MB mỗi file · Không giới hạn số lượng file"

2. File list display (after selection, before upload):
   Show a list of all selected/dropped files:
   
   File table:
   [File icon] ten-file.xml    | XML   | 2.4 MB  | [Xóa]
   [File icon] hd-t3-2026.zip | ZIP   | 15.7 MB | [Xóa]
   [File icon] mua-vao.xml    | XML   | 890 KB  | [Xóa]
   
   [+ Thêm file] button to add more
   [Xóa tất cả] button
   Total: "3 files — Tổng: 19.1 MB"

3. Per-file validation (runs immediately after selection, before upload):
   Each file is validated client-side + server-side:
   
   Client-side checks (instant, no upload):
     - File extension must be .xml or .zip
     - File size < 50MB
     - For XML: try parsing first 1KB to check valid XML structure
   
   Server-side pre-validation: POST /api/import/pre-validate (multipart)
     Send ALL files at once
     For each file:
       XML: parse XML, check root element, count invoice records, detect direction
       ZIP: extract, list XML files inside, validate each XML
     Return per-file results:
       { filename, status: 'ok'|'error'|'warning', invoiceCount, direction, errors[], warnings[] }

4. Per-file validation display:
   After pre-validate returns, update file table:
   
   ✅ ten-file.xml    | XML | 2.4 MB | 245 HĐ đầu ra, T3/2026 | OK
   ✅ hd-t3-2026.zip | ZIP | 15.7MB | 3 files XML bên trong: 
                                        - hd-out.xml: 156 HĐ ✅
                                        - hd-in.xml:  89 HĐ ✅
                                        - readme.txt: Bỏ qua (không phải XML HĐ)
   ❌ mua-vao.xml    | XML | 890 KB | LỖI: Không phải file hóa đơn hợp lệ
                                       → Root element <SomeOtherFormat> không hợp lệ
   
   Can proceed with valid files even if some fail:
   "2/3 files hợp lệ — có thể import 401 HĐ. File lỗi sẽ bị bỏ qua."
   [Import 401 HĐ từ 2 files hợp lệ] button (skips invalid files)

5. ZIP handling backend:
   In /backend/src/services/ImportService.ts:
   
   async processZipFile(zipBuffer: Buffer, companyId: string): Promise<FileProcessResult[]> {
     const AdmZip = require('adm-zip')  // npm install adm-zip
     const zip = new AdmZip(zipBuffer)
     const entries = zip.getEntries()
     const results: FileProcessResult[] = []
     
     for (const entry of entries) {
       if (entry.isDirectory) continue
       if (!entry.entryName.toLowerCase().endsWith('.xml')) {
         results.push({ filename: entry.entryName, skipped: true, reason: 'Không phải XML' })
         continue
       }
       const xmlBuffer = entry.getData()
       const result    = await this.processXmlFile(xmlBuffer, companyId)
       results.push({ filename: entry.entryName, ...result })
     }
     return results
   }

6. Import progress (when actually importing — multi-file):
   Show progress per file:
   
   ten-file.xml:    [████████████████] ✅ 245 HĐ đã nhập
   hd-out.xml:      [████████░░░░░░░░] Đang nhập... 89/156
   hd-in.xml:       [░░░░░░░░░░░░░░░░] Chờ...
   
   Overall: "Đang nhập... 334/401 HĐ (83%)"
   
   On complete:
   "✅ Import hoàn tất — 398 HĐ đã nhập, 3 HĐ trùng lặp bỏ qua"

7. API changes:
   POST /api/import/pre-validate — accepts multiple files (multipart/form-data)
     Returns: { files: [{ filename, status, invoiceCount, direction, errors }] }
   
   POST /api/import/execute — accepts multiple files
     Processes each valid file sequentially
     Uses SSE (from SYNC-UI-03) for real-time progress

8. ZIP security:
   Max uncompressed size: 200MB (prevent zip bomb)
   Max files in zip: 100 XML files
   Only extract .xml files — ignore everything else
   Validate XML before processing (check for valid HĐ structure)
```


---

## GROUP 50 — PAIN POINT SOLVERS: 5 KILLER FEATURES

> Dựa trên research thực tế các vấn đề kế toán SME Việt Nam đang gặp phải.
> Thứ tự ưu tiên: P50.1 → P50.2 → P50.3 → P50.4 → P50.5
> Mỗi tính năng giải quyết 1 pain point cụ thể có thể gây thiệt hại tài chính thực.

---

### P50.1 — Cash Payment Detector: Tự động flag HĐ tiền mặt >5 triệu bị mất khấu trừ

```
[Respond in Vietnamese]
BUSINESS CONTEXT:
Theo Điều 26 Nghị định 181/2025/NĐ-CP, hóa đơn đầu vào từ 5.000.000đ trở lên phải có
chứng từ thanh toán KHÔNG dùng tiền mặt thì mới được khấu trừ VAT.
Nếu thanh toán tiền mặt → bị loại toàn bộ VAT đầu vào → truy thu + phạt 20%.
Đây là lỗi phổ biến nhất mà kế toán SME thường không biết cho đến khi bị thanh tra.

TASK: Implement CashPaymentDetector as a new service and integrate into VAT reconciliation.

STEP 1 — DB Schema /scripts/015_payment_method.sql:

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) DEFAULT NULL,
  -- 'cash' | 'bank_transfer' | 'cheque' | 'card' | 'mixed' | null (unknown)
  ADD COLUMN IF NOT EXISTS payment_method_source VARCHAR(20) DEFAULT NULL,
  -- 'user_input' | 'inferred_from_amount' | 'gdt_data'
  ADD COLUMN IF NOT EXISTS is_cash_payment_risk BOOLEAN DEFAULT false,
  -- true = total_amount > 5M AND payment_method = 'cash' OR payment_method IS NULL
  ADD COLUMN IF NOT EXISTS cash_risk_acknowledged BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_risk_note TEXT;

CREATE INDEX idx_invoices_cash_risk
  ON invoices(company_id, is_cash_payment_risk)
  WHERE direction = 'input' AND is_cash_payment_risk = true AND deleted_at IS NULL;

STEP 2 — Service /backend/src/services/CashPaymentDetector.ts:

const CASH_THRESHOLD = 5_000_000  // 5 triệu VND per NĐ181/2025

export class CashPaymentDetector {

  // Run after every sync — flag risky invoices
  async scanCompany(companyId: string, month?: number, year?: number): Promise<ScanResult> {
    const query = `
      SELECT id, invoice_number, seller_name, seller_tax_code,
             total_amount, vat_amount, payment_method, invoice_date
      FROM invoices
      WHERE company_id = $1
        AND direction = 'input'
        AND status = 'valid'
        AND deleted_at IS NULL
        AND total_amount >= $2
        AND (payment_method = 'cash' OR payment_method IS NULL)
        ${month ? 'AND EXTRACT(MONTH FROM invoice_date) = $3' : ''}
        ${year  ? `AND EXTRACT(YEAR FROM invoice_date) = $${month ? 4 : 3}` : ''}
    `
    const params: any[] = [companyId, CASH_THRESHOLD]
    if (month) params.push(month)
    if (year)  params.push(year)

    const result = await db.query(query, params)
    const riskyInvoices = result.rows

    // Mark them in DB
    if (riskyInvoices.length > 0) {
      await db.query(`
        UPDATE invoices SET is_cash_payment_risk = true
        WHERE id = ANY($1::uuid[])
      `, [riskyInvoices.map(i => i.id)])
    }

    const totalVatAtRisk = riskyInvoices.reduce((sum, i) => sum + parseFloat(i.vat_amount || 0), 0)

    return {
      riskyCount: riskyInvoices.length,
      totalVatAtRisk,
      invoices: riskyInvoices,
      breakdown: {
        cash: riskyInvoices.filter(i => i.payment_method === 'cash').length,
        unknown: riskyInvoices.filter(i => i.payment_method === null).length
      }
    }
  }

  // User declares payment method for an invoice
  async setPaymentMethod(
    invoiceId: string,
    method: 'cash' | 'bank_transfer' | 'cheque' | 'card',
    userId: string
  ): Promise<void> {
    const isRisk = method === 'cash'
    await db.query(`
      UPDATE invoices SET
        payment_method = $1,
        payment_method_source = 'user_input',
        is_cash_payment_risk = $2,
        updated_at = NOW()
      WHERE id = $3
    `, [method, isRisk, invoiceId])

    // Log to audit_logs
    await db.query(`
      INSERT INTO audit_logs (user_id, entity_type, entity_id, action, new_values)
      VALUES ($1, 'invoice', $3, 'SET_PAYMENT_METHOD', $2)
    `, [userId, JSON.stringify({ payment_method: method, is_cash_payment_risk: isRisk }), invoiceId])
  }

  // Bulk set payment method for multiple invoices
  async bulkSetPaymentMethod(
    invoiceIds: string[],
    method: string,
    userId: string
  ): Promise<void> {
    const isRisk = method === 'cash'
    await db.query(`
      UPDATE invoices SET
        payment_method = $1, payment_method_source = 'user_input',
        is_cash_payment_risk = $2, updated_at = NOW()
      WHERE id = ANY($3::uuid[])
    `, [method, isRisk, invoiceIds])
  }
}

STEP 3 — Integration into TaxFormEngine (chỉ tiêu [23]):
In calculateDeductibleInputVat() for field [23]:
  Default behavior: EXCLUDE invoices where is_cash_payment_risk = true
  Unless: cash_risk_acknowledged = true (user explicitly confirmed they accept the risk)

  SQL for [23]:
  WHERE direction='input' AND status='valid' AND gdt_validated=true
    AND (is_cash_payment_risk = false OR cash_risk_acknowledged = true)
    -- Only include cash risk invoices if user explicitly acknowledged

  Show in declaration review:
  "Đã loại [N] hóa đơn (tổng VAT: [amount]) do nghi ngờ thanh toán tiền mặt >5 triệu.
   Kiểm tra và khai báo phương thức thanh toán để đưa vào khấu trừ."

STEP 4 — VAT Reconciliation page — cash risk section:

Add a dedicated section in /declarations/[id]/review:
  Card title: "⚠️ Hóa đơn nguy cơ mất khấu trừ (thanh toán tiền mặt)"
  
  Only show if riskyCount > 0:
  "Phát hiện [N] hóa đơn đầu vào ≥ 5 triệu chưa xác nhận phương thức thanh toán.
  Tổng VAT có thể mất khấu trừ: [totalVatAtRisk]"
  
  Table with columns: Số HĐ | NCC | Giá trị | VAT | Ngày | Phương thức | Hành động
  
  "Phương thức" column: dropdown per row:
    [Chuyển khoản ✓] [Tiền mặt ✗] [Séc] [Thẻ]
  
  Batch action bar:
    Select all → [Tất cả chuyển khoản] [Tất cả tiền mặt]
  
  After user sets method:
    Bank transfer → row turns green, VAT re-included in [23]
    Cash → row turns red, VAT stays excluded, show loss amount
    "Đã xác nhận: [N] HĐ chuyển khoản (+[VAT vào khấu trừ]) | [M] HĐ tiền mặt (-[VAT bị mất])"
  
  Note at bottom:
  "Căn cứ Điều 26 NĐ181/2025: HĐ ≥5 triệu thanh toán tiền mặt không được khấu trừ VAT."

STEP 5 — Invoice list badge:
  In /invoices page, add badge "⚠️ Chưa xác nhận TT" (orange) on risky input invoices
  Filter option: "Chưa khai báo thanh toán" in filter dropdown
  Click badge → opens payment method modal for that invoice

APIs:
  GET  /api/invoices/cash-risk-summary?companyId=&month=&year=
  PATCH /api/invoices/:id/payment-method  { method: string }
  POST  /api/invoices/bulk-payment-method { ids: string[], method: string }
  POST  /api/invoices/cash-risk/acknowledge/:id { note?: string }
```

---

### P50.2 — Amended Invoice Router: Tự động xử lý HĐ điều chỉnh/thay thế khác kỳ

```
[Respond in Vietnamese]
BUSINESS CONTEXT:
Theo NĐ70/2025 và hướng dẫn thuế: Khi HĐ gốc và HĐ điều chỉnh/thay thế thuộc 2 kỳ khác nhau:
  - HĐ thay thế: kê khai BỔ SUNG kỳ của HĐ gốc (không kê lên kỳ HĐ thay thế)
  - HĐ điều chỉnh: kê phần chênh lệch vào kỳ của HĐ điều chỉnh

Đây là rule phức tạp nhất, gây ra 80% tờ khai bổ sung của SME.
App phải tự phát hiện và hướng dẫn rõ ràng, không để user tự đoán.

TASK: Implement AmendedInvoiceRouter service + UI workflow.

STEP 1 — DB enhancement:

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_relation_type VARCHAR(20) DEFAULT NULL,
  -- 'original' | 'replacement' | 'adjustment' | null
  ADD COLUMN IF NOT EXISTS related_invoice_id UUID REFERENCES invoices(id),
  -- for replacement/adjustment: points to the original invoice
  ADD COLUMN IF NOT EXISTS related_invoice_number VARCHAR(50),
  -- original invoice number (may not be in our DB)
  ADD COLUMN IF NOT EXISTS related_invoice_period VARCHAR(7),
  -- 'YYYY-MM' of the original invoice
  ADD COLUMN IF NOT EXISTS cross_period_flag BOOLEAN DEFAULT false,
  -- true = this invoice and its related original are in DIFFERENT months
  ADD COLUMN IF NOT EXISTS supplemental_declaration_needed BOOLEAN DEFAULT false,
  -- true = user must file a supplemental declaration for the original period
  ADD COLUMN IF NOT EXISTS routing_decision VARCHAR(20) DEFAULT NULL;
  -- 'current_period' | 'supplemental_required' | 'user_confirmed'

STEP 2 — Service /backend/src/services/AmendedInvoiceRouter.ts:

export class AmendedInvoiceRouter {

  // Run after sync to detect cross-period amended invoices
  async analyzeAmendments(companyId: string): Promise<AmendmentAnalysis[]> {
    
    // Find invoices marked as replacement or adjustment (from GDT data)
    // GDT provides: hd_lien_quan (related invoice number) and loai_dieu_chinh
    const amended = await db.query(`
      SELECT i.*,
        related.invoice_date AS related_date,
        related.id AS related_db_id
      FROM invoices i
      LEFT JOIN invoices related
        ON related.invoice_number = i.related_invoice_number
        AND related.company_id = i.company_id
      WHERE i.company_id = $1
        AND i.invoice_relation_type IN ('replacement', 'adjustment')
        AND i.deleted_at IS NULL
        AND i.routing_decision IS NULL  -- not yet processed
      ORDER BY i.invoice_date DESC
    `, [companyId])

    const analyses: AmendmentAnalysis[] = []

    for (const inv of amended.rows) {
      // Determine if cross-period
      const invPeriod  = this.getPeriod(inv.invoice_date)
      const origPeriod = inv.related_date
        ? this.getPeriod(inv.related_date)
        : inv.related_invoice_period  // fallback to stored period string

      const isCrossPeriod = origPeriod && origPeriod !== invPeriod

      // Determine routing rule
      let rule: RoutingRule
      if (!isCrossPeriod) {
        rule = {
          type: 'same_period',
          action: 'Kê khai bình thường trên tờ khai kỳ ' + invPeriod,
          declarationPeriod: invPeriod,
          requiresSupplemental: false
        }
      } else if (inv.invoice_relation_type === 'replacement') {
        rule = {
          type: 'cross_period_replacement',
          action: `HĐ thay thế phải kê trên tờ khai BỔ SUNG kỳ ${origPeriod}`,
          declarationPeriod: origPeriod!,
          requiresSupplemental: true,
          supplementalInstructions: [
            `Bước 1: Lập tờ khai bổ sung cho kỳ ${origPeriod}`,
            `Bước 2: Xóa HĐ gốc ${inv.related_invoice_number} khỏi bảng kê kỳ ${origPeriod}`,
            `Bước 3: Thêm HĐ thay thế ${inv.invoice_number} vào bảng kê kỳ ${origPeriod}`,
            `Bước 4: KHÔNG kê HĐ thay thế trên tờ khai kỳ ${invPeriod}`
          ]
        }
      } else {  // adjustment
        rule = {
          type: 'cross_period_adjustment',
          action: `HĐ điều chỉnh kê phần chênh lệch trên tờ khai kỳ ${invPeriod} (kỳ phát sinh HĐ điều chỉnh)`,
          declarationPeriod: invPeriod,
          requiresSupplemental: false,
          adjustmentNote: 'Chỉ kê phần chênh lệch tăng/giảm, không kê toàn bộ giá trị HĐ điều chỉnh'
        }
      }

      // Update invoice with analysis result
      await db.query(`
        UPDATE invoices SET
          cross_period_flag = $1,
          supplemental_declaration_needed = $2,
          routing_decision = $3,
          related_invoice_period = $4
        WHERE id = $5
      `, [isCrossPeriod, rule.requiresSupplemental, rule.type, origPeriod, inv.id])

      analyses.push({ invoice: inv, rule, isCrossPeriod })
    }

    return analyses
  }

  private getPeriod(date: Date | string): string {
    const d = new Date(date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  // Generate supplemental declaration draft
  async createSupplementalDraft(
    companyId: string,
    originalPeriod: string,  // 'YYYY-MM'
    amendedInvoiceId: string
  ): Promise<TaxDeclarationDraft> {
    const [year, month] = originalPeriod.split('-').map(Number)

    // Check if supplemental already exists for this period
    const existing = await db.query(`
      SELECT id FROM tax_declarations
      WHERE company_id=$1 AND period_month=$2 AND period_year=$3
        AND declaration_type='supplemental'
    `, [companyId, month, year])

    if (existing.rowCount === 0) {
      // Create new supplemental declaration based on the original
      const original = await db.query(`
        SELECT * FROM tax_declarations
        WHERE company_id=$1 AND period_month=$2 AND period_year=$3
          AND declaration_type='initial'
        ORDER BY created_at DESC LIMIT 1
      `, [companyId, month, year])

      await db.query(`
        INSERT INTO tax_declarations
          (company_id, form_version_id, period_month, period_year,
           declaration_type, status, field_values, base_declaration_id)
        VALUES ($1, $2, $3, $4, 'supplemental', 'draft', $5, $6)
      `, [companyId, original.rows[0]?.form_version_id,
          month, year,
          original.rows[0]?.field_values || '{}',
          original.rows[0]?.id])
    }

    return { period: originalPeriod, type: 'supplemental', status: 'draft' }
  }
}

STEP 3 — Invoice list UI: cross-period flag indicator

In /invoices invoice cards, when invoice has cross_period_flag=true:
  Show badge: "🔄 HĐ thay thế/điều chỉnh" (blue)
  Clicking badge opens AmendmentGuideModal:

  AmendmentGuideModal layout:
    Header: "Hướng dẫn kê khai HĐ điều chỉnh/thay thế"
    
    Info box (blue):
      Type: [Hóa đơn thay thế | Hóa đơn điều chỉnh]
      HĐ gốc: [related_invoice_number] — Kỳ: [origPeriod]
      HĐ này: [invoice_number] — Kỳ: [invPeriod]
      Tình huống: [Cùng kỳ | Khác kỳ]
    
    IF cross_period AND replacement:
      Red warning box:
      "⚠️ HĐ thay thế khác kỳ — CẦN LẬP TỜ KHAI BỔ SUNG"
      
      Step-by-step instructions (numbered list):
        1. Lập tờ khai bổ sung cho kỳ [origPeriod]
        2. Xóa HĐ gốc [related_invoice_number] khỏi bảng kê kỳ [origPeriod]
        3. Thêm HĐ thay thế này vào bảng kê kỳ [origPeriod]
        4. HĐ thay thế này KHÔNG kê trên tờ khai kỳ [invPeriod]
      
      [Tạo nháp tờ khai bổ sung kỳ {origPeriod}] button (green)
        → calls createSupplementalDraft() → navigates to /declarations/new?type=supplemental&period={origPeriod}
      
      [Đã hiểu — đánh dấu đã xử lý] button
        → SET routing_decision='user_confirmed'
    
    IF cross_period AND adjustment:
      Orange info box:
      "ℹ️ HĐ điều chỉnh khác kỳ — kê PHẦN CHÊNH LỆCH trên kỳ [invPeriod]"
      
      Instruction:
      "Chỉ kê phần giá trị chênh lệch tăng/giảm lên tờ khai kỳ [invPeriod],
      KHÔNG kê toàn bộ giá trị của HĐ điều chỉnh."
      
      If we have original in DB: show delta calculation:
        HĐ gốc: [originalAmount] | HĐ điều chỉnh: [thisAmount]
        Chênh lệch cần kê: [delta] (tăng/giảm)
    
    IF same_period:
      Green box: "✅ Cùng kỳ — kê bình thường trên tờ khai kỳ [invPeriod]"

STEP 4 — Declaration alerts for amended invoices:

In /declarations/[id]/review validation section:
  Auto-check: are there any cross_period_flag=true invoices that have NOT been routed?
  
  If yes — show ERROR (block declaration):
  "🚫 Có [N] hóa đơn điều chỉnh/thay thế chưa được xử lý đúng kỳ.
  Kê khai sai kỳ có thể dẫn đến tờ khai sai và phải nộp bổ sung.
  Xem và xử lý trước khi hoàn tất tờ khai."
  
  [Xem hóa đơn cần xử lý →] link to /invoices?filter=cross_period_unrouted

STEP 5 — Supplemental declaration support:

In /declarations page, add tab: "Tờ khai bổ sung"
  List all supplemental declarations (declaration_type='supplemental')
  Status: Draft | Completed | Submitted
  
  Supplemental declaration form:
    Header shows: "TỜ KHAI BỔ SUNG — Tháng [M]/[Y]"
    Pre-populated from original declaration values
    User edits affected chỉ tiêu only
    Show comparison: Original value vs Corrected value vs Difference
    
    After submit: calculate late payment interest (tiền chậm nộp):
      0.03% per day × days_since_deadline × tax_difference
      Show: "Tiền chậm nộp ước tính: [amount] (từ ngày 20/[M+1]/[Y] đến hôm nay)"

APIs:
  GET  /api/invoices/amendments?companyId=&status=unrouted
  POST /api/invoices/:id/route-amendment { decision: string }
  POST /api/declarations/supplemental { companyId, period, baseDeclarationId }
  GET  /api/declarations/:id/amendment-delta  → returns diff vs original
```

---

### P50.3 — Late Filing Penalty Calculator: Tính tiền chậm nộp + hỗ trợ quyết định

```
[Respond in Vietnamese]
BUSINESS CONTEXT:
Khi phát hiện sai sót sau khi đã nộp tờ khai, doanh nghiệp phải quyết định:
  1. Có nên kê khai bổ sung không?
  2. Nếu có, tiền chậm nộp sẽ là bao nhiêu?
  3. Hạn chót để tránh bị xử phạt thêm là khi nào?
Hiện tại user không có tool để tính toán điều này → thường trì hoãn → lãi phạt tăng thêm.

TASK: Create PenaltyCalculator service + interactive UI widget.

STEP 1 — Service /backend/src/services/PenaltyCalculator.ts:

const DAILY_RATE = 0.0003  // 0.03% per day

export class PenaltyCalculator {

  calculate(params: {
    taxAmount: number        // số thuế sai lệch phải nộp thêm
    originalDeadline: Date   // ngày 20 của tháng sau kỳ khai
    paymentDate: Date        // ngày dự kiến nộp bổ sung
    hasPriorVoluntary: boolean  // true = tự phát hiện trước thanh tra (miễn xử phạt hành chính)
  }): PenaltyResult {

    const daysLate = Math.max(0, Math.floor(
      (params.paymentDate.getTime() - params.originalDeadline.getTime()) / (1000 * 60 * 60 * 24)
    ))

    const lateInterest = params.taxAmount * DAILY_RATE * daysLate

    // Late filing penalty (phạt chậm nộp hồ sơ) — separate from interest
    let filingPenalty = 0
    if (daysLate > 0 && daysLate <= 30)  filingPenalty = 2_000_000
    else if (daysLate <= 60)              filingPenalty = 3_000_000
    else if (daysLate <= 90)             filingPenalty = 4_000_000
    else                                  filingPenalty = 5_000_000

    // If voluntary self-disclosure before tax audit: no admin penalty (Điều 125 Luật QLTT)
    const adminPenalty = params.hasPriorVoluntary ? 0 : filingPenalty

    const totalPayable = params.taxAmount + lateInterest + adminPenalty

    return {
      taxAmount: params.taxAmount,
      daysLate,
      lateInterest: Math.round(lateInterest),
      adminPenalty,
      totalPayable: Math.round(totalPayable),
      breakdown: {
        dailyRate: `${(DAILY_RATE * 100).toFixed(2)}%/ngày`,
        formula: `${params.taxAmount.toLocaleString('vi-VN')} × 0.03% × ${daysLate} ngày = ${Math.round(lateInterest).toLocaleString('vi-VN')}đ`
      },
      recommendation: this.buildRecommendation(daysLate, params.taxAmount, lateInterest, params.hasPriorVoluntary)
    }
  }

  private buildRecommendation(days: number, tax: number, interest: number, voluntary: boolean): string {
    if (days === 0) return '✅ Chưa quá hạn — nộp bổ sung ngay để tránh phát sinh lãi'
    if (days <= 30 && voluntary) {
      return `⚡ Nộp ngay: tiền lãi chỉ ${interest.toLocaleString('vi-VN')}đ, không bị phạt hành chính vì tự phát hiện`
    }
    if (days > 90) {
      return `⚠️ Đã quá 90 ngày: tiền phạt đang tích lũy. Nộp bổ sung ngay để dừng tính lãi.`
    }
    return `Nộp bổ sung sớm nhất có thể để giảm thiểu lãi phạt`
  }

  // Calculate break-even: if tax difference is small, is it worth filing?
  costBenefitAnalysis(params: {
    taxDifference: number    // số tiền thuế sai lệch (có thể âm = thuế giảm)
    daysLate: number
    estimatedAuditRisk: 'low' | 'medium' | 'high'  // risk of being audited
  }): CostBenefitResult {
    // If tax difference is negative (overpaid), filing supplemental = get refund
    // If positive (underpaid), weigh penalty vs audit risk

    const currentInterest = params.taxDifference * DAILY_RATE * params.daysLate
    const auditRiskMultiplier = { low: 1, medium: 3, high: 10 }[params.estimatedAuditRisk]
    const expectedAuditPenalty = params.taxDifference * 0.20 * auditRiskMultiplier  // 20% penalty if caught

    return {
      shouldFile: params.taxDifference > 0 || currentInterest > 500_000,
      costIfFileNow: currentInterest,
      expectedCostIfCaught: params.taxDifference + expectedAuditPenalty,
      savingsByFilingNow: Math.max(0, expectedAuditPenalty - currentInterest),
      recommendation: params.taxDifference < 0
        ? 'Nộp bổ sung để nhận lại tiền thuế nộp thừa'
        : `Nên nộp bổ sung ngay: tiết kiệm ~${Math.round(expectedAuditPenalty - currentInterest).toLocaleString('vi-VN')}đ so với rủi ro bị thanh tra`
    }
  }
}

STEP 2 — Interactive UI component: PenaltyCalculatorWidget

Create a dedicated interactive calculator embedded in /declarations page
and accessible from /audit/anomalies.

Widget layout (React component with live calculation):

Title: "🧮 Tính Tiền Chậm Nộp & Hỗ Trợ Quyết Định"

Input section:
  Số thuế phải nộp thêm: currency input (large, auto-formatted VND)
  Kỳ khai báo gốc: month/year picker (auto-calculates deadline = 20th of next month)
  Hạn nộp gốc: [auto-display: "20/MM/YYYY"] (read-only)
  Ngày dự kiến nộp bổ sung: date picker (default: today)
  Tự phát hiện (chưa bị thanh tra): toggle YES/NO (affects admin penalty)

Live result section (updates as user types):
  
  Breakdown cards (3 inline cards):
    [Số thuế chênh lệch]   [Tiền lãi chậm nộp]   [Phạt hành chính]
    [amount]               [amount]               [amount or MIỄN]
  
  TOTAL payable: large number, red color
  "Mỗi ngày tiếp tục chậm nộp thêm: +[daily_amount]đ" (orange, update live)
  
  Formula breakdown (expandable):
    "Tiền lãi = [taxAmount] × 0.03%/ngày × [daysLate] ngày = [interest]"
  
  Cost-benefit analysis box:
    "Nếu bị thanh tra phát hiện: phạt thêm 20% = [penaltyIfCaught]đ"
    "Nộp bổ sung ngay tiết kiệm: ~[savings]đ"
    [Verdict badge]: "✅ NÊN NỘP BỔ SUNG NGAY" or "ℹ️ CÂN NHẮC"
  
  [Bắt đầu lập tờ khai bổ sung] button → /declarations/new?type=supplemental

Legal reference (collapsible):
  "Căn cứ pháp lý: Điều 59 Luật QLT, Điều 13 NĐ125/2020"
  "Tỷ lệ lãi: 0.03%/ngày từ ngày kế tiếp ngày hết hạn"
  "Miễn phạt hành chính: Người nộp thuế tự phát hiện và nộp trước khi CQT kiểm tra"

STEP 3 — Embed in declaration workflow:

In /declarations/[id]/review, if there's any error or warning found:
  Add collapsible section: "Ước tính hậu quả nếu nộp sai"
  Show mini version of calculator pre-filled with:
    taxAmount = estimated_difference (if declaration has errors)
    deadline  = 20th of next month from period
    paymentDate = today
  
  This motivates users to fix issues BEFORE submitting.

STEP 4 — Standalone page /tools/penalty-calculator:
  Full page version of the widget
  Share URL: can share pre-filled link with params
  Print button: "In kết quả để lưu hồ sơ"

API:
  POST /api/tools/penalty-calculate
    Body: { taxAmount, originalDeadline, paymentDate, hasPriorVoluntary }
    Returns: PenaltyResult
  
  POST /api/tools/cost-benefit
    Body: { taxDifference, originalDeadline, estimatedAuditRisk }
    Returns: CostBenefitResult
```

---

### P50.4 — Missing Invoice Finder: Phát hiện HĐ đầu vào bị thiếu

```
[Respond in Vietnamese]
BUSINESS CONTEXT:
Khi DN A mua hàng từ DN B: DN B phát HĐ đầu ra → DN A có HĐ đầu vào.
GDT lưu HĐ này từ 2 phía. Nếu DN A thiếu HĐ đầu vào (chưa đồng bộ hoặc bị lọt),
DN A đang đóng thuế thừa mà không hay.

LOGIC: Khi sync đầu ra của DN A → hệ thống thấy DN B đã bán cho DN A (buyer_tax_code).
Nếu DN A là user của hệ thống → kiểm tra xem DN A có HĐ đầu vào tương ứng từ DN B không.
Nếu không có → flag là "HĐ đầu vào bị thiếu".

NOTE: This only works when BOTH buyer and seller are companies managed in the system,
OR when GDT bot has synced input invoices for the company.

TASK: Create MissingInvoiceFinder service + alert UI.

STEP 1 — DB Schema:

CREATE TABLE missing_invoice_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id),  -- the BUYER company
  seller_tax_code VARCHAR(20) NOT NULL,
  seller_name     VARCHAR(255),
  expected_invoice_number VARCHAR(50),  -- if known from seller's output data
  expected_invoice_date DATE,
  expected_amount   NUMERIC(22,2),
  expected_vat      NUMERIC(22,2),
  detection_source  VARCHAR(20),  -- 'cross_company' | 'gdt_mismatch' | 'seller_reported'
  status            VARCHAR(20) DEFAULT 'open',
  -- 'open' | 'found' | 'not_applicable' | 'acknowledged'
  found_invoice_id  UUID REFERENCES invoices(id),  -- set when matched
  acknowledged_note TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, seller_tax_code, expected_invoice_number)
);

CREATE INDEX idx_missing_inv_company ON missing_invoice_alerts(company_id, status);

STEP 2 — Service /backend/src/services/MissingInvoiceFinder.ts:

export class MissingInvoiceFinder {

  // Strategy 1: Cross-company detection (both companies in system)
  async scanCrossCompany(userId: string, month: number, year: number): Promise<void> {
    // Get all companies this user manages
    const userCompanies = await db.query(`
      SELECT c.id, c.tax_code FROM companies c
      JOIN user_companies uc ON c.id = uc.company_id
      WHERE uc.user_id = $1
    `, [userId])

    const taxCodes = userCompanies.rows.map(c => c.tax_code)
    if (taxCodes.length < 2) return  // need at least 2 companies

    // Find output invoices where buyer is one of user's other companies
    for (const company of userCompanies.rows) {
      const outputToOwnCompanies = await db.query(`
        SELECT i.invoice_number, i.invoice_date, i.buyer_tax_code,
               i.buyer_name, i.total_amount, i.vat_amount, i.seller_tax_code
        FROM invoices i
        WHERE i.company_id = $1
          AND i.direction = 'output'
          AND i.status = 'valid'
          AND i.buyer_tax_code = ANY($2::text[])
          AND i.buyer_tax_code != i.seller_tax_code  -- exclude self-invoices
          AND EXTRACT(MONTH FROM i.invoice_date) = $3
          AND EXTRACT(YEAR FROM i.invoice_date) = $4
          AND i.deleted_at IS NULL
      `, [company.id, taxCodes.filter(tc => tc !== company.tax_code), month, year])

      for (const outInv of outputToOwnCompanies.rows) {
        // Find the buyer company in our system
        const buyerCompany = userCompanies.rows.find(c => c.tax_code === outInv.buyer_tax_code)
        if (!buyerCompany) continue

        // Check if buyer has corresponding input invoice
        const inputExists = await db.query(`
          SELECT id FROM invoices
          WHERE company_id = $1
            AND direction = 'input'
            AND seller_tax_code = $2
            AND invoice_number = $3
            AND deleted_at IS NULL
        `, [buyerCompany.id, company.tax_code, outInv.invoice_number])

        if (inputExists.rowCount === 0) {
          // Missing! Create alert
          await db.query(`
            INSERT INTO missing_invoice_alerts
              (company_id, seller_tax_code, seller_name, expected_invoice_number,
               expected_invoice_date, expected_amount, expected_vat, detection_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'cross_company')
            ON CONFLICT (company_id, seller_tax_code, expected_invoice_number) DO NOTHING
          `, [buyerCompany.id, company.tax_code, /* seller name */ '',
              outInv.invoice_number, outInv.invoice_date,
              outInv.total_amount, outInv.vat_amount])
        }
      }
    }
  }

  // Strategy 2: GDT mismatch (compare GDT validation count vs our DB count)
  async scanGdtMismatch(companyId: string, month: number, year: number): Promise<MismatchResult> {
    // After GDT validation, GDT tells us how many invoices are in the system
    // If GDT says there are 150 input invoices but we only have 120 → 30 missing
    // NOTE: This requires GDT to return total count in their API response

    const dbCount = await db.query(`
      SELECT COUNT(*) as count FROM invoices
      WHERE company_id=$1 AND direction='input'
        AND EXTRACT(MONTH FROM invoice_date)=$2
        AND EXTRACT(YEAR FROM invoice_date)=$3
        AND deleted_at IS NULL
    `, [companyId, month, year])

    // GDT total count from last bot run (stored in gdt_bot_runs)
    const gdtRun = await db.query(`
      SELECT input_count FROM gdt_bot_runs
      WHERE company_id=$1
        AND status='success'
      ORDER BY finished_at DESC LIMIT 1
    `, [companyId])

    const dbTotal  = parseInt(dbCount.rows[0].count)
    const gdtTotal = gdtRun.rows[0]?.input_count || 0

    return {
      dbCount: dbTotal,
      gdtCount: gdtTotal,
      missingCount: Math.max(0, gdtTotal - dbTotal),
      hasMismatch: gdtTotal > dbTotal
    }
  }

  // Try to auto-match found invoices to existing alerts
  async matchFoundInvoices(companyId: string): Promise<number> {
    const alerts = await db.query(`
      SELECT id, seller_tax_code, expected_invoice_number
      FROM missing_invoice_alerts
      WHERE company_id=$1 AND status='open'
    `, [companyId])

    let matched = 0
    for (const alert of alerts.rows) {
      const found = await db.query(`
        SELECT id FROM invoices
        WHERE company_id=$1 AND direction='input'
          AND seller_tax_code=$2 AND invoice_number=$3
          AND deleted_at IS NULL
      `, [companyId, alert.seller_tax_code, alert.expected_invoice_number])

      if (found.rowCount > 0) {
        await db.query(`
          UPDATE missing_invoice_alerts SET status='found', found_invoice_id=$1
          WHERE id=$2
        `, [found.rows[0].id, alert.id])
        matched++
      }
    }
    return matched
  }
}

STEP 3 — Missing Invoice Alert UI:

Add to /dashboard: "Hóa Đơn Đầu Vào Bị Thiếu" widget
  Show only if missing_invoice_alerts.status='open' count > 0
  
  Widget:
    "🔍 Phát hiện [N] hóa đơn đầu vào có thể bị thiếu"
    "Tổng VAT ước tính bị thiếu: [total_vat]"
    [Xem chi tiết →] → /invoices/missing

/invoices/missing page:
  
  Header: "Hóa Đơn Đầu Vào Bị Thiếu" + info tooltip explaining detection method
  
  Filter tabs: Tất cả | Nội bộ (từ công ty khác của bạn) | GDT mismatch
  
  Alert cards:
    [Icon: Invoice with question mark]
    NCC: [seller_name] — MST: [seller_tax_code]
    Số HĐ dự kiến: [expected_invoice_number] (if known)
    Ngày: [expected_invoice_date] | Giá trị: [amount] | VAT: [vat]
    Nguồn phát hiện: [Đối chiếu nội bộ | GDT không khớp]
    
    Action buttons:
      [Đồng bộ lại ngay] → trigger bot sync for this seller's invoices
      [Nhập thủ công] → open manual import for this invoice
      [Không áp dụng] → mark as not_applicable with note (e.g., "HĐ này chúng tôi không mua")
      [Đã tìm thấy] → mark as found, select which invoice matches

  Summary box:
    "Nếu tìm được đủ [N] HĐ này, VAT đầu vào tăng thêm: [total_vat]
     Thuế GTGT phải nộp giảm: ~[potential_saving]đ"

API:
  GET  /api/invoices/missing?companyId=&status=open
  GET  /api/invoices/missing/summary?companyId=
  POST /api/invoices/missing/scan  → trigger MissingInvoiceFinder.scan()
  PATCH /api/invoices/missing/:id/status  { status, note }
```

---

### P50.5 — Tax Rate Anomaly Alert: Cảnh báo áp sai thuế suất (8% vs 10%)

```
[Respond in Vietnamese]
BUSINESS CONTEXT:
Theo NQ204/2025/QH15: Từ 01/07/2025 đến 31/12/2026, một số nhóm hàng hóa giảm từ 10% → 8%.
NHƯNG: Một số ngành KHÔNG được giảm (viễn thông, ngân hàng, bất động sản, kim loại...).
Nhiều DN vô tình:
  1. Xuất HĐ 10% cho hàng đáng lẽ được hưởng 8% → thu thừa VAT của khách, vi phạm quy định
  2. Xuất HĐ 8% cho hàng KHÔNG được giảm → thiếu VAT, rủi ro bị truy thu
  3. Cùng 1 mặt hàng xuất lúc 8% lúc 10% → không nhất quán → bị nghi ngờ khi thanh tra

TASK: TaxRateAnomalyDetector — phát hiện và cảnh báo sai thuế suất.

STEP 1 — DB: Tax rate rules table

CREATE TABLE vat_rate_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name       VARCHAR(100) NOT NULL,
  decree_ref      VARCHAR(100),           -- 'NQ204/2025/QH15', 'NĐ174/2025/NĐ-CP'
  effective_from  DATE NOT NULL,
  effective_to    DATE,                   -- NULL = still active
  standard_rate   NUMERIC(4,1),           -- 10
  reduced_rate    NUMERIC(4,1),           -- 8
  applies_to      TEXT[],                 -- industry codes or keywords ['thực phẩm', 'dịch vụ ăn uống']
  excluded_from   TEXT[],                 -- ['viễn thông', 'ngân hàng', 'bất động sản', 'kim loại']
  is_active       BOOLEAN DEFAULT true
);

-- Seed current rule (Jul 2025 - Dec 2026)
INSERT INTO vat_rate_rules (rule_name, decree_ref, effective_from, effective_to,
  standard_rate, reduced_rate, excluded_from)
VALUES (
  'Giảm 2% VAT 2025-2026',
  'NQ204/2025/QH15 + NĐ174/2025/NĐ-CP',
  '2025-07-01', '2026-12-31',
  10, 8,
  ARRAY['viễn thông', 'công nghệ thông tin', 'tài chính', 'ngân hàng', 'chứng khoán',
        'bảo hiểm', 'bất động sản', 'kim loại', 'khai khoáng', 'than cốc',
        'dầu mỏ tinh chế', 'hóa chất', 'thuốc lá', 'bia rượu', 'ô tô']
);

STEP 2 — Service /backend/src/services/TaxRateAnomalyDetector.ts:

export class TaxRateAnomalyDetector {

  async scan(companyId: string, month: number, year: number): Promise<TaxRateAnomaly[]> {
    const anomalies: TaxRateAnomaly[] = []
    const periodDate = new Date(year, month - 1, 1)

    // ANOMALY TYPE 1: Same item appearing with multiple different VAT rates
    const inconsistentRates = await db.query(`
      SELECT
        ili.normalized_item_name,
        ARRAY_AGG(DISTINCT ili.vat_rate ORDER BY ili.vat_rate) AS vat_rates,
        COUNT(DISTINCT ili.vat_rate) AS rate_count,
        COUNT(ili.id) AS invoice_count,
        SUM(ili.vat_amount) AS total_vat
      FROM invoice_line_items ili
      JOIN invoices i ON ili.invoice_id = i.id
      WHERE i.company_id = $1
        AND i.direction = 'output'
        AND i.status = 'valid'
        AND EXTRACT(MONTH FROM i.invoice_date) = $2
        AND EXTRACT(YEAR FROM i.invoice_date) = $3
        AND ili.deleted_at IS NULL
        AND ili.normalized_item_name IS NOT NULL
      GROUP BY ili.normalized_item_name
      HAVING COUNT(DISTINCT ili.vat_rate) > 1
      ORDER BY SUM(ili.vat_amount) DESC
    `, [companyId, month, year])

    for (const item of inconsistentRates.rows) {
      anomalies.push({
        type: 'INCONSISTENT_RATE',
        severity: 'warning',
        itemName: item.normalized_item_name,
        vatRates: item.vat_rates,
        invoiceCount: item.invoice_count,
        totalVat: item.total_vat,
        message: `Mặt hàng "${item.normalized_item_name}" được kê khai với ${item.rate_count} mức thuế suất khác nhau: ${item.vat_rates.join('%, ')}%`,
        suggestion: 'Kiểm tra lại: cùng 1 mặt hàng phải áp cùng 1 thuế suất trong cùng kỳ. Không nhất quán có thể bị nghi ngờ khi thanh tra.'
      })
    }

    // ANOMALY TYPE 2: Items using 10% during reduced-rate period (Jul 2025 - Dec 2026)
    // when they should potentially be 8%
    if (periodDate >= new Date('2025-07-01') && periodDate <= new Date('2026-12-31')) {
      const highRateItems = await db.query(`
        SELECT
          ili.normalized_item_name,
          COUNT(ili.id) AS invoice_count,
          SUM(ili.subtotal) AS total_subtotal,
          SUM(ili.vat_amount) AS vat_collected,
          (SUM(ili.subtotal) * 0.02) AS potential_overcharge
        FROM invoice_line_items ili
        JOIN invoices i ON ili.invoice_id = i.id
        WHERE i.company_id = $1
          AND i.direction = 'output'
          AND i.status = 'valid'
          AND ili.vat_rate = 10
          AND EXTRACT(MONTH FROM i.invoice_date) = $2
          AND EXTRACT(YEAR FROM i.invoice_date) = $3
          AND ili.deleted_at IS NULL
        GROUP BY ili.normalized_item_name
        ORDER BY SUM(ili.subtotal) DESC
        LIMIT 20
      `, [companyId, month, year])

      // Use Gemini to classify which items might qualify for 8% rate
      if (highRateItems.rows.length > 0) {
        const itemNames = highRateItems.rows.map(i => i.normalized_item_name)
        const classification = await this.classifyItemsWithAI(itemNames, periodDate)

        for (const item of highRateItems.rows) {
          const cls = classification[item.normalized_item_name]
          if (cls === 'likely_eligible_for_8pct') {
            anomalies.push({
              type: 'POSSIBLE_WRONG_RATE_10_SHOULD_BE_8',
              severity: 'info',
              itemName: item.normalized_item_name,
              vatRates: [10],
              invoiceCount: item.invoice_count,
              totalVat: item.vat_collected,
              potentialDifference: parseFloat(item.potential_overcharge),
              message: `Mặt hàng "${item.normalized_item_name}" đang áp thuế 10% trong giai đoạn giảm thuế (Jul 2025 - Dec 2026) — có thể đủ điều kiện áp 8%`,
              suggestion: 'Xác nhận với kế toán trưởng: nếu hàng hóa này không thuộc nhóm loại trừ (viễn thông, ngân hàng, bất động sản...), nên áp 8%.'
            })
          }
          if (cls === 'excluded_no_reduction') {
            // Item is in excluded list but being charged 8% — risk
            if (highRateItems.rows.find(i => i.normalized_item_name === item.normalized_item_name && i.vat_rate === 8)) {
              anomalies.push({
                type: 'POSSIBLE_WRONG_RATE_8_SHOULD_BE_10',
                severity: 'warning',
                message: `"${item.normalized_item_name}" thuộc nhóm KHÔNG được giảm thuế, nhưng đang áp 8%. Nguy cơ truy thu phần thuế còn thiếu.`
              })
            }
          }
        }
      }
    }

    // Save anomalies to price_anomalies table (reuse existing infrastructure)
    // OR save to a new tax_rate_anomalies table
    return anomalies
  }

  private async classifyItemsWithAI(itemNames: string[], periodDate: Date): Promise<Record<string, string>> {
    const excluded = ['viễn thông', 'ngân hàng', 'bất động sản', 'kim loại', 'khai khoáng', 'chứng khoán', 'bảo hiểm', 'thuốc lá', 'bia', 'rượu']

    const prompt = `Các mặt hàng sau đây có thuộc nhóm được GIẢM thuế GTGT từ 10% xuống 8% theo NQ204/2025/QH15 không?
Nhóm KHÔNG được giảm: ${excluded.join(', ')} và sản phẩm chịu thuế tiêu thụ đặc biệt.
Các nhóm khác: CÓ THỂ được giảm nếu đang chịu mức 10%.

Danh sách cần phân loại:
${itemNames.map((n, i) => `${i+1}. ${n}`).join('\n')}

Trả về JSON: {"tên_mặt_hàng": "likely_eligible_for_8pct" | "excluded_no_reduction" | "uncertain"}
Chỉ JSON, không giải thích.`

    try {
      const response = await callGemini(prompt, 500)
      return JSON.parse(response.replace(/```json|```/g, '').trim())
    } catch {
      return {}
    }
  }
}

STEP 3 — UI Integration:

1. Dashboard widget "Kiểm tra Thuế Suất":
   Run scan after each sync
   If anomalies > 0:
     "⚠️ [N] mặt hàng có thuế suất bất thường — xem chi tiết"
   [→ /audit/tax-rates]

2. /audit/tax-rates page:
   
   Header: "Kiểm tra Thuế Suất Hóa Đơn" + period selector
   
   Filter tabs: Tất cả | Không nhất quán | Sai mức giảm | Cần xác nhận
   
   Anomaly cards:
     [SEVERITY BADGE] [TYPE]
     Mặt hàng: [name] (bold)
     Thuế suất phát hiện: [rates] (e.g., "8% và 10%")
     Số HĐ liên quan: [count] | VAT liên quan: [amount]
     AI nhận xét: [classification + suggestion]
     
     Actions:
       [Xem HĐ liên quan] → filter invoices by item name
       [Đúng rồi, bỏ qua] → acknowledge anomaly
       [Cần điều chỉnh] → redirect to /invoices to make corrections

3. In declaration review (pre-submission check):
   Add validation rule for tax rate anomalies:
   If inconsistent_rate anomalies exist for output invoices → WARNING
   "Phát hiện [N] mặt hàng với thuế suất không nhất quán trong kỳ này.
   Kiểm tra tại /audit/tax-rates trước khi nộp."

API:
  POST /api/audit/tax-rates/scan?companyId=&month=&year=
  GET  /api/audit/tax-rates?companyId=&month=&year=
  PATCH /api/audit/tax-rates/:id/acknowledge
```


---

## GROUP 51 — GDT BOT: ENTERPRISE SCALE (1000 USERS, ANTI-DETECTION)

> Mục tiêu: Scale từ vài chục lên 1000 user đồng thời mà GDT không phát hiện.
> Thứ tự thực hiện bắt buộc: BOT-ENT-01 → 02 → 03 → 04 → 05 → 06

### BOT-ENT-01 — Dedicated Queues + Sticky Sessions (Fast/Slow Path)
```
[Respond in Vietnamese]
CRITICAL CONTEXT: GDT uses Session Binding WAF. If the IP address or User-Agent changes
between Login and subsequent Data Fetch requests within the same session, GDT immediately
invalidates the token and blocks the account. Therefore:
  1 Job = 1 Proxy IP = 1 User-Agent = 1 Session (throughout entire job lifetime)
  NEVER rotate proxy or UA per HTTP request — only rotate at JOB level.

TASK 1: Split Queues in /bot/src/sync.worker.ts

Refactor to export two separate BullMQ Workers sharing the same GdtBotRunner logic:

import { Worker, Queue } from 'bullmq'
import IORedis from 'ioredis'

const redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null })

// Fast Path: Manual syncs triggered by user — high priority, high concurrency
export const manualWorker = new Worker('gdt-sync-manual', processGdtSync, {
  connection: redis,
  concurrency: 10,
  limiter: { max: 30, duration: 60_000 },  // 30 jobs per minute max
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    timeout: 300_000
  }
})

// Slow Path: Auto cron syncs — low concurrency to avoid GDT detection
export const autoWorker = new Worker('gdt-sync-auto', processGdtSync, {
  connection: redis,
  concurrency: 2,
  limiter: { max: 5, duration: 60_000 },   // only 5 jobs per minute — very conservative
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 120_000 },  // longer backoff for auto
    timeout: 300_000
  }
})

// Shared queues (for pushing jobs)
export const manualQueue = new Queue('gdt-sync-manual', { connection: redis })
export const autoQueue   = new Queue('gdt-sync-auto',   { connection: redis })

TASK 2: Enforce Sticky Sessions in /bot/src/GdtBotRunner.ts

At the VERY START of each job execution, generate session-level constants:

import { v4 as uuidv4 } from 'uuid'

async function processGdtSync(job: Job<SyncJobData>): Promise<void> {
  // === SESSION BINDING — DO NOT CHANGE WITHIN THIS JOB ===
  const proxySessionId = uuidv4()  // unique ID for this job's proxy slot
  const sessionUA = pickUserAgent() // ONE UA for entire job — see BOT-ENT-04
  // ========================================================

  // Get dedicated proxy for this session
  const proxyUrl = proxyManager.nextForSession(proxySessionId)
  
  // Create axios instance locked to this session's proxy + UA
  const sessionAxios = axios.create({
    timeout: 30_000,
    headers: {
      'User-Agent': sessionUA,
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'application/json, text/plain, */*',
    },
    ...(proxyUrl ? { proxy: parseProxyForAxios(proxyUrl) } : {})
  })

  // Pass sessionAxios to ALL downstream calls
  // GdtAuthService.login(credentials, sessionAxios)
  // GdtApiService.fetchInvoices(session, sessionAxios)
  // CaptchaService.fetchImage(url, sessionAxios)  ← captcha image must use SAME IP
  
  job.log(`[Session] proxySessionId=${proxySessionId}, UA=${sessionUA.substring(0, 30)}...`)
}

TASK 3: API Controller — Manual Sync endpoint with cooldown + block reset

In /backend/src/routes/bot.ts, POST /api/bot/sync-now:

async function triggerManualSync(req: Request, res: Response): Promise<void> {
  const { companyId } = req.body
  const userId = req.user.id

  // Step 1: Cooldown check — prevent queue spam
  const cooldownKey = `bot:manual:cooldown:${companyId}`
  const inCooldown = await redis.get(cooldownKey)
  if (inCooldown) {
    const ttl = await redis.ttl(cooldownKey)
    return res.status(429).json({
      error: 'TOO_MANY_REQUESTS',
      message: `Vui lòng chờ ${ttl} giây trước khi đồng bộ lại`,
      retryAfter: ttl
    })
  }

  // Step 2: Verify company belongs to user
  const company = await db.query(
    'SELECT id, tax_code FROM companies WHERE id=$1 AND id IN (SELECT company_id FROM user_companies WHERE user_id=$2)',
    [companyId, userId]
  )
  if (!company.rows[0]) return res.status(403).json({ error: 'FORBIDDEN' })

  // Step 3: Reset block state (manual sync = user explicitly wants this)
  await db.query(`
    UPDATE gdt_bot_configs
    SET consecutive_failures = 0,
        blocked_until = NULL,
        last_manual_sync = NOW()
    WHERE company_id = $1
  `, [companyId])

  // Step 4: Get encrypted credentials
  const config = await db.query(
    'SELECT encrypted_creds FROM gdt_bot_configs WHERE company_id=$1 AND is_active=true',
    [companyId]
  )
  if (!config.rows[0]) {
    return res.status(404).json({ error: 'BOT_NOT_CONFIGURED', message: 'GDT Bot chưa được thiết lập' })
  }

  // Step 5: Push to manual queue (high priority)
  const job = await manualQueue.add('manual-sync', {
    jobId: uuidv4(),
    encryptedCredentials: config.rows[0].encrypted_creds,
    direction: 'both',
    fromDate: req.body.fromDate,
    toDate:   req.body.toDate,
    tenantId: companyId,
    triggeredBy: 'user_manual'
  }, { priority: 1 })  // priority 1 = highest

  // Step 6: Set cooldown (5 minutes)
  await redis.set(cooldownKey, '1', 'EX', 300)

  res.json({ jobId: job.id, message: 'Đã thêm vào hàng chờ đồng bộ', queueName: 'gdt-sync-manual' })
}

TASK 4: Cronjob — Auto Sync (Slow Path)

Create /bot/src/cron/auto-sync.ts:

import { CronJob } from 'cron'
import { autoQueue } from '../sync.worker'

// Run every 5 minutes — but only push to slow queue
export const autoSyncCron = new CronJob('*/5 * * * *', async () => {
  // Night sleep: 23:00 - 06:00 Vietnam time (UTC+7)
  const vnHour = new Date(Date.now() + 7 * 3600_000).getUTCHours()
  if (vnHour >= 23 || vnHour < 6) {
    console.log('[AutoSync] Night mode — skipping (23:00-06:00 VN time)')
    return
  }

  // Query companies due for auto-sync (use next_auto_sync_at — see BOT-ENT-02)
  const due = await db.query(`
    SELECT c.id as company_id, b.encrypted_creds
    FROM gdt_bot_configs b
    JOIN companies c ON b.company_id = c.id
    WHERE b.is_active = true
      AND (b.next_auto_sync_at IS NULL OR b.next_auto_sync_at <= NOW())
      AND (b.blocked_until IS NULL OR b.blocked_until < NOW())
      AND b.consecutive_failures < 3
    ORDER BY b.next_auto_sync_at ASC NULLS FIRST
    LIMIT 15
  `)

  for (const row of due.rows) {
    await autoQueue.add('auto-sync', {
      jobId: uuidv4(),
      encryptedCredentials: row.encrypted_creds,
      direction: 'both',
      fromDate: null,  // auto-sync: use last sync date as reference
      toDate: null,
      tenantId: row.company_id,
      triggeredBy: 'auto_cron'
    })
    console.log(`[AutoSync] Queued company ${row.company_id}`)
  }
}, null, true)
```

### BOT-ENT-02 — Cron Jitter + Night Sleep (Anti-Pattern Detection)
```
[Respond in Vietnamese]
CONTEXT: Running background jobs at exact 6-hour intervals creates a perfect periodic footprint
that WAFs detect as bot behavior. Solution: randomize next sync time at the database level.

TASK 1: DB migration for jitter column

ALTER TABLE gdt_bot_configs
  ADD COLUMN IF NOT EXISTS next_auto_sync_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill for existing rows
UPDATE gdt_bot_configs SET next_auto_sync_at = NOW() + INTERVAL '1 hour' WHERE next_auto_sync_at IS NULL;

CREATE INDEX idx_bot_configs_next_sync ON gdt_bot_configs(next_auto_sync_at, is_active, blocked_until)
  WHERE is_active = true;

TASK 2: Update next_auto_sync_at after successful sync

In sync.worker.ts, after a successful job completion:

await db.query(`
  UPDATE gdt_bot_configs
  SET
    last_run_at = NOW(),
    last_run_status = 'success',
    consecutive_failures = 0,
    last_error = NULL,
    -- Jitter: random interval between 5 hours and 8 hours (300-480 minutes)
    -- RANDOM() returns 0.0 to 1.0, so RANDOM() * 180 = 0 to 180 extra minutes
    next_auto_sync_at = NOW() + INTERVAL '5 hours' + (RANDOM() * 180 || ' minutes')::INTERVAL
  WHERE company_id = $1
`, [tenantId])

-- The result: next sync is scheduled at a random time between 5h and 8h from now
-- Example outputs: 5h 12m, 6h 47m, 7h 3m — never the same interval twice
-- This makes timing analysis by WAF much harder

TASK 3: Update after FAILED sync (longer jitter to give GDT time to cool down)

await db.query(`
  UPDATE gdt_bot_configs
  SET
    consecutive_failures = consecutive_failures + 1,
    last_error = $2,
    -- Failed: wait longer + more randomness (2-4 hours extra)
    next_auto_sync_at = CASE
      WHEN consecutive_failures >= 2 THEN
        NOW() + INTERVAL '24 hours'  -- too many failures: back off a full day
      ELSE
        NOW() + INTERVAL '2 hours' + (RANDOM() * 120 || ' minutes')::INTERVAL
    END,
    -- Block if too many failures
    blocked_until = CASE
      WHEN consecutive_failures + 1 >= 3 THEN NOW() + INTERVAL '2 hours'
      ELSE blocked_until
    END
  WHERE company_id = $1
`, [tenantId, errorMessage])

TASK 4: Night Sleep logic in cron

In /bot/src/cron/auto-sync.ts, enhance night detection:

function isVietnamNightTime(): boolean {
  // Vietnam is UTC+7
  const vnNow = new Date(Date.now() + 7 * 3600_000)
  const vnHour = vnNow.getUTCHours()
  // Sleep 11 PM to 6 AM Vietnam time
  return vnHour >= 23 || vnHour < 6
}

function getSlowdownFactor(): number {
  const vnNow = new Date(Date.now() + 7 * 3600_000)
  const vnHour = vnNow.getUTCHours()
  // Peak hours (9am-5pm): normal speed
  // Evening (6pm-10pm): slow down
  // Near night (10pm-11pm): very slow
  if (vnHour >= 9 && vnHour < 17)  return 1.0   // normal
  if (vnHour >= 6  && vnHour < 9)  return 0.7   // morning ramp-up
  if (vnHour >= 17 && vnHour < 22) return 0.5   // evening slowdown
  return 0.2  // late evening — minimal activity
}

// In cron: limit jobs based on time of day
const LIMIT_BASE = 15
const limit = Math.floor(LIMIT_BASE * getSlowdownFactor())
// Query: LIMIT $1 → pass limit variable

TASK 5: Add to DB migration: working hours preference per tenant

ALTER TABLE gdt_bot_configs
  ADD COLUMN IF NOT EXISTS preferred_sync_hour_start SMALLINT DEFAULT 8,   -- 8 AM VN time
  ADD COLUMN IF NOT EXISTS preferred_sync_hour_end   SMALLINT DEFAULT 18;  -- 6 PM VN time

-- Tenant-level preferred hours: some businesses want sync outside their working hours
-- Include in cronjob query:
-- AND (preferred_sync_hour_start IS NULL
--      OR EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')) 
--         BETWEEN preferred_sync_hour_start AND preferred_sync_hour_end)
```

### BOT-ENT-03 — Raw Data Lake + Global Circuit Breaker
```
[Respond in Vietnamese]
CONTEXT: Two enterprise patterns to survive GDT system changes:
1. Raw Data Lake: save raw HTML/XML BEFORE parsing so if parser breaks due to GDT changes,
   raw data is safe and can be re-parsed when parser is fixed.
2. Global Circuit Breaker: if GDT structure changes (not credential errors), pause ALL workers
   to prevent hammering GDT with broken requests across all tenants.

TASK 1: Raw Data Lake schema

CREATE TABLE raw_invoice_data (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id),
  invoice_number  VARCHAR(100) NOT NULL,
  serial_number   VARCHAR(50),
  data_type       VARCHAR(10) DEFAULT 'xml',   -- 'xml' | 'html' | 'json'
  raw_content     TEXT NOT NULL,               -- full XML/HTML/JSON string from GDT
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  parsed_at       TIMESTAMPTZ,                 -- set when successfully parsed
  parse_status    VARCHAR(20) DEFAULT 'pending',  -- 'pending' | 'success' | 'failed'
  parse_error     TEXT,
  UNIQUE(company_id, invoice_number)
);

CREATE INDEX idx_raw_invoices_parse_status ON raw_invoice_data(parse_status, company_id);
CREATE INDEX idx_raw_invoices_fetched ON raw_invoice_data(company_id, fetched_at DESC);

TASK 2: Implement in GdtBotRunner.ts — Save-before-Parse pattern

// Custom error for GDT structural changes (not credential errors)
export class GdtStructuralError extends Error {
  constructor(message: string, public readonly selector?: string) {
    super(message)
    this.name = 'GdtStructuralError'
  }
}

// In processInvoice() method:
async processInvoice(
  invoiceNumber: string,
  rawXml: string,
  companyId: string
): Promise<'saved' | 'parsed' | 'failed'> {
  
  // Step 1: ALWAYS save raw data first (before parsing)
  await db.query(`
    INSERT INTO raw_invoice_data (company_id, invoice_number, data_type, raw_content)
    VALUES ($1, $2, 'xml', $3)
    ON CONFLICT (company_id, invoice_number)
    DO UPDATE SET
      raw_content = EXCLUDED.raw_content,
      fetched_at = NOW(),
      parse_status = 'pending'
  `, [companyId, invoiceNumber, rawXml])
  
  // Step 2: Try to parse (if this fails, raw data is still safe)
  try {
    const normalized = GdtXmlParser.parse(rawXml, companyId)
    await bulkUpsertInvoices([normalized])
    
    // Mark as parsed
    await db.query(`
      UPDATE raw_invoice_data
      SET parse_status='success', parsed_at=NOW()
      WHERE company_id=$1 AND invoice_number=$2
    `, [companyId, invoiceNumber])
    
    return 'parsed'
  } catch (parseError: any) {
    // Log warning but DON'T stop the job — data is safe in raw_invoice_data
    logger.warn(`[GdtBot] Parse failed for ${invoiceNumber} — raw data saved for later reparse`, {
      error: parseError.message,
      invoiceNumber,
      companyId
    })
    
    await db.query(`
      UPDATE raw_invoice_data
      SET parse_status='failed', parse_error=$1
      WHERE company_id=$2 AND invoice_number=$3
    `, [parseError.message, companyId, invoiceNumber])
    
    return 'saved'  // data safe, parsing failed
  }
}

// Login failure detection → GdtStructuralError
async login(credentials: any): Promise<GdtSession> {
  const page = await this.browser.newPage()
  await page.goto(GDT_BASE + '/login', { waitUntil: 'networkidle' })
  
  // Check for login form selector
  const loginForm = await page.$('input[name="username"], #username, .login-form input')
  if (!loginForm) {
    throw new GdtStructuralError(
      'Login form selector not found — GDT may have changed page structure',
      'input[name="username"]'
    )
  }
  // ... rest of login logic
}

TASK 3: Global Circuit Breaker in sync.worker.ts

const CIRCUIT_BREAKER_KEY  = 'gdt:circuit_breaker:errors'
const CIRCUIT_BREAKER_TRIP  = 20   // trip after 20 structural errors in 1 hour
const CIRCUIT_BREAKER_TTL   = 3600 // 1 hour window

// In worker's failed event:
async function handleJobFailure(job: Job, error: Error): Promise<void> {
  
  if (error instanceof GdtStructuralError) {
    // Structural error: GDT changed — not the tenant's fault
    // DO NOT increment consecutive_failures for the company
    
    const errorCount = await redis.incr(CIRCUIT_BREAKER_KEY)
    await redis.expire(CIRCUIT_BREAKER_KEY, CIRCUIT_BREAKER_TTL)
    
    logger.error(`[CircuitBreaker] GdtStructuralError count: ${errorCount}/${CIRCUIT_BREAKER_TRIP}`, {
      error: error.message,
      selector: error.selector,
      jobId: job.id
    })
    
    if (errorCount >= CIRCUIT_BREAKER_TRIP) {
      // TRIP: pause all workers
      await manualWorker.pause()
      await autoWorker.pause()
      
      logger.error('[CIRCUIT BREAKER TRIPPED] GDT system structure changed. ALL workers paused.', {
        errorCount,
        threshold: CIRCUIT_BREAKER_TRIP
      })
      
      // Notify admin (push notification + Telegram)
      await sendAdminAlert({
        level: 'CRITICAL',
        title: '🚨 GDT Bot Circuit Breaker Tripped',
        message: `${errorCount} structural errors in 1 hour. All workers paused. GDT may have changed page structure. Manual investigation needed.`,
        data: { errorCount, selector: error.selector, jobId: job.id }
      })
      
      // Set circuit breaker status in Redis for admin UI
      await redis.set('gdt:circuit_breaker:status', JSON.stringify({
        tripped: true,
        trippedAt: new Date().toISOString(),
        errorCount,
        lastError: error.message
      }))
    }
    return  // Do NOT update company consecutive_failures
  }

  // Regular errors (credentials, network, etc.) → update company failure count
  await db.query(`
    UPDATE gdt_bot_configs
    SET consecutive_failures = consecutive_failures + 1,
        last_error = $1,
        last_run_status = 'error'
    WHERE company_id = $2
  `, [error.message, job.data.tenantId])
}

// Admin endpoint to reset circuit breaker:
// POST /admin/bot/circuit-breaker/reset
async function resetCircuitBreaker(req: Request, res: Response): Promise<void> {
  await redis.del(CIRCUIT_BREAKER_KEY)
  await redis.set('gdt:circuit_breaker:status', JSON.stringify({ tripped: false }))
  
  // Resume workers
  await manualWorker.resume()
  await autoWorker.resume()
  
  logger.info('[CircuitBreaker] Manually reset by admin', { adminId: req.user.id })
  res.json({ message: 'Circuit breaker reset — workers resumed' })
}

TASK 4: Re-parse endpoint (for failed parses after parser is fixed)

POST /admin/bot/reparse-failed
  Body: { companyId?: string }  // null = reparse all companies
  
  Logic:
    SELECT id, company_id, invoice_number, raw_content
    FROM raw_invoice_data
    WHERE parse_status = 'failed'
      AND ($1::uuid IS NULL OR company_id = $1)
    LIMIT 1000
  
  For each: run GdtXmlParser.parse() → update invoices table → set parse_status='success'
  Return: { reparsed: N, stillFailed: M }
  
  This allows recovering all data without re-crawling GDT after fixing the parser.
```

### BOT-ENT-04 — Browser Fingerprint Pool + Per-Tenant Proxy
```
[Respond in Vietnamese]
CONTEXT: Two remaining gaps to reach true 1000-user scale:
1. UA alone is insufficient — GDT WAF checks TLS fingerprint, Accept headers, viewport size.
   Need matching browser profile (UA + headers + timing) for each session.
2. Shared proxy pool creates cross-tenant correlation — GDT can link tenants using same IPs.
   Need dedicated IP ranges or proxy affinity per tenant.

TASK 1: Browser Profile Pool (fingerprint consistency)

Create /bot/src/fingerprint-pool.ts:

interface BrowserProfile {
  id: string
  userAgent: string
  acceptLanguage: string
  accept: string
  secChUa: string
  secChUaPlatform: string
  secChUaMobile: string
  viewportWidth: number
  viewportHeight: number
  timezone: string
}

// Real browser profiles — extracted from actual Chrome/Firefox on Windows/Mac
const BROWSER_PROFILES: BrowserProfile[] = [
  {
    id: 'chrome-120-win',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    secChUa: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    viewportWidth: 1920, viewportHeight: 1080,
    timezone: 'Asia/Ho_Chi_Minh'
  },
  {
    id: 'chrome-119-mac',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    acceptLanguage: 'vi-VN,vi;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    secChUa: '"Google Chrome";v="119", "Chromium";v="119", "Not?A_Brand";v="24"',
    secChUaPlatform: '"macOS"',
    secChUaMobile: '?0',
    viewportWidth: 1440, viewportHeight: 900,
    timezone: 'Asia/Ho_Chi_Minh'
  },
  {
    id: 'firefox-121-win',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    acceptLanguage: 'vi-VN,vi;q=0.8,en-US;q=0.5,en;q=0.3',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    secChUa: '',  // Firefox doesn't send sec-ch-ua
    secChUaPlatform: '',
    secChUaMobile: '',
    viewportWidth: 1366, viewportHeight: 768,
    timezone: 'Asia/Ho_Chi_Minh'
  },
  // Add 5-10 more real profiles
]

// Get consistent profile for a given session (deterministic but distributed)
export function getProfileForSession(proxySessionId: string): BrowserProfile {
  // Hash the session ID to consistently pick a profile
  const hash = proxySessionId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  return BROWSER_PROFILES[hash % BROWSER_PROFILES.length]
}

// Get full headers for a session
export function getSessionHeaders(profile: BrowserProfile): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': profile.userAgent,
    'Accept': profile.accept,
    'Accept-Language': profile.acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://hoadondientu.gdt.gov.vn/',
    'Origin': 'https://hoadondientu.gdt.gov.vn',
  }
  // Only add Chrome-specific headers for Chrome profiles
  if (profile.secChUa) {
    headers['sec-ch-ua'] = profile.secChUa
    headers['sec-ch-ua-platform'] = profile.secChUaPlatform
    headers['sec-ch-ua-mobile'] = profile.secChUaMobile
    headers['Sec-Fetch-Dest'] = 'document'
    headers['Sec-Fetch-Mode'] = 'navigate'
    headers['Sec-Fetch-Site'] = 'same-origin'
  }
  return headers
}

-- Update GdtBotRunner to use profiles:
const profile = getProfileForSession(proxySessionId)
const sessionAxios = axios.create({
  headers: getSessionHeaders(profile)
  // proxy config...
})

TASK 2: Per-Tenant Proxy Affinity

Update proxy-manager.ts with tenant-affinity support:

class ProxyManager extends EventEmitter {
  private tenantProxyMap = new Map<string, string>()  // tenantId → assigned proxy URL

  // Get same proxy for same tenant (within session)
  nextForSession(proxySessionId: string): string | null {
    const available = this.proxies.filter(p => !p.failed)
    if (available.length === 0) return null
    
    // Round-robin by session (not random) for even distribution
    const idx = this.hashString(proxySessionId) % available.length
    return available[idx].url
  }

  // Prefer same proxy for same tenant across sessions (if proxy is healthy)
  nextForTenant(tenantId: string): string | null {
    // Check if tenant has an assigned proxy that's still healthy
    const assigned = this.tenantProxyMap.get(tenantId)
    if (assigned) {
      const proxy = this.proxies.find(p => p.url === assigned && !p.failed)
      if (proxy) return proxy.url
    }
    
    // Assign new proxy to tenant
    const available = this.proxies.filter(p => !p.failed)
    if (available.length === 0) return null
    
    const idx = this.hashString(tenantId) % available.length
    const assigned_url = available[idx].url
    this.tenantProxyMap.set(tenantId, assigned_url)
    return assigned_url
  }

  // Clear tenant assignment (after proxy fails or rotation requested)
  clearTenantProxy(tenantId: string): void {
    this.tenantProxyMap.delete(tenantId)
  }

  private hashString(s: string): number {
    return s.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) & 0xFFFFFFFF, 0)
  }
}

-- In sync.worker.ts: use nextForTenant() instead of next()
const proxyUrl = proxyManager.nextForTenant(job.data.tenantId)
```

### BOT-ENT-05 — Dead Letter Queue + Admin Recovery UI
```
[Respond in Vietnamese]
CONTEXT: At 1000 users scale, some jobs will fail permanently (invalid credentials,
blocked accounts, parser errors). Need a Dead Letter Queue to capture these for admin review,
and an admin UI to investigate and retry.

TASK 1: Configure DLQ in BullMQ

// In sync.worker.ts, configure both workers to move failed jobs to DLQ:
const DLQ_NAME = 'gdt-sync-dlq'
const dlqQueue = new Queue(DLQ_NAME, { connection: redis })

// In processGdtSync catch block:
async function handlePermanentFailure(job: Job, error: Error): Promise<void> {
  // Move to DLQ with enriched metadata
  await dlqQueue.add('failed-job', {
    originalJob:  job.data,
    originalQueue: job.queueName,
    failedAt:     new Date().toISOString(),
    errorMessage: error.message,
    errorStack:   error.stack,
    errorType:    error.name,  // 'GdtStructuralError' | 'UnrecoverableError' | 'Error'
    attempts:     job.attemptsMade,
    jobId:        job.id
  })
}

// In BullMQ worker config, after maxAttempts exhausted:
worker.on('failed', async (job, error) => {
  if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
    await handlePermanentFailure(job, error)
  }
  await handleJobFailure(job!, error)
})

TASK 2: DLQ DB table for persistence

CREATE TABLE bot_failed_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id VARCHAR(100),
  company_id      UUID REFERENCES companies(id),
  queue_name      VARCHAR(50),
  job_data        JSONB,
  error_message   TEXT,
  error_type      VARCHAR(50),
  attempts        SMALLINT,
  failed_at       TIMESTAMPTZ DEFAULT NOW(),
  admin_reviewed  BOOLEAN DEFAULT false,
  retry_count     SMALLINT DEFAULT 0,
  resolution      VARCHAR(50),  -- 'retried' | 'dismissed' | 'credential_issue' | 'gdt_change'
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id)  -- admin who reviewed
);

-- Worker: save to DB when moving to DLQ
await db.query(`
  INSERT INTO bot_failed_jobs
    (original_job_id, company_id, queue_name, job_data, error_message, error_type, attempts)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`, [job.id, job.data.tenantId, job.queueName, JSON.stringify(job.data),
    error.message, error.name, job.attemptsMade])

TASK 3: Admin UI for DLQ review

Page: /admin/bot/failed-jobs

Table columns:
  Công ty | Loại lỗi | Thời gian | Số lần thử | Đã xem | Hành động

Error type badges:
  GdtStructuralError: RED "GDT thay đổi cấu trúc"
  UnrecoverableError: ORANGE "Sai thông tin đăng nhập"
  Error (generic):    GRAY "Lỗi thông thường"

Filters: By error type | By company | Unreviewed only | Date range

Per-job actions:
  [Xem chi tiết] → modal with full error + job data
  [Thử lại ngay] → POST /admin/bot/retry-job/:id → push to manual queue
  [Bỏ qua] → mark as dismissed
  [Cập nhật thông tin đăng nhập] → link to /admin/users/:id with GDT config

Bulk actions:
  [Thử lại tất cả loại X] → retry all jobs of same error type
  [Xóa cũ hơn 7 ngày] → cleanup

Summary cards at top:
  Tổng failed: [N] | GDT structural: [N] (circuit breaker indicator) | Sai thông tin: [N] | Khác: [N]

API:
  GET  /admin/bot/failed-jobs?errorType=&reviewed=&page=
  POST /admin/bot/retry-job/:id
  POST /admin/bot/retry-bulk { errorType: string }
  PATCH /admin/bot/failed-jobs/:id/review { resolution: string }
  DELETE /admin/bot/failed-jobs/cleanup { olderThanDays: number }
```

### BOT-ENT-06 — Bot Metrics & Observability Dashboard
```
[Respond in Vietnamese]
CONTEXT: At 1000 users, you need real-time visibility into bot health to detect issues
before they affect many users. Build a metrics pipeline from BullMQ events → Redis counters → Admin dashboard.

TASK 1: Metrics collector in sync.worker.ts

// Track metrics after each job (success or fail)
async function recordMetrics(job: Job, result: 'success' | 'failed', durationMs: number): Promise<void> {
  const now = Date.now()
  const hourKey = `bot:metrics:${new Date().toISOString().slice(0, 13)}`  // hourly bucket

  const pipeline = redis.pipeline()

  // Increment counters in hourly bucket (expire after 7 days)
  pipeline.hincrby(hourKey, 'total', 1)
  pipeline.hincrby(hourKey, result, 1)
  pipeline.hincrby(hourKey, 'invoices_' + result, job.returnvalue?.count || 0)
  pipeline.expire(hourKey, 7 * 24 * 3600)

  // Track queue depth
  pipeline.set('bot:metrics:manual_depth', await manualQueue.getWaitingCount())
  pipeline.set('bot:metrics:auto_depth',   await autoQueue.getWaitingCount())

  // Track circuit breaker
  const cbErrors = await redis.get(CIRCUIT_BREAKER_KEY)
  pipeline.set('bot:metrics:circuit_errors', cbErrors || '0')

  // Track avg duration (rolling)
  pipeline.lpush('bot:metrics:durations', durationMs)
  pipeline.ltrim('bot:metrics:durations', 0, 99)  // keep last 100

  // Captcha metrics (from job data)
  if (job.data.captchaAttempts) {
    pipeline.hincrby(hourKey, 'captcha_attempts', job.data.captchaAttempts)
    pipeline.hincrby(hourKey, 'captcha_fails',    job.data.captchaFails || 0)
  }

  await pipeline.exec()
}

-- Add to both worker 'completed' and 'failed' events:
manualWorker.on('completed', (job) => recordMetrics(job, 'success', job.finishedOn! - job.processedOn!))
manualWorker.on('failed',    (job, err) => recordMetrics(job!, 'failed', Date.now() - (job?.processedOn || Date.now())))

TASK 2: Admin Bot Dashboard page /admin/bot

Header: "Bot GDT — Trạng thái hệ thống" + [Dừng tất cả] [Tiếp tục tất cả] toggle

Row 1 — Status cards (4 cards):
  Manual queue: [N] đang chờ | [M] đang chạy
  Auto queue:   [N] đang chờ | [M] đang chạy
  Circuit Breaker: ✅ Bình thường (0/20) | 🚨 Đã kích hoạt (TRIPPED)
  Failed jobs 24h: [N] (click → /admin/bot/failed-jobs)

Row 2 — Real-time charts (last 24 hours):
  Line chart: Success/Failed jobs per hour (Recharts)
  Line chart: Queue depth over time (manual vs auto)

Row 3 — Performance metrics:
  Avg job duration: [Xms] (from rolling average)
  Success rate 24h: [X%]
  Captcha success rate: [X%]
  Invoices synced today: [N]

Row 4 — Per-company breakdown (top 20 by last activity):
  Company | Status | Last sync | Invoices today | Consecutive failures | Next sync
  Status badges: ✅ OK | ⚠️ Warning | 🔴 Blocked | ⏸ Paused
  [Force sync] [View logs] per row

Row 5 — Circuit Breaker panel:
  Error count: [N]/20 (progress bar, red when >15)
  Last error: [message + timestamp]
  If tripped: [Reset Circuit Breaker] button (prominent red)
  Recent structural errors list (last 10)

API: GET /admin/bot/metrics
  Returns: all metrics from Redis in one call
  Cache: 30 second TTL

Auto-refresh: page polls every 30 seconds (use SWR or polling)
```

