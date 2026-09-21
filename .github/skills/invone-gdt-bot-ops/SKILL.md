---
name: invone-gdt-bot-ops
description: Use this skill for INVONE GDT bot operations involving bot bootstrap, auto-sync scheduling, sync phase 1, detail phase 2, proxy/captcha/session/cache behavior, or GDT direct API flows. Also use for reviewing sync/detail workers and bot runtime paths. Do not use for pure frontend, backend API, database schema, migration, or unrelated business-logic changes unless they directly affect GDT bot operations.
---

# INVONE GDT Bot Ops

Use this skill when working on the GDT bot runtime. Keep changes scoped to bot operations, and read shared context first when the task depends on product or architecture history: [invone-memory.md](../_shared/references/invone-memory.md).

When the task touches direct-IP behavior, auth error classification, circuit breaker rules, or proxy/captcha safety, also use [gdt-bot-safety](../gdt-bot-safety/SKILL.md).

## Workflow

1. Read the current bot path before editing:
   - `bot/src/index.ts`
   - `bot/src/cron/auto-sync.ts`
   - `bot/src/sync.worker.ts`
   - `bot/src/detail.worker.ts`
   - `bot/src/gdt-direct-api.service.ts`
   - `bot/src/proxy-manager.ts`
   - `bot/src/captcha.service.ts`
   - `bot/src/crawl-cache/*`
2. Identify whether the change belongs to the current sync + detail pipeline or the legacy `crawl.worker` path. Prefer the current phase 1/phase 2 flow unless the user explicitly asks about legacy crawl behavior.
3. Trace scheduler, queue, lock, session, proxy, captcha, and cache behavior end to end before changing retry or error-handling logic.
4. Keep live GDT calls behind explicit user intent; diagnostics against GDT should not run as incidental validation.

## Invariants

- Production must not crawl GDT directly without an approved proxy path.
- `GdtAuthError` for non-captcha HTTP 400/401 is unrecoverable: stop retrying, classify as auth failure, and preserve deactivation/notification behavior.
- Phase 1 sync upserts summary invoices and enqueues detail jobs; it must not perform detail crawling inline.
- Phase 2 consumes the detail queue and owns invoice-detail fetch/update behavior.
- Cache key shape and TTL semantics are part of the contract; preserve existing `crawl-cache` namespacing and expiry behavior.
- Proxy assignment TTL controls reuse/rotation; do not shorten, bypass, or extend it without checking worker retry consequences.

## Checks

Run checks appropriate to the touched surface:

```bash
npm --prefix bot run build
```

Run backend tests when backend API, scheduler contracts, or cross-process queue behavior are touched. Run live GDT diagnostics only when the user explicitly requires them.
