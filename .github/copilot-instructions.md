# Copilot Instructions — HDDDT Unified Platform

## Project
Vietnamese e-invoice aggregation platform. Sync invoices from MISA / Viettel / BKAV, VAT reconciliation, realtime financial dashboard.
Type: Web App + PWA (mobile push notifications via VAPID).

## Stack — Hard Constraints
Backend: Node.js + TypeScript + Express.js
Frontend: Next.js 14 App Router + TypeScript + Tailwind CSS
DB: PostgreSQL LOCAL (no Docker, no cloud DB)
Cache: Redis LOCAL + BullMQ (job queue)
AI: Google Gemini 1.5 Flash only
Auth: JWT + HTTP-only cookie refresh token
Push: web-push npm (VAPID)

NEVER suggest: Docker, MongoDB/MySQL, OpenAI/Claude API, Firebase/Supabase, TypeORM, cloud DB.

---

## Company Hierarchy — Critical Architecture

3-level hierarchy via self-reference. One companies table, unlimited depth.

  organizations  (holding group entity)
    companies level=1  parent_id=NULL        Tong cong ty / Doc lap
      companies level=2  parent_id=L1.id     Cong ty con
        companies level=3  parent_id=L2.id   Chi nhanh

3 view modes:
- portfolio  /portfolio          ALL user companies, aggregate KPIs, no single-company filter
- group      /group/[orgId]      All entities in org, consolidated merged numbers
- single     /dashboard          One activeCompanyId only (existing behavior)

Inter-company exclusion (group view): invoices where BOTH seller_tax_code AND buyer_tax_code
belong to companies with same organization_id -> EXCLUDE from consolidated revenue.

ViewContext (React + localStorage):
  type ViewMode = 'portfolio' | 'group' | 'single'
  ViewContext: { mode, orgId?, companyId? }
All data-fetching hooks must check ViewContext before API calls.

Performance: portfolio/group aggregations MUST use single SQL with GROUP BY — never N+1 per company.

---

## Plugin Connector Architecture

Every provider = isolated plugin. One crash must NEVER affect others.

ConnectorPlugin interface:
  id: string  ('misa' | 'viettel' | 'bkav' | 'gdt_intermediary')
  isEnabled(): boolean
  authenticate(creds): Promise<void>
  pullOutputInvoices(params): Promise<RawInvoice[]>
  pullInputInvoices(params): Promise<RawInvoice[]>
  healthCheck(): Promise<boolean>

Circuit Breaker: 3 fails -> OPEN -> 60s -> HALF_OPEN -> retry.
Sync worker: wrap each plugin in isolated try/catch, never rethrow.
Add provider: new file + registry.register(). Zero core changes.
Remove provider: registry.unregister() or enabled=false in DB.

---

## Connector API Reference

MISA meInvoice:
- Base: https://api.meinvoice.vn | Auth: Bearer + header CompanyTaxCode
- Token TTL ~1h, auto-refresh 5min before expiry
- Output: GET /api/invoice/list?fromDate&toDate&page&size=50
- Input: GET /api/purchaseinvoice/list (PAID add-on — confirm with client)
- Skip DuplicateInvoiceRefID silently. No webhook, poll every 15min.

Viettel SInvoice:
- Base: https://sinvoice.viettel.vn:8443/InvoiceAPI | Auth: HTTP Basic
- IP Whitelist required — register static server IP with Viettel before go-live
- DATETIME = MILLISECONDS: toMs(d) => d.getTime() — NEVER ISO string
- Timeout: 90000ms. transactionUuid: UUID v4 per request.
- Output list: POST /InvoiceUtilsWS/getListInvoiceDataControl
- Demo: demo-sinvoice.viettel.vn:8443 / 0100109106-215 / 111111a@A

BKAV eInvoice:
- Base: https://api.bkav.com.vn/einvoice | Auth: headers PartnerGUID + PartnerToken
- Output: GET /api/invoices?from&to&page | Input: GET /api/purchase-invoices?from&to&page
- GDT validation built-in — set gdt_validated=true by default.

GDT Intermediary:
- Auth: OAuth2 client_credentials (base URL TBD after partner negotiation)
- Env: GDT_INTERMEDIARY_BASE_URL (if empty -> isEnabled()=false, skip gracefully)
- Covers ALL providers in one call. 24-48h data latency.

GDT Validation:
- https://hoadondientu.gdt.gov.vn — validate only, no bulk pull
- Rate: 1 req/2s via BullMQ rate-limited queue

---

## Domain Rules (Vietnam Tax Law)

VAT payable = SUM(vat, output, valid) - SUM(deductible input vat)
Deductible  = input + valid + gdt_validated + (total<=20M OR non-cash payment)
Carry-fwd   = if payable<0, move to [24] next period
Deadline    : 20th of following month
VAT rates   : 0% | 5% | 8% | 10%
Tax code    : /^\d{10}(-\d{3})?$/

Form 01/GTGT key line items:
  [25] = [23]+[24]  (total deductible)
  [40a] = total output VAT
  [41]  = MAX(0, [40a]-[25])  must pay to state
  [43]  = MAX(0, [25]-[40a])  carry to next period [24]

XML format: HTKK standard TT80/2021 — only format GDT accepts
Submission: Tier1=manual upload | Tier2=T-VAN API | Tier3=GDT intermediary

---

## Code Standards
- TypeScript strict, no `any`, use `unknown`
- No SQL string interpolation — parameterized queries only
- Credentials: AES-256-GCM encrypt before DB insert, decrypt on use
- UUID v4 PKs, TIMESTAMPTZ DEFAULT NOW()
- Response format: { success: boolean, data?: T, error?: { code, message } }
- Pagination: { data: T[], meta: { total, page, pageSize, totalPages } }
- Never log credentials, tokens, or raw invoice PII
- RBAC: OWNER > ADMIN > ACCOUNTANT > VIEWER — enforce in middleware
- Portfolio/group: single SQL aggregation, never N+1 loops

---

## Directory Map

backend/src/connectors/
  types.ts  ConnectorRegistry.ts
  MisaConnector.ts  ViettelConnector.ts  BkavConnector.ts  GdtIntermediaryConnector.ts
backend/src/services/
  VatReconciliationService.ts   TaxDeclarationEngine.ts  HtkkXmlGenerator.ts
  PortfolioService.ts           aggregate queries, single SQL, no N+1
  ConsolidatedGroupService.ts   group view, inter-company exclusion
backend/src/jobs/               BullMQ workers
frontend/app/
  portfolio/           all-company overview (new)
  group/[orgId]/       consolidated group view (new)
  compare/             side-by-side company comparison (new)
  dashboard/           single company (existing)
  declarations/        tax declaration flow
shared/types/          ViewContext + shared TS interfaces
scripts/               001_init.sql ... 006_hierarchy.sql
PRD.md  prompts.md

---

## Pre-Accept Checklist
[ ] No Docker / cloud DB / OpenAI?
[ ] Plugin error isolated, not propagated to other plugins?
[ ] Viettel datetime in milliseconds (not ISO)?
[ ] Credentials AES-encrypted before DB write?
[ ] New provider = one new file only, no core changes?
[ ] Portfolio/group query uses single SQL aggregation?
[ ] ViewContext checked before API calls?
[ ] Inter-company invoices excluded from consolidated view?
[ ] Tax calc follows exact 01/GTGT formula from PRD Section 7?


# Timezone Convention

- **Vietnam timezone**: UTC+7 / `Asia/Ho_Chi_Minh`
- **DB stores**: All timestamps as `TIMESTAMPTZ` in **UTC** (PostgreSQL standard)
- **Display**: Always use `timeZone: 'Asia/Ho_Chi_Minh'` in `toLocaleString` — never rely on browser default
- **datetime-local input**: HTML `datetime-local` gives/expects LOCAL time strings (no timezone suffix).
  - Reading UTC from DB → input: use `toLocalDatetimeInput(utcIso)` helper (converts via Date object using local offset)
  - Writing input → DB: `new Date(localString).toISOString()` correctly converts local→UTC if the helper was used correctly
- **Backend**: Never add +7 offset manually to DB inserts — PostgreSQL TIMESTAMPTZ handles UTC storage/retrieval correctly
- **Bot/worker**: Use `new Date().toISOString()` for timestamps → stored as UTC, displayed as UTC+7 on frontend

