-- Migration 018: Simplify company_type enum to 3 values
-- household | enterprise | branch
-- Old values (private, jsc, partnership, other) are migrated to 'enterprise'.
-- PostgreSQL does not support removing ENUM values; old labels remain dormant.

BEGIN;

-- 1. Add new enum values (idempotent via ALTER TYPE ... ADD VALUE IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'company_type' AND e.enumlabel = 'enterprise') THEN
    ALTER TYPE company_type ADD VALUE 'enterprise';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                 WHERE t.typname = 'company_type' AND e.enumlabel = 'branch') THEN
    ALTER TYPE company_type ADD VALUE 'branch';
  END IF;
END$$;

COMMIT;

-- ALTER TYPE ADD VALUE must be outside a transaction block in older PG versions,
-- so we commit above then continue with data migration.

BEGIN;

-- 2. Migrate old values → enterprise
UPDATE companies
SET company_type = 'enterprise'
WHERE company_type IN ('private', 'jsc', 'partnership', 'other');

-- 3. Update column default
ALTER TABLE companies ALTER COLUMN company_type SET DEFAULT 'enterprise';

COMMIT;
