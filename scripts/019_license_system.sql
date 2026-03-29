-- ============================================================
-- Migration 019 — Admin License Management System (GROUP 44)
-- Run: psql -U <user> -d invone_db -f scripts/019_license_system.sql
-- ============================================================

-- ── 1. Extend users table with platform-admin flag ──────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- ── 2. License plans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_plans (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(30)  UNIQUE NOT NULL,  -- 'BASIC_1K', 'ENT_100K', etc.
  name              VARCHAR(100) NOT NULL,          -- display name
  tier              VARCHAR(20)  NOT NULL,          -- 'basic' | 'enterprise' | 'free'
  invoice_quota     INT          NOT NULL,          -- max invoices per month (0 = unlimited)
  price_per_month   NUMERIC(12,0) NOT NULL,         -- VND/month
  price_per_invoice NUMERIC(8,0),                   -- VND per invoice (display only)
  max_companies     INT          NOT NULL DEFAULT 5,
  max_users         INT          NOT NULL DEFAULT 3,
  features          JSONB        NOT NULL DEFAULT '{}',
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  sort_order        SMALLINT     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed: implicit free tier (built-in to QuotaService, no row needed) + 8 paid plans
INSERT INTO license_plans
  (code, name, tier, invoice_quota, price_per_month, price_per_invoice, max_companies, max_users, sort_order)
VALUES
  ('BASIC_1K',   'Gói 1.000 HĐ/tháng',   'basic',      1000,   250000,  250, 2,   2,   10),
  ('BASIC_2500', 'Gói 2.500 HĐ/tháng',   'basic',      2500,   500000,  200, 3,   3,   20),
  ('BASIC_5K',   'Gói 5.000 HĐ/tháng',   'basic',      5000,   750000,  150, 5,   5,   30),
  ('BASIC_10K',  'Gói 10.000 HĐ/tháng',  'basic',      10000,  1000000, 100, 10,  10,  40),
  ('ENT_20K',    'Gói 20.000 HĐ/tháng',  'enterprise', 20000,  1600000, 80,  20,  20,  50),
  ('ENT_50K',    'Gói 50.000 HĐ/tháng',  'enterprise', 50000,  3500000, 70,  50,  50,  60),
  ('ENT_80K',    'Gói 80.000 HĐ/tháng',  'enterprise', 80000,  4800000, 60,  100, 100, 70),
  ('ENT_100K',   'Gói 100.000 HĐ/tháng', 'enterprise', 100000, 5000000, 50,  999, 999, 80)
ON CONFLICT (code) DO NOTHING;

-- ── 3. User subscriptions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id           UUID        NOT NULL REFERENCES license_plans(id),
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
    -- 'trial' | 'active' | 'suspended' | 'expired' | 'cancelled'
  CONSTRAINT chk_sub_status CHECK (status IN ('trial','active','suspended','expired','cancelled')),

  -- Billing period
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  trial_ends_at     TIMESTAMPTZ,              -- NULL = not a trial

  -- Quota (reset monthly by cron)
  quota_total       INT         NOT NULL,     -- copied from plan at grant time
  quota_used        INT         NOT NULL DEFAULT 0,
  quota_reset_at    TIMESTAMPTZ,              -- when quota was last reset

  -- Admin management
  granted_by        UUID        REFERENCES users(id),
  grant_notes       TEXT,
  is_manually_set   BOOLEAN     NOT NULL DEFAULT false,

  -- Payment tracking (simple reference only, no gateway)
  last_paid_at      TIMESTAMPTZ,
  payment_reference VARCHAR(100),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id)  -- one active subscription per user
);

-- ── 4. Quota usage log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quota_usage_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id     UUID        REFERENCES companies(id) ON DELETE SET NULL,
  invoices_added INT         NOT NULL,
  source         VARCHAR(30) NOT NULL DEFAULT 'gdt_bot',
    -- 'gdt_bot' | 'manual_import' | 'provider_sync' | 'admin_adjustment' | 'free_tier'
  logged_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 5. License history (audit trail) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action       VARCHAR(30) NOT NULL,
    -- 'grant' | 'renew' | 'upgrade' | 'downgrade' | 'suspend' | 'enable' | 'cancel'
  CONSTRAINT chk_lic_action CHECK (action IN ('grant','renew','upgrade','downgrade','suspend','enable','cancel')),
  old_plan_id  UUID        REFERENCES license_plans(id),
  new_plan_id  UUID        REFERENCES license_plans(id),
  old_status   VARCHAR(20),
  new_status   VARCHAR(20),
  expires_at   TIMESTAMPTZ,
  performed_by UUID        NOT NULL REFERENCES users(id),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 6. Indexes ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subscriptions_user    ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status  ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON user_subscriptions(expires_at);
CREATE INDEX IF NOT EXISTS idx_quota_log_user_month  ON quota_usage_log(user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_license_history_user  ON license_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_platform_admin  ON users(is_platform_admin) WHERE is_platform_admin = true;
