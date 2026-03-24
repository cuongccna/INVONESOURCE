-- Migration: 002_tax_declarations.sql
-- HĐĐT Unified Platform - Tax Declaration Tables
-- Created: 2026-03-23

-- ============================================================
-- TAX_DECLARATIONS (Tờ khai 01/GTGT)
-- ============================================================

CREATE TABLE tax_declarations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month SMALLINT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year SMALLINT NOT NULL CHECK (period_year >= 2020),
  form_type VARCHAR(20) DEFAULT '01/GTGT',
  declaration_method declaration_method DEFAULT 'deduction',
  filing_frequency filing_frequency DEFAULT 'monthly',

  -- Các chỉ tiêu tờ khai 01/GTGT (TT80/2021) - lưu theo đơn vị VNĐ, làm tròn
  ct22_total_input_vat NUMERIC(18,0) DEFAULT 0,      -- [22] Tổng thuế GTGT đầu vào
  ct23_deductible_input_vat NUMERIC(18,0) DEFAULT 0, -- [23] Thuế GTGT đầu vào đủ điều kiện
  ct24_carried_over_vat NUMERIC(18,0) DEFAULT 0,     -- [24] Thuế kỳ trước chuyển sang
  ct25_total_deductible NUMERIC(18,0) DEFAULT 0,     -- [25] = [23] + [24]
  ct29_total_revenue NUMERIC(18,0) DEFAULT 0,        -- [29] Tổng doanh thu
  ct30_exempt_revenue NUMERIC(18,0) DEFAULT 0,       -- [30] Không chịu thuế
  ct32_revenue_5pct NUMERIC(18,0) DEFAULT 0,         -- [32] Doanh thu 5%
  ct33_vat_5pct NUMERIC(18,0) DEFAULT 0,             -- [33] Thuế 5%
  ct34_revenue_8pct NUMERIC(18,0) DEFAULT 0,         -- [34] Doanh thu 8%
  ct35_vat_8pct NUMERIC(18,0) DEFAULT 0,             -- [35] Thuế 8%
  ct36_revenue_10pct NUMERIC(18,0) DEFAULT 0,        -- [36] Doanh thu 10%
  ct37_vat_10pct NUMERIC(18,0) DEFAULT 0,            -- [37] Thuế 10%
  ct40_total_output_revenue NUMERIC(18,0) DEFAULT 0, -- [40] Tổng doanh thu đầu ra
  ct40a_total_output_vat NUMERIC(18,0) DEFAULT 0,    -- [40a] Tổng VAT đầu ra
  ct41_payable_vat NUMERIC(18,0) DEFAULT 0,          -- [41] VAT phải nộp (nếu >0)
  ct43_carry_forward_vat NUMERIC(18,0) DEFAULT 0,    -- [43] VAT khấu trừ kỳ sau (nếu <0)

  -- Metadata
  xml_content TEXT,                                   -- XML HTKK đã generate
  xml_generated_at TIMESTAMPTZ,
  submission_method submission_method DEFAULT 'manual',
  submission_status submission_status DEFAULT 'draft',
  submission_at TIMESTAMPTZ,
  tvan_transaction_id VARCHAR(100),
  gdt_reference_number VARCHAR(50),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_month, period_year, form_type)
);

CREATE INDEX idx_tax_declarations_company ON tax_declarations(company_id);
CREATE INDEX idx_tax_declarations_period ON tax_declarations(company_id, period_year, period_month);
CREATE INDEX idx_tax_declarations_status ON tax_declarations(submission_status);

-- ============================================================
-- DECLARATION_ATTACHMENTS
-- ============================================================

CREATE TABLE declaration_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id UUID NOT NULL REFERENCES tax_declarations(id) ON DELETE CASCADE,
  attachment_type attachment_type NOT NULL,
  file_name VARCHAR(255),
  file_path VARCHAR(500) NOT NULL,
  file_size BIGINT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_declaration_attachments_decl ON declaration_attachments(declaration_id);

-- ============================================================
-- GDT_VALIDATION_QUEUE (tracking GDT validation status)
-- ============================================================

CREATE TABLE gdt_validation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'pending',    -- pending | processing | done | failed | skipped
  attempts INT DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(invoice_id)
);

CREATE INDEX idx_gdt_queue_status ON gdt_validation_queue(status);
CREATE INDEX idx_gdt_queue_invoice ON gdt_validation_queue(invoice_id);

-- ============================================================
-- Trigger: update updated_at automatically
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_company_connectors_updated_at BEFORE UPDATE ON company_connectors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_invoices_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tax_declarations_updated_at BEFORE UPDATE ON tax_declarations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
