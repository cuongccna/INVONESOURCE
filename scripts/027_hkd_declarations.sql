-- Migration 027: hkd_declarations
-- Bảng tờ khai thuế theo quý cho Hộ Kinh Doanh / Cá Nhân Kinh Doanh (TT40/2021)
-- Lưu doanh thu và thuế theo từng tháng trong quý (ct28/ct29/ct30 trong XML TT40)

CREATE TABLE IF NOT EXISTS hkd_declarations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_quarter  SMALLINT NOT NULL CHECK (period_quarter BETWEEN 1 AND 4),
  period_year     SMALLINT NOT NULL CHECK (period_year >= 2020),

  -- Doanh thu chịu thuế GTGT theo từng tháng trong quý (ct28/ct29/ct30 trong XML)
  revenue_m1      NUMERIC(18,0) NOT NULL DEFAULT 0,   -- tháng 1 của quý
  revenue_m2      NUMERIC(18,0) NOT NULL DEFAULT 0,   -- tháng 2 của quý
  revenue_m3      NUMERIC(18,0) NOT NULL DEFAULT 0,   -- tháng 3 của quý
  revenue_exempt  NUMERIC(18,0) NOT NULL DEFAULT 0,   -- doanh thu không chịu thuế (ct31)
  revenue_total   NUMERIC(18,0) NOT NULL DEFAULT 0,   -- ct32 = m1+m2+m3

  -- Thuế GTGT khoán (tỷ lệ từ vat_rate_hkd của công ty, mặc định 1%)
  vat_rate        NUMERIC(5,2)  NOT NULL DEFAULT 1.0,
  vat_m1          NUMERIC(18,0) NOT NULL DEFAULT 0,
  vat_m2          NUMERIC(18,0) NOT NULL DEFAULT 0,
  vat_m3          NUMERIC(18,0) NOT NULL DEFAULT 0,
  vat_total       NUMERIC(18,0) NOT NULL DEFAULT 0,

  -- Thuế TNCN (0.5% doanh thu)
  pit_m1          NUMERIC(18,0) NOT NULL DEFAULT 0,
  pit_m2          NUMERIC(18,0) NOT NULL DEFAULT 0,
  pit_m3          NUMERIC(18,0) NOT NULL DEFAULT 0,
  pit_total       NUMERIC(18,0) NOT NULL DEFAULT 0,

  total_payable   NUMERIC(18,0) NOT NULL DEFAULT 0,   -- vat_total + pit_total

  xml_content      TEXT,
  xml_generated_at TIMESTAMPTZ,

  submission_status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (submission_status IN ('draft','ready','submitted','accepted','rejected')),
  notes            TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (company_id, period_quarter, period_year)
);

CREATE INDEX IF NOT EXISTS idx_hkd_declarations_company_period
  ON hkd_declarations (company_id, period_year, period_quarter);
