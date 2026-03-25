-- Migration: 006_crm.sql
-- CRM tables: customer_rfm, customer_notes, aging/payment fields on invoices

-- RFM customer segments
CREATE TABLE IF NOT EXISTS customer_rfm (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  buyer_tax_code    VARCHAR(20) NOT NULL,
  buyer_name        TEXT,
  r_score           SMALLINT    NOT NULL CHECK (r_score BETWEEN 1 AND 5),
  f_score           SMALLINT    NOT NULL CHECK (f_score BETWEEN 1 AND 5),
  m_score           SMALLINT    NOT NULL CHECK (m_score BETWEEN 1 AND 5),
  rfm_score         SMALLINT    NOT NULL,
  segment           VARCHAR(30) NOT NULL,
  last_invoice_date DATE,
  invoice_count_12m INTEGER     DEFAULT 0,
  total_amount_12m  NUMERIC(18,2) DEFAULT 0,
  calculated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, buyer_tax_code)
);

CREATE INDEX IF NOT EXISTS idx_crm_rfm_company   ON customer_rfm(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_rfm_segment   ON customer_rfm(company_id, segment);
CREATE INDEX IF NOT EXISTS idx_crm_rfm_amount    ON customer_rfm(company_id, total_amount_12m DESC);

-- Payment tracking on invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_due_date    DATE,
  ADD COLUMN IF NOT EXISTS payment_date        DATE,
  ADD COLUMN IF NOT EXISTS payment_terms_days  SMALLINT DEFAULT 30;

CREATE INDEX IF NOT EXISTS idx_invoices_payment_due ON invoices(company_id, payment_due_date)
  WHERE payment_date IS NULL;

-- Dismissed anomalies
CREATE TABLE IF NOT EXISTS dismissed_anomalies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id  UUID,
  reason      TEXT,
  dismissed_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Price alerts (used by Group 19)
CREATE TABLE IF NOT EXISTS price_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seller_tax_code  VARCHAR(20) NOT NULL,
  seller_name      TEXT,
  item_name        TEXT NOT NULL,
  prev_price       NUMERIC(18,2),
  curr_price       NUMERIC(18,2),
  change_pct       NUMERIC(8,2),
  period_month     SMALLINT NOT NULL,
  period_year      SMALLINT NOT NULL,
  is_acknowledged  BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_company ON price_alerts(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_alerts_acked   ON price_alerts(company_id, is_acknowledged);

-- Invoice line items (used by Groups 19 + 20)
CREATE TABLE IF NOT EXISTS invoice_line_items (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   UUID         NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id   UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  line_number  SMALLINT,
  item_code    VARCHAR(100),
  item_name    TEXT,
  unit         VARCHAR(50),
  quantity     NUMERIC(18,4),
  unit_price   NUMERIC(18,2),
  subtotal     NUMERIC(18,2),
  vat_rate     NUMERIC(5,2),
  vat_amount   NUMERIC(18,2),
  total        NUMERIC(18,2),
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_line_items_company_item ON invoice_line_items(company_id, item_name);

-- Product catalog (Group 20)
CREATE TABLE IF NOT EXISTS product_catalog (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  normalized_name  VARCHAR(255) NOT NULL,
  display_name     VARCHAR(255),
  category         VARCHAR(100),
  is_input         BOOLEAN DEFAULT false,
  is_output        BOOLEAN DEFAULT false,
  first_seen       DATE,
  last_seen        DATE,
  avg_purchase_price NUMERIC(18,2),
  avg_sale_price     NUMERIC(18,2),
  gross_margin_pct   NUMERIC(5,2),
  UNIQUE (company_id, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_product_catalog_company ON product_catalog(company_id);

-- Telegram notification config (Group 18 P18.4)
CREATE TABLE IF NOT EXISTS telegram_chat_configs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  chat_id            VARCHAR(100) NOT NULL,
  chat_type          VARCHAR(20)  NOT NULL DEFAULT 'private' CHECK (chat_type IN ('private','group')),
  subscribed_events  JSONB        NOT NULL DEFAULT '[]',
  is_active          BOOLEAN      NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (company_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_configs_company ON telegram_chat_configs(company_id);
