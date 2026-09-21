---
name: invone-db-domain-migration
description: "INVONE Postgres database domain migration guidance. USE FOR: schema changes, migrations, invoice/declaration semantics, queue tables, indexes/enums/FKs, migration ordering, schema_migrations, CREATE INDEX CONCURRENTLY handling, and migration dry-runs. DO NOT USE FOR: frontend UI work, backend route/API changes without schema impact, or pure bot worker logic."
---

# INVONE DB Domain Migration

Use this skill for Postgres schema and migration work. Load shared project context when needed: [INVONE memory](../_shared/references/invone-memory.md).

## Workflow

1. Read the related `scripts/*.sql` migrations first, then `backend/src/db/migrate.ts`, `shared/index.ts`, and the relevant DB helpers such as pool/query helpers before proposing or editing a migration.
2. Identify existing tables, indexes, enums, constraints, foreign keys, cascade behavior, and upsert keys before writing SQL.
3. Keep the migration narrowly scoped to schema/data-shape changes. Do not touch business code unless the user explicitly asks.
4. Prefer additive, reversible-safe changes when possible. For destructive changes, call out data risk and require an explicit decision.

## Migration Rules

- Migrations run from `scripts/*.sql` in lexicographic order and are tracked in `schema_migrations`.
- Check whether the next filename sorts after all existing applied migrations.
- `CREATE INDEX CONCURRENTLY` cannot run inside a normal transaction; follow the handling in `backend/src/db/migrate.ts`.
- Run migration dry-runs only against a disposable database. Do not run against a real/shared DB unless the user explicitly asks.

## Domain Checks

- Tenancy tables and scoping: `users`, `companies`, `user_companies`, `organizations`, `organization_members`.
- Invoice core: `invoices`, `invoice_line_items`, `invoice_detail_queue`, `gdt_raw_cache`.
- Declaration domain: VAT `tax_declarations`, HKD `hkd_declarations`, PIT `pit_declarations`, and related reconciliation/report tables.
- Bot/cache/run tables: `gdt_bot_configs`, `gdt_bot_runs`, `gdt_sync_queue_log`, `raw_invoice_data`, `bot_failed_jobs`.
- Be careful with invoice upsert identity: canonical keys may differ from older migrations; verify before adding unique constraints or ON CONFLICT targets.
- Check FK/cascade effects on tenant, invoice, line item, queue, cache, and declaration rows before changing constraints.

## Checks

- Static SQL/schema review: ordering, idempotency, locks, nullable/default behavior, indexes, enum usage, FKs, and data backfill safety.
- Disposable DB dry-run: apply migrations from scratch and/or from the expected previous version.
- Schema sanity queries: inspect columns, indexes, constraints, enums, and FK relationships after the dry-run.
- Do not run real database migrations or touch production-like data without explicit user approval.
