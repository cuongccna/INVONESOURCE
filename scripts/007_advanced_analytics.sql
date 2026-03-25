-- Migration: 007_advanced_analytics.sql
-- Groups 21 (benchmark), 23 (ESG), 24 (repurchase), 25 (audit)

-- ============================================================
-- COMPANY SETTINGS (industry, benchmark opt-in, audit rules)
-- ============================================================

CREATE TABLE IF NOT EXISTS company_settings (
  company_id          UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  industry_code       VARCHAR(20),                          -- VSIC 2018
  industry_name       VARCHAR(255),
  contribute_to_benchmark  BOOLEAN NOT NULL DEFAULT false,
  audit_price_spike_threshold NUMERIC(5,2) DEFAULT 20.0,   -- % above baseline = anomaly
  audit_new_vendor_threshold  NUMERIC(18,2) DEFAULT 50000000, -- VND min for new-vendor alert
  audit_qty_spike_multiplier  NUMERIC(5,2) DEFAULT 2.5,    -- qty > avg * this = anomaly
  audit_round_num_deviation   NUMERIC(5,2) DEFAULT 10.0,   -- % deviation for round-number check
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ESG EMISSION CATEGORIES (reference data)
-- ============================================================

CREATE TABLE IF NOT EXISTS esg_emission_factors (
  category_code   VARCHAR(50) PRIMARY KEY,
  category_name   TEXT NOT NULL,
  kg_co2_per_1000_vnd NUMERIC(10,4) NOT NULL
);

INSERT INTO esg_emission_factors (category_code, category_name, kg_co2_per_1000_vnd)
VALUES
  ('energy_fuel',    'Năng lượng & Nhiên liệu',         0.85),
  ('transport',      'Vận tải & Logistics',              0.62),
  ('manufacturing',  'Nguyên vật liệu sản xuất',         0.45),
  ('services',       'Dịch vụ',                         0.12),
  ('office',         'Văn phòng phẩm',                  0.18),
  ('other',          'Khác',                            0.30)
ON CONFLICT DO NOTHING;

-- ESG calculations cache per company per year
CREATE TABLE IF NOT EXISTS esg_estimates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  calc_year       SMALLINT NOT NULL,
  total_tco2e     NUMERIC(12,4),
  by_category     JSONB,     -- [{category_code, category_name, spend, tco2e, pct}]
  calculated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, calc_year)
);

CREATE INDEX IF NOT EXISTS idx_esg_estimates_company ON esg_estimates(company_id);

-- Vendor category assignments (from Gemini or manual)
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS esg_category VARCHAR(50) REFERENCES esg_emission_factors(category_code);

-- ============================================================
-- SEASONAL INSIGHTS CACHE
-- ============================================================

CREATE TABLE IF NOT EXISTS insights_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  insight_type    VARCHAR(50) NOT NULL,  -- 'seasonal', 'esg', 'benchmark'
  period_key      VARCHAR(20),           -- e.g. '2025' or '2025-03'
  data            JSONB NOT NULL,
  ai_analysis     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  UNIQUE (company_id, insight_type, period_key)
);

CREATE INDEX IF NOT EXISTS idx_insights_cache_company ON insights_cache(company_id, insight_type);

-- ============================================================
-- REPURCHASE PREDICTIONS (Group 24)
-- ============================================================

CREATE TABLE IF NOT EXISTS repurchase_predictions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_tax_code        VARCHAR(20) NOT NULL,
  buyer_name            TEXT,
  normalized_item_name  TEXT NOT NULL,
  display_item_name     TEXT,
  avg_interval_days     NUMERIC(8,2),
  avg_quantity          NUMERIC(18,4),
  last_purchase_date    DATE,
  predicted_next_date   DATE,
  days_until_predicted  INTEGER,
  confidence            VARCHAR(10) NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  data_points           SMALLINT DEFAULT 0,
  is_actioned           BOOLEAN DEFAULT false,
  action_note           TEXT,
  alert_sent_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, buyer_tax_code, normalized_item_name)
);

CREATE INDEX IF NOT EXISTS idx_repurchase_days   ON repurchase_predictions(company_id, days_until_predicted);
CREATE INDEX IF NOT EXISTS idx_repurchase_buyer  ON repurchase_predictions(company_id, buyer_tax_code);
CREATE INDEX IF NOT EXISTS idx_repurchase_alert  ON repurchase_predictions(company_id, confidence, days_until_predicted)
  WHERE is_actioned = false;

-- ============================================================
-- PRICE ANOMALIES (Group 25)
-- ============================================================

CREATE TABLE IF NOT EXISTS price_anomalies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id       UUID REFERENCES invoices(id) ON DELETE SET NULL,
  line_item_id     UUID REFERENCES invoice_line_items(id) ON DELETE SET NULL,
  anomaly_type     VARCHAR(30) NOT NULL,   -- price_spike|price_drop|cross_vendor|round_number|new_vendor|qty_spike|freq_spike
  severity         VARCHAR(10) NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
  seller_tax_code  VARCHAR(20),
  seller_name      TEXT,
  item_name        TEXT,
  unit_price       NUMERIC(18,2),
  baseline_price   NUMERIC(18,2),
  pct_deviation    NUMERIC(8,2),
  ai_explanation   TEXT,
  ai_action        TEXT,
  is_acknowledged  BOOLEAN DEFAULT false,
  acknowledged_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomalies_company   ON price_anomalies(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_severity  ON price_anomalies(company_id, severity) WHERE is_acknowledged = false;
CREATE INDEX IF NOT EXISTS idx_anomalies_invoice   ON price_anomalies(invoice_id);

-- ============================================================
-- AUDIT RULE CONFIGS (Group 25.4)
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_rule_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_id         VARCHAR(50) NOT NULL,   -- 'price_spike'|'round_number'|'new_vendor'|'qty_spike'|'freq_spike'|'cross_vendor'
  threshold       NUMERIC(10,4),
  severity        VARCHAR(10) DEFAULT 'warning',
  enabled         BOOLEAN DEFAULT true,
  exclusions      JSONB DEFAULT '[]',     -- list of seller_tax_code or item_names to ignore
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_audit_rules_company ON audit_rule_configs(company_id);

-- Add normalized_item_name to invoice_line_items for G24/G25 lookups
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS normalized_item_name TEXT;

CREATE INDEX IF NOT EXISTS idx_line_items_norm_name ON invoice_line_items(company_id, normalized_item_name);
