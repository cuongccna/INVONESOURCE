-- Migration 011: Add missing columns and tables from prompts design
-- Safe to run multiple times (IF NOT EXISTS guards)

-- 1. is_paid generated column on invoices (P18.3)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'is_paid'
  ) THEN
    ALTER TABLE invoices
      ADD COLUMN is_paid BOOLEAN GENERATED ALWAYS AS (payment_date IS NOT NULL) STORED;
  END IF;
END$$;

-- 2. organization_members table (FIX-03)
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL DEFAULT 'MEMBER'
                    CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- 3. compound index for aging/cashflow queries
CREATE INDEX IF NOT EXISTS idx_invoices_payment
  ON invoices(company_id, payment_due_date, payment_date)
  WHERE payment_date IS NULL;
