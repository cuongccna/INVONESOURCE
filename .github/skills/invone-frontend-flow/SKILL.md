---
name: invone-frontend-flow
description: Use this skill for INVONE frontend work involving the app shell, authentication flow, company/view context, dashboard pages, invoices UI, sync UI, settings/bot UI, navigation, or admin UI. Do not use for backend-only, bot-only, database schema, migration, or API contract work unless frontend behavior is also being changed.
---

# INVONE Frontend Flow

Use this skill when editing INVONE React/frontend behavior. Keep changes scoped, preserve existing UX patterns, and read shared memory first when broader context matters: [invone-memory.md](../_shared/references/invone-memory.md).

## Quick Workflow

1. Read the relevant shell and data-flow files before editing:
   - `frontend/components/ClientLayout.tsx`
   - `frontend/lib/apiClient.ts`
   - relevant contexts, navigation, and page/component files
2. Trace auth, company, and view context through providers before changing state flow.
3. Keep provider order intact unless the task explicitly requires changing it.
4. Use `apiClient` for frontend API calls; do not bypass shared header/auth/company handling.
5. When touching company switch, view mode, dashboards, invoices, sync, settings/bot, or admin UI, verify request headers still include the correct company/view context.
6. Follow existing layout, loading, empty, error, and permission-state patterns in nearby components.

## Main Source Areas

- App shell: `frontend/components/ClientLayout.tsx`
- API client and headers: `frontend/lib/apiClient.ts`
- Contexts: `frontend/contexts/**`
- Header/navigation: `frontend/components/Header.tsx`, `frontend/components/BottomNav.tsx`, `frontend/lib/navSections.ts`
- Dashboard: `frontend/app/(app)/dashboard/page.tsx`
- Invoices: `frontend/app/(app)/invoices/page.tsx`
- Sync UI: search existing sync pages/components before editing
- Settings/bot UI: `frontend/app/(app)/settings/**` and `frontend/components/SyncProgressPanel.tsx`
- Admin UI/layout: `frontend/app/admin/**`

## Checks

Run targeted checks appropriate to the change:

```bash
npm run type-check --workspace=frontend
npm test --workspace=frontend
npx vitest run __tests__/apiClient.company-switch.test.ts
```

Use the targeted Vitest command when touching company switching, company headers, or related `apiClient` behavior.
