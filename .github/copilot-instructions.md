# Copilot Instructions — HDDDT Unified Platform

## Project
Vietnamese e-invoice aggregation platform. Sync invoices from MISA / Viettel / BKAV, VAT reconciliation, realtime financial dashboard.
Type: Web App + PWA (mobile push notifications via VAPID).

## Stack — Hard Constraints
Backend: Node.js + TypeScript + Express.js (port 3001)
Frontend: Next.js 15 App Router + TypeScript + Tailwind CSS (port 3000)
DB: PostgreSQL LOCAL (no Docker, no cloud DB)
Cache: Redis LOCAL + BullMQ (job queue)
AI: Google Gemini (model set via GEMINI_MODEL env, default gemini-2.0-flash)
Auth: JWT + HTTP-only cookie refresh token
Push: web-push npm (VAPID)

NEVER suggest: Docker, MongoDB/MySQL, OpenAI/Claude API, Firebase/Supabase, TypeORM, cloud DB.

---

## Dev Commands

```bash
# From repo root
npm run dev:all           # backend + frontend concurrently
npm run db:migrate        # run SQL migrations (backend workspace)
npm run type-check        # TypeScript check both services

# Per service
cd backend && npm run dev        # Express on :3001 (ts-node-dev)
cd backend && npm test           # Jest (70% coverage threshold)
cd backend && npm run test:coverage

cd frontend && npm run dev       # Next.js on :3000
cd frontend && npm test          # Vitest (node env)

cd bot && npm run dev            # BullMQ workers + cron
```

**Environment files:** `backend/.env`, `frontend/.env.local`, `bot/.env`
See [CLAUDE.md](../CLAUDE.md#chạy-local) for required env vars per service.

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
  id: string  ('GDT')
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
- Response format: `{ success: boolean, data?: T, error?: { code, message } }`
- Pagination: `{ data: T[], meta: { total, page, pageSize, totalPages } }`
- Never log credentials, tokens, or raw invoice PII
- RBAC: OWNER > ADMIN > ACCOUNTANT > VIEWER — enforce in middleware
- Portfolio/group: single SQL aggregation, never N+1 loops

### Error Classes (`backend/src/utils/AppError.ts`)
```
AppError (base, extends Error)
  AuthError        → 401
  ValidationError  → 400  (use with Zod safeParse failures)
  NotFoundError    → 404
  ForbiddenError   → 403
  ConnectorError   → 502  (wraps plugin failures)
```
Throw these from routes/services; global handler in `backend/src/middleware/errorHandler.ts` formats them correctly.

### Frontend API Pattern
- Access token: in-memory only (`getAccessToken()` / `setAccessToken()` in `frontend/lib/apiClient.ts`)
- Company context sent as `X-Company-Id` header (single mode) or `X-Organization-Id` (group mode)
- All hooks must read `useView()` before building API URL (`portfolio` → `/portfolio/*`, `group` → `/group/:orgId/*`, `single` → default)
- 401 auto-refresh handled by Axios interceptor — never handle 401 manually in components

---

## Directory Map

```
backend/src/
  connectors/        Plugin registry + MISA/Viettel/BKAV/GDT connectors
  services/          TaxDeclarationEngine, HtkkXmlGenerator, VatReconciliationService
                     PortfolioService (single-SQL aggregation)
                     ConsolidatedGroupService (inter-company exclusion)
  routes/            42 Express route modules
  jobs/              BullMQ workers (GDT validation, cache sync, reminders)
  middleware/        authenticate, requireCompany, requireRole, errorHandler
  utils/             AppError hierarchy, sendPaginated helper
  config/env.ts      Zod-validated env schema (start here for env vars)

frontend/app/(app)/
  dashboard/         single company view
  portfolio/         all-company aggregates
  group/[id]/        consolidated org view
  declarations/      01/GTGT and TT40 forms
  invoices/          invoice list, detail, amended
  reports/           9+ accounting report types
  settings/connectors  provider credential config

bot/src/
  index.ts           entry point, worker spawn + heartbeat
  sync.worker.ts     main BullMQ sync processor
  crawl.worker.ts    Playwright-based GDT portal crawler
  detail.worker.ts   invoice detail + line items fetcher
  gdt-direct-api.service.ts  HTTP client for GDT API (~1900 lines)
  proxy-manager.ts   static proxy pool + per-company IP affinity
  circuit-breaker.ts fail-fast, 3 fails → OPEN
  cron/auto-sync.ts  5-min scheduler

scripts/             SQL migrations (NNN_description.sql, 51+ files)
shared/types/        ViewContext + shared TS interfaces
```

---

## GDT API Quirks (bot/gdt-direct-api.service.ts)

These non-obvious bugs WILL cause silent data loss if ignored:

| Issue | Workaround |
|-------|------------|
| FIQL filter values must NOT be URL-encoded | Custom `paramsSerializer`: encode keys only, keep values raw |
| GDT resets TCP socket after login | Force fresh socket before next request |
| SCO/POS receipts reset `shdon` daily | Chunk by **day** (not month) for SCO invoices |
| Pagination wraps after ~200 items | Use weekly chunks for large SCO datasets |
| `X-Total-Count` equals `pageSize` (GDT bug) | Ignore total count when `≤ pageSize`; stop only on empty page |
| `page` param must be explicit number | Pass `page: page` (number), not string template |

For bot/worker work, always load the [gdt-bot-safety skill](.github/skills/gdt-bot-safety/SKILL.md) first.

---

## Database Migrations

**Pattern:** `scripts/NNN_description.sql` — sequential, lowercase, snake_case
**Run:** `cd backend && npm run db:migrate`
**Next number:** Check highest existing file in `scripts/` and increment by 1
**Style:** Idempotent where possible (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`)

See [.github/instructions/database-migrations.instructions.md](.github/instructions/database-migrations.instructions.md) for conventions.

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
[ ] Bot GDT requests go through proxy (never direct IP)?
[ ] New error thrown as AppError subclass (not generic Error)?


# Timezone Convention

- **Vietnam timezone**: UTC+7 / `Asia/Ho_Chi_Minh`
- **DB stores**: All timestamps as `TIMESTAMPTZ` in **UTC** (PostgreSQL standard)
- **Display**: Always use `timeZone: 'Asia/Ho_Chi_Minh'` in `toLocaleString` — never rely on browser default
- **datetime-local input**: HTML `datetime-local` gives/expects LOCAL time strings (no timezone suffix).
  - Reading UTC from DB → input: use `toLocalDatetimeInput(utcIso)` helper (converts via Date object using local offset)
  - Writing input → DB: `new Date(localString).toISOString()` correctly converts local→UTC if the helper was used correctly
- **Backend**: Never add +7 offset manually to DB inserts — PostgreSQL TIMESTAMPTZ handles UTC storage/retrieval correctly
- **Bot/worker**: Use `new Date().toISOString()` for timestamps → stored as UTC, displayed as UTC+7 on frontend

