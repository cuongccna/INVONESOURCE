---
name: invone-backend-api-flow
description: "Backend API flow for INVONE Express routes. USE FOR: Express routes, auth/session, company middleware, invoices, declarations, import, audit, reports, route mounting, middleware order, response shape, parameterized SQL. DO NOT USE FOR: pure frontend UI work, pure bot worker tasks, pure schema migrations."
---

# INVONE Backend API Flow

Use this skill when changing or reviewing backend API behavior. Load shared project context only when needed: [INVONE memory](../_shared/references/invone-memory.md).

## Workflow

1. Find the mounted API path in `backend/src/index.ts` before changing a route file. Confirm whether the effective path is `/api/...`, `/auth/...`, or another mounted prefix.
2. Preserve middleware order: `authenticate` -> `requireCompany` -> role/permission checks -> handler. Do not let company-scoped data routes bypass `requireCompany`.
3. Keep static routes before parameter routes, e.g. `/calculate`, `/summary`, `/export` before `/:id`, so Express does not capture static paths as IDs.
4. Match the local response shape already used by the route. Prefer consistent `{ success, data, error }` or existing route-specific shapes over inventing a new envelope.
5. Use parameterized SQL for every user/company/request value. Build dynamic filters by pushing params and referencing `$${params.length}`; never interpolate request values into SQL.
6. When touching invoice tax eligibility, check the tax validation pipeline as well as the route/service using its output.

## Tax Routing Rules

- HKD must not flow through `/api/declarations/calculate`; route HKD work through `/api/hkd`.
- PIT declaration work belongs under `/api/pit-declarations`.
- VAT declaration work remains in declarations/TaxDeclarationEngine paths unless the existing mount says otherwise.

## Main Files

- `backend/src/index.ts` - route mount paths and global middleware.
- `backend/src/routes/auth.ts` - auth/session endpoints.
- `backend/src/middleware/company.ts` - company context and `requireCompany`.
- `backend/src/routes/invoices.ts` - invoice API, filters, invoice SQL.
- `backend/src/routes/declarations.ts` - VAT declaration endpoints.
- `backend/src/routes/import.ts` - import sessions and ingestion endpoints.
- `backend/src/routes/audit.ts` - audit/event API.
- `backend/src/routes/reports.ts` - report endpoints.
- `backend/src/services/TaxDeclarationEngine.ts` - VAT declaration calculation.
- `backend/src/tax/validation/invoice-validation.pipeline.ts` and plugins - invoice tax validation pipeline.

## Checks

- Backend-only API changes: `npm run type-check --workspace=backend`
- Backend behavior changes: `npm test --workspace=backend`
- If the API contract touches frontend/shared types or client calls: run full `npm run type-check`
