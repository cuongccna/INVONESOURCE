-- Migration 012 — Groups 36-41: Auto-code, Inventory, Cash Book, Journals, P&L, HKD

-- ─── Group 36: Auto-code catalogs ──────────────────────────────────────────

-- Per-company sequence tracker (idempotent code assignment)
CREATE TABLE IF NOT EXISTS code_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  seq_type VARCHAR(30) NOT NULL,   -- 'product' | 'customer' | 'supplier'
  prefix VARCHAR(30) NOT NULL,     -- e.g. 'HH-VPPM' | 'KH-HCM' | 'NCC-HNO'
  current_val INT NOT NULL DEFAULT 0,
  UNIQUE(company_id, seq_type, prefix)
);

-- Extend product_catalog
ALTER TABLE product_catalog
  ADD COLUMN IF NOT EXISTS item_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS category_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS category_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_service BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS unit VARCHAR(50),
  ADD COLUMN IF NOT EXISTS avg_purchase_price NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS avg_sale_price NUMERIC(18,2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_catalog_item_code
  ON product_catalog(company_id, item_code) WHERE item_code IS NOT NULL;

-- Customer catalog
CREATE TABLE IF NOT EXISTS customer_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  customer_code VARCHAR(20),
  tax_code VARCHAR(20),
  name VARCHAR(255),
  address TEXT,
  phone VARCHAR(20),
  province_code VARCHAR(10),
  total_revenue_12m NUMERIC(18,2) DEFAULT 0,
  invoice_count_12m INT DEFAULT 0,
  last_invoice_date DATE,
  rfm_segment VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, tax_code)
);
CREATE INDEX IF NOT EXISTS idx_customer_catalog_company ON customer_catalog(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_catalog_code ON customer_catalog(company_id, customer_code);

-- Supplier catalog
CREATE TABLE IF NOT EXISTS supplier_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  supplier_code VARCHAR(20),
  tax_code VARCHAR(20),
  name VARCHAR(255),
  total_spend_12m NUMERIC(18,2) DEFAULT 0,
  invoice_count_12m INT DEFAULT 0,
  last_invoice_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, tax_code)
);
CREATE INDEX IF NOT EXISTS idx_supplier_catalog_company ON supplier_catalog(company_id);

-- ─── Group 37: Inventory movements ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  line_item_id UUID REFERENCES invoice_line_items(id) ON DELETE SET NULL,
  movement_type VARCHAR(20) NOT NULL,   -- 'IN' | 'OUT' | 'opening_balance' | 'manual_adjust'
  item_code VARCHAR(20),
  item_name TEXT,
  normalized_item_name TEXT,
  unit VARCHAR(50),
  quantity NUMERIC(18,4) DEFAULT 0,
  unit_cost NUMERIC(18,2),
  unit_price NUMERIC(18,2),
  total_value NUMERIC(18,2),
  movement_date DATE NOT NULL,
  partner_name VARCHAR(255),
  partner_tax_code VARCHAR(20),
  source VARCHAR(20) DEFAULT 'invoice',  -- 'invoice' | 'manual_adjust' | 'opening_balance'
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_mov_company_date ON inventory_movements(company_id, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_mov_item ON inventory_movements(company_id, normalized_item_name);
CREATE INDEX IF NOT EXISTS idx_inv_mov_invoice ON inventory_movements(invoice_id);

-- ─── Group 38: Cash book ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cash_book_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  entry_type VARCHAR(15) NOT NULL,     -- 'receipt' | 'payment' | 'transfer' | 'opening'
  entry_date DATE NOT NULL,
  amount NUMERIC(18,2) NOT NULL,
  description TEXT,
  partner_name VARCHAR(255),
  partner_tax_code VARCHAR(20),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  reference_number VARCHAR(50),
  category VARCHAR(60),               -- 'bán hàng'|'mua hàng'|'lương'|'thuê'|'khác'
  payment_method VARCHAR(20) DEFAULT 'cash',  -- 'cash' | 'bank_transfer' | 'check'
  bank_account VARCHAR(80),
  is_auto_generated BOOLEAN DEFAULT false,
  running_balance NUMERIC(18,2),      -- recalculated after each change
  is_deleted BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_book_company_date ON cash_book_entries(company_id, entry_date DESC) WHERE is_deleted=false;
CREATE INDEX IF NOT EXISTS idx_cash_book_invoice ON cash_book_entries(invoice_id) WHERE invoice_id IS NOT NULL;

-- ─── Group 40: P&L statements ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS profit_loss_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  period_month SMALLINT NOT NULL,
  period_year SMALLINT NOT NULL,
  -- B02-DN line items
  line_01 NUMERIC(22,2) DEFAULT 0,   -- Doanh thu BH và CCDV
  line_02 NUMERIC(22,2) DEFAULT 0,   -- Các khoản giảm trừ DT
  line_10 NUMERIC(22,2) DEFAULT 0,   -- Doanh thu thuần (01-02)
  line_11 NUMERIC(22,2) DEFAULT 0,   -- Giá vốn hàng bán
  line_20 NUMERIC(22,2) DEFAULT 0,   -- Lợi nhuận gộp (10-11)
  line_21 NUMERIC(22,2) DEFAULT 0,   -- DT hoạt động tài chính
  line_22 NUMERIC(22,2) DEFAULT 0,   -- Chi phí tài chính
  line_25 NUMERIC(22,2) DEFAULT 0,   -- Chi phí bán hàng
  line_26 NUMERIC(22,2) DEFAULT 0,   -- Chi phí QLDN
  line_30 NUMERIC(22,2) DEFAULT 0,   -- LN thuần từ HĐKD (20+21-22-25-26)
  line_31 NUMERIC(22,2) DEFAULT 0,   -- Thu nhập khác
  line_32 NUMERIC(22,2) DEFAULT 0,   -- Chi phí khác
  line_40 NUMERIC(22,2) DEFAULT 0,   -- Lợi nhuận khác (31-32)
  line_50 NUMERIC(22,2) DEFAULT 0,   -- Tổng LN trước thuế (30+40)
  line_51 NUMERIC(22,2) DEFAULT 0,   -- Chi phí thuế TNDN
  line_60 NUMERIC(22,2) DEFAULT 0,   -- LN sau thuế (50-51)
  has_estimates BOOLEAN DEFAULT false,
  estimate_notes TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_month, period_year)
);

-- ─── Group 41: HKD business types ───────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'business_type_enum') THEN
    CREATE TYPE business_type_enum AS ENUM ('DN','HKD','HND','CA_NHAN');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tax_regime_enum') THEN
    CREATE TYPE tax_regime_enum AS ENUM ('khoan','thuc_te','khau_tru');
  END IF;
END $$;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS business_type business_type_enum DEFAULT 'DN',
  ADD COLUMN IF NOT EXISTS tax_regime tax_regime_enum DEFAULT 'khau_tru',
  ADD COLUMN IF NOT EXISTS vat_rate_hkd NUMERIC(4,2) DEFAULT 1.0;

-- HKD tax statements (Mẫu 04/GTGT)
CREATE TABLE IF NOT EXISTS hkd_tax_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  period_month SMALLINT NOT NULL,
  period_year SMALLINT NOT NULL,
  revenue NUMERIC(22,2) DEFAULT 0,
  vat_rate NUMERIC(4,2) NOT NULL,
  vat_payable NUMERIC(22,2) DEFAULT 0,
  pit_rate NUMERIC(4,2) DEFAULT 0.5,
  pit_payable NUMERIC(22,2) DEFAULT 0,
  total_payable NUMERIC(22,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',  -- draft | ready | submitted
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, period_month, period_year)
);
