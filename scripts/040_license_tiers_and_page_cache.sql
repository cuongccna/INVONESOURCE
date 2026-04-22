-- BOT-LICENSE-01 (part A): Create license_tiers table for DB-driven rate limiting.
-- Separate from existing license_plans table — this table drives rate limiting
-- and feature gates; license_plans drives billing/pricing UI.

CREATE TABLE IF NOT EXISTS license_tiers (
  plan_id          TEXT PRIMARY KEY,           -- matches user_subscriptions.plan field
  sync_per_hour    INT  NOT NULL DEFAULT 3,    -- max manual syncs per hour
  burst_max        INT  NOT NULL DEFAULT 3,    -- burst token allowance (initial tokens)
  max_companies    INT  NOT NULL DEFAULT 1,    -- 0 = unlimited
  can_export_xml   BOOLEAN NOT NULL DEFAULT false,
  can_use_ai_audit BOOLEAN NOT NULL DEFAULT false,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default tiers (ON CONFLICT DO NOTHING = idempotent)
INSERT INTO license_tiers (plan_id, sync_per_hour, burst_max, max_companies, can_export_xml, can_use_ai_audit, description)
VALUES
  ('free',       3,  3,  1,  false, false, 'Gói miễn phí — 100 HĐ/tháng, 1 MST'),
  ('starter',    5,  5,  3,  false, false, 'Gói Starter — 500 HĐ/tháng, 3 MST'),
  ('pro',        10, 5,  10, true,  false, 'Gói Pro — 2000 HĐ/tháng, 10 MST, xuất XML'),
  ('enterprise', 30, 10, 0,  true,  true,  'Gói Enterprise — không giới hạn, AI audit')
ON CONFLICT (plan_id) DO NOTHING;

-- BOT-CACHE-02 (part B): Extend gdt_raw_cache with page-level cache columns.
-- Existing rows have NULL for new columns — backward compatible.
-- The existing UNIQUE constraint (mst, invoice_type, ma_hoa_don) is for invoice-level rows.
-- New page-level rows use the new partial unique index below.

ALTER TABLE gdt_raw_cache
  ADD COLUMN IF NOT EXISTS company_id   UUID DEFAULT NULL,   -- UUID công ty (page-level cache)
  ADD COLUMN IF NOT EXISTS endpoint     TEXT DEFAULT NULL,   -- API endpoint: '/query/invoices/sold'
  ADD COLUMN IF NOT EXISTS page         INT  DEFAULT NULL,   -- 0-indexed page number
  ADD COLUMN IF NOT EXISTS period       TEXT DEFAULT NULL;   -- 'YYYY-MM' of fetch window

-- Partial unique index for page-level cache rows (only when all 4 columns are non-null)
CREATE UNIQUE INDEX IF NOT EXISTS uq_gdt_page_cache
  ON gdt_raw_cache (company_id, endpoint, page, period)
  WHERE company_id IS NOT NULL AND endpoint IS NOT NULL AND page IS NOT NULL AND period IS NOT NULL;

-- Index for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_gdt_raw_cache_company_period
  ON gdt_raw_cache (company_id, period)
  WHERE company_id IS NOT NULL;
