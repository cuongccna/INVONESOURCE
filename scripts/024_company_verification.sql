-- Migration 024: Group 43 — Ghost Company Detection
-- Tables: company_verification_cache, company_risk_flags, verification_queue

-- ─── Cache of GDT/DKKD company lookups ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_verification_cache (
  tax_code          VARCHAR(20)   PRIMARY KEY,
  company_name      VARCHAR(500),
  company_name_en   VARCHAR(500),
  legal_rep         VARCHAR(255),
  address           VARCHAR(1000),
  province_code     VARCHAR(10),
  registered_date   DATE,
  dissolved_date    DATE,
  mst_status        VARCHAR(30)   NOT NULL DEFAULT 'pending',
  business_type     VARCHAR(100),
  industry_code     VARCHAR(20),
  source            VARCHAR(30),
  raw_data          JSONB,
  verified_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  CONSTRAINT valid_status CHECK (
    mst_status IN ('active','suspended','dissolved','not_found','error','pending')
  )
);

CREATE INDEX IF NOT EXISTS idx_company_verify_status  ON company_verification_cache(mst_status);
CREATE INDEX IF NOT EXISTS idx_company_verify_expires ON company_verification_cache(expires_at);

-- ─── Risk flags per company/partner relationship ─────────────────────────────
CREATE TABLE IF NOT EXISTS company_risk_flags (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_code          VARCHAR(20)   NOT NULL,
  partner_type      VARCHAR(10)   NOT NULL CHECK (partner_type IN ('seller','buyer')),
  risk_level        VARCHAR(10)   NOT NULL CHECK (risk_level IN ('critical','high','medium','low')),
  flag_types        TEXT[]        NOT NULL DEFAULT '{}',
  flag_details      JSONB,
  invoice_ids       UUID[],
  total_vat_at_risk NUMERIC(22,2) NOT NULL DEFAULT 0,
  is_acknowledged   BOOLEAN       NOT NULL DEFAULT false,
  acknowledged_by   UUID          REFERENCES users(id),
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_note TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, tax_code)
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_company    ON company_risk_flags(company_id, risk_level);
CREATE INDEX IF NOT EXISTS idx_risk_flags_unacked    ON company_risk_flags(company_id, is_acknowledged)
  WHERE is_acknowledged = false;

-- ─── Queue for pending tax code verifications ─────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_queue (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code    VARCHAR(20)   NOT NULL,
  priority    SMALLINT      NOT NULL DEFAULT 5,
  status      VARCHAR(20)   NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','error')),
  attempts    SMALLINT      NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(tax_code)
);

CREATE INDEX IF NOT EXISTS idx_verification_queue_pending
  ON verification_queue(priority ASC, created_at ASC)
  WHERE status = 'pending';
