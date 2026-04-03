-- Migration 025: Group 50 — Pain Point Solver Columns + Tables
-- Adds: payment_method risk columns, amended invoice columns, missing_invoice_alerts, vat_rate_rules

-- ─── P50.1: Cash payment risk on invoices ────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_method         VARCHAR(30)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS payment_method_source  VARCHAR(20)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_cash_payment_risk   BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_risk_acknowledged BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_risk_note         TEXT;
-- payment_method: 'cash'|'bank_transfer'|'cheque'|'card'|'mixed'|NULL
-- payment_method_source: 'user_input'|'inferred'|'gdt_data'

CREATE INDEX IF NOT EXISTS idx_invoices_cash_risk
  ON invoices(company_id, invoice_date DESC)
  WHERE direction = 'input' AND is_cash_payment_risk = true AND deleted_at IS NULL;

-- ─── P50.2: Amended invoice routing ──────────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_relation_type           VARCHAR(20)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS related_invoice_id              UUID         REFERENCES invoices(id),
  ADD COLUMN IF NOT EXISTS related_invoice_number          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS related_invoice_period          VARCHAR(7),
  ADD COLUMN IF NOT EXISTS cross_period_flag               BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS supplemental_declaration_needed BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS routing_decision                VARCHAR(30)  DEFAULT NULL;
-- invoice_relation_type: 'original'|'replacement'|'adjustment'|NULL
-- routing_decision: 'same_period'|'cross_period_replacement'|'cross_period_adjustment'|'user_confirmed'

CREATE INDEX IF NOT EXISTS idx_invoices_cross_period
  ON invoices(company_id)
  WHERE cross_period_flag = true AND routing_decision IS NULL AND deleted_at IS NULL;

-- ─── P50.4: Missing invoice alerts ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS missing_invoice_alerts (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seller_tax_code          VARCHAR(20)  NOT NULL,
  seller_name              VARCHAR(255),
  expected_invoice_number  VARCHAR(50),
  expected_invoice_date    DATE,
  expected_amount          NUMERIC(22,2),
  expected_vat             NUMERIC(22,2),
  detection_source         VARCHAR(30)  NOT NULL DEFAULT 'cross_company',
  -- 'cross_company'|'gdt_mismatch'|'seller_reported'
  status                   VARCHAR(20)  NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','found','not_applicable','acknowledged')),
  found_invoice_id         UUID         REFERENCES invoices(id),
  acknowledged_note        TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, seller_tax_code, expected_invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_missing_inv_company
  ON missing_invoice_alerts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_missing_inv_open
  ON missing_invoice_alerts(company_id)
  WHERE status = 'open';

-- ─── P50.5: VAT rate rules (NQ204/2025/QH15 etc.) ────────────────────────────
CREATE TABLE IF NOT EXISTS vat_rate_rules (
  id             UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name      VARCHAR(100)   NOT NULL,
  decree_ref     VARCHAR(100),
  effective_from DATE           NOT NULL,
  effective_to   DATE,
  standard_rate  NUMERIC(4,1)   NOT NULL DEFAULT 10,
  reduced_rate   NUMERIC(4,1),
  applies_to     TEXT[]         DEFAULT '{}',
  excluded_from  TEXT[]         DEFAULT '{}',
  is_active      BOOLEAN        NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Seed: NQ204/2025/QH15 — giảm 2% VAT từ 01/07/2025 đến 31/12/2026
INSERT INTO vat_rate_rules (rule_name, decree_ref, effective_from, effective_to,
  standard_rate, reduced_rate, excluded_from)
VALUES (
  'Giảm 2% VAT 2025-2026',
  'NQ204/2025/QH15 + NĐ174/2025/NĐ-CP',
  '2025-07-01', '2026-12-31',
  10, 8,
  ARRAY[
    'viễn thông', 'công nghệ thông tin', 'tài chính', 'ngân hàng', 'chứng khoán',
    'bảo hiểm', 'bất động sản', 'kim loại', 'khai khoáng', 'than cốc',
    'dầu mỏ tinh chế', 'hóa chất', 'thuốc lá', 'bia', 'rượu', 'ô tô'
  ]
)
ON CONFLICT DO NOTHING;

-- ─── P50.5: Tax rate anomaly tracking ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_rate_anomalies (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month    SMALLINT    NOT NULL,
  period_year     SMALLINT    NOT NULL,
  item_name       VARCHAR(500),
  anomaly_type    VARCHAR(50) NOT NULL,
  -- 'INCONSISTENT_RATE'|'POSSIBLE_WRONG_RATE_10_SHOULD_BE_8'|'POSSIBLE_WRONG_RATE_8_SHOULD_BE_10'
  severity        VARCHAR(10) NOT NULL DEFAULT 'warning',
  vat_rates       NUMERIC(4,1)[],
  invoice_count   INTEGER,
  total_vat       NUMERIC(22,2),
  potential_diff  NUMERIC(22,2),
  message         TEXT,
  suggestion      TEXT,
  ai_classification VARCHAR(50),
  is_acknowledged BOOLEAN     NOT NULL DEFAULT false,
  acknowledged_by UUID        REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_rate_anomalies_company
  ON tax_rate_anomalies(company_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_tax_rate_anomalies_unacked
  ON tax_rate_anomalies(company_id, is_acknowledged)
  WHERE is_acknowledged = false;
