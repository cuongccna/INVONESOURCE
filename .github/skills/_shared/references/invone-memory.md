# INVONE Shared Memory

Use this reference for repeated INVONE constants, conventions, and safety rules. Keep skill bodies short and link here when a task needs repo-wide context.

## App Context

- Frontend API calls should use `frontend/lib/apiClient.ts`; raw `axios` is reserved for auth refresh/bootstrap cases.
- Access tokens stay in memory only. Refresh tokens are HTTP-only cookies.
- Multi-company headers:
  - `Authorization: Bearer <token>`
  - `X-View-Mode: single | group | portfolio`
  - `X-Company-Id: <uuid>` for single-company and legacy endpoints
  - `X-Organization-Id: <uuid>` for group mode
- View modes come from `shared/index.ts`: `portfolio`, `group`, `single`.
- Company type drives UX: `household` uses HKD dashboard/reports/declarations; other companies use enterprise VAT flows.
- Local storage keys used by frontend state: `activeCompanyId`, `viewContext`, `syncState`.
- API responses usually follow `{ success, data, meta?, message?, error? }`; pagination uses `meta.total`, `meta.page`, `meta.pageSize`, `meta.totalPages`.

## Roles, Periods, And Statuses

- Roles: `OWNER`, `ADMIN`, `ACCOUNTANT`, `VIEWER`.
- Platform admin must be checked through backend admin middleware/DB, not JWT-only assumptions.
- VAT monthly periods use `period_month` and `period_year`.
- HKD/PIT quarterly periods use `period_quarter` and `period_year`.
- API period params commonly use `{ month, year }`, `{ quarter, year }`, or `periodType=monthly|quarterly|yearly`.
- Invoice directions: `input`, `output`; some reporting flows accept `both`.
- Invoice statuses in use: `valid`, `cancelled`, `replaced`, `replaced_original`, `adjusted`, `adjusted_original`, `invalid`.
- VAT categories: `KCT`, `KKKNT`, `0`, `5`, `8`, `10`.
- Declaration money values should be rounded VND integers for HTKK/XML output.

## Invoice And Tax Domain

- Invoice groups:
  - `5`: co ma CQT / serial usually starts with `C`; group 5 input VAT needs `gdt_validated=true`.
  - `6`: khong ma CQT / typical `K` serial.
  - `8`: may tinh tien / SCO / MTTTT; `K` serial with M in the expected position.
- `tc_hdon = 1` means replacement; the original invoice becomes `replaced_original`.
- `tc_hdon = 2` means adjustment; the original invoice becomes `adjusted_original`.
- Soft-deleted invoices must stay filtered with `deleted_at IS NULL` unless the task explicitly targets trash/restore.
- Reconciliation and tax declaration logic must preserve manual declaration fields when recalculating.
- HKD companies should be routed through `/api/hkd` and HKD pages, not the normal `/api/declarations/calculate` VAT flow.

## Backend API Conventions

- Standard business route middleware order: `authenticate`, then `requireCompany`, then route-level role checks.
- Validation routes mounted under declarations intentionally rely on existing request context; do not blindly re-add auth/company middleware there.
- Static Express routes must be declared before dynamic `/:id` routes.
- Use parameterized SQL; do not interpolate user-controlled values into SQL strings.
- Import accepts `.xlsx`, `.xls`, `.xml`, `.csv`, `.zip` with memory upload limits around 50MB.
- GDT sync date-range endpoints generally enforce a maximum 31-day window.

## GDT Bot Operations

- Main bot process starts in `bot/src/index.ts`: init `ConfigStore`, wait for proxy readiness, then import sync workers and start auto-sync.
- Auto-sync lives in `bot/src/cron/auto-sync.ts`; workers live mainly in `bot/src/sync.worker.ts`.
- Detail fetching is phase 2 and runs from `bot/src/detail.worker.ts` as a separate poll-loop process.
- `crawl.worker.ts` is a legacy/alternate smart-crawl path; prefer `sync.worker.ts` plus `detail.worker.ts` for current bot flow unless the task is explicitly about that file.
- Never crawl GDT directly in production. Requests to `hoadondientu.gdt.gov.vn` must use a proxy unless `ALLOW_DIRECT_CONNECTION=true` is explicitly intended for a controlled environment.
- `GdtAuthError` for HTTP `400/401` non-captcha credential/account failures is unrecoverable and should deactivate/notify, not retry.
- Captcha failures can retry/report bad captcha; network, TLS, proxy, `429`, and `5xx` failures should use backoff/rotation/circuit-breaker behavior.

## GDT API And Cache Facts

- GDT base API: `https://hoadondientu.gdt.gov.vn/api`.
- Proxy CONNECT path may use `http://hoadondientu.gdt.gov.vn:443/api`.
- Important endpoints:
  - `/captcha`
  - `/security-taxpayer/authenticate`
  - `/query/invoices/sold`
  - `/query/invoices/purchase`
  - `/query/invoices/detail`
  - `/sco-query/invoices/*`
- List defaults: `page=0`, `size=50`, `sort=tdlap:desc`, total from `X-Total-Count`.
- Detail params commonly include `nbmst`, `khhdon`, `shdon`, `khmshdon`, and `is_sco` routing.
- Cache/key conventions:
  - `gdt:session:{companyId}:{proxySessionId}`
  - `gdt:proxy_assignment:{companyId}`
  - `gdt:detail:{nbmst}:{khhdon}:{shdon}`
  - `gdt:dedup:{company}:{yyyymm}:{direction}`
  - `gdt_raw_cache` for page/raw response caching

## Database And Migration Memory

- Migration runner sorts `scripts/*.sql` lexicographically and records versions in `schema_migrations`.
- It handles `CREATE INDEX CONCURRENTLY` specially; migration dry-runs should use a disposable DB.
- Core tenancy: `users`, `companies`, `user_companies`, `organizations`, `organization_members`.
- Core invoice tables: `invoices`, `invoice_line_items`, `invoice_detail_queue`, `gdt_raw_cache`.
- Declaration/report tables: `tax_declarations`, `vat_reconciliations`, `hkd_declarations`, `pit_declarations`, `profit_loss_statements`.
- Bot tables: `gdt_bot_configs`, `gdt_bot_runs`, `gdt_sync_queue_log`, `raw_invoice_data`, `bot_failed_jobs`.
- Current invoice upsert identity should be treated as company/provider/invoice number/seller tax code/serial, with `invoice_date` no longer part of the canonical upsert key after `025_fix_invoice_date.sql`.
- `invoice_detail_queue` state machine: `pending -> processing -> done | failed | skipped`; priority `1` manual, `5` auto, `10` backfill.
- Backend DB uses `backend/src/db/pool.ts`; bot DB uses `WORKER_DB_URL ?? DATABASE_URL`.

## Verification Defaults

- Frontend: `npm run type-check --workspace=frontend`, `npm test --workspace=frontend`, and targeted Vitest for company-switch behavior when relevant.
- Backend: `npm run type-check --workspace=backend`, `npm test --workspace=backend`.
- Bot: `npm --prefix bot run build`; live GDT diagnostics only when the task explicitly requires credentials/network.
- Full repo typecheck: `npm run type-check`.
