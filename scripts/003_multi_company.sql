-- Migration: 003_multi_company.sql
-- HĐĐT Unified Platform - Multi-company support
-- Created: 2026-03-23

-- ============================================================
-- Add company_type enum + extra columns to companies
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'company_type') THEN
    CREATE TYPE company_type AS ENUM ('private', 'jsc', 'partnership', 'household', 'other');
  END IF;
END$$;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS company_type  company_type  DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS fiscal_year_start SMALLINT DEFAULT 1
    CHECK (fiscal_year_start BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS onboarded    BOOLEAN       DEFAULT true,  -- existing companies are already onboarded
  ADD COLUMN IF NOT EXISTS deleted_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_companies_deleted ON companies(deleted_at) WHERE deleted_at IS NULL;

-- Mark all currently-existing companies as onboarded
UPDATE companies SET onboarded = true WHERE onboarded IS NULL;

-- ============================================================
-- COMPANY_MEMBERS (richer view — same data as user_companies)
-- No structure change needed; user_companies already holds role.
-- ============================================================
