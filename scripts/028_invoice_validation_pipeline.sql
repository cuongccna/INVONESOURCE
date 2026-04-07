-- Migration 028: Invoice Validation Pipeline
-- Adds new columns to invoices table, creates vendor_risk_scores,
-- validation_plugin_configs, and invoice_validation_log tables.
-- Run ONCE against the production database.

BEGIN;

-- ============================================================
-- 1. New columns on invoices — GDT XML fields for replacement tracking
-- ============================================================
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS mccqt               VARCHAR(50),
  ADD COLUMN IF NOT EXISTS tc_hdon             SMALLINT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lhd_cl_quan         SMALLINT,
  ADD COLUMN IF NOT EXISTS khhd_cl_quan        VARCHAR(50),
  ADD COLUMN IF NOT EXISTS so_hd_cl_quan       VARCHAR(50);

COMMENT ON COLUMN invoices.mccqt          IS 'Mã xác thực của Cơ quan Thuế (CQT) — bắt buộc với HĐ có mã';
COMMENT ON COLUMN invoices.tc_hdon        IS '0=hóa đơn thường, 1=hóa đơn thay thế (thay thế bản gốc)';
COMMENT ON COLUMN invoices.lhd_cl_quan   IS 'Loại HĐ bị thay thế — từ XML GDT';
COMMENT ON COLUMN invoices.khhd_cl_quan  IS 'Ký hiệu HĐ bị thay thế — từ XML GDT';
COMMENT ON COLUMN invoices.so_hd_cl_quan IS 'Số HĐ bị thay thế — từ XML GDT';

-- Index to speed up replaced-filter queries
CREATE INDEX IF NOT EXISTS idx_invoices_replacement
  ON invoices(tc_hdon, seller_tax_code, khhd_cl_quan, so_hd_cl_quan)
  WHERE tc_hdon = 1;

-- ============================================================
-- 2. Vendor risk scores table
-- ============================================================
CREATE TABLE IF NOT EXISTS vendor_risk_scores (
  seller_tax_code    VARCHAR(20)  PRIMARY KEY,
  enforcement_status VARCHAR(20)  NOT NULL DEFAULT 'none'
                                  CHECK (enforcement_status IN ('none','active','suspended','removed')),
  risk_score         SMALLINT     NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  risk_reason        TEXT,
  source             VARCHAR(50)  NOT NULL DEFAULT 'manual',
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vendor_risk_scores IS 'NCC rủi ro / cưỡng chế hóa đơn — dùng cho VendorRiskFilter';
COMMENT ON COLUMN vendor_risk_scores.enforcement_status IS 'active=đang cưỡng chế, suspended=tạm dừng, removed=đã gỡ';
COMMENT ON COLUMN vendor_risk_scores.risk_score IS '0-100; >=70 → cảnh báo; enforcement_status=active → loại hẳn';

CREATE INDEX IF NOT EXISTS idx_vendor_risk_enforcement
  ON vendor_risk_scores(enforcement_status)
  WHERE enforcement_status = 'active';

-- ============================================================
-- 3. Plugin configuration table
-- ============================================================
CREATE TABLE IF NOT EXISTS validation_plugin_configs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  mst              VARCHAR(20)  NOT NULL,
  plugin_name      VARCHAR(100) NOT NULL,
  enabled          BOOLEAN      NOT NULL DEFAULT TRUE,
  priority_override INT,
  config           JSONB        NOT NULL DEFAULT '{}',
  updated_by       VARCHAR(100),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(mst, plugin_name)
);

COMMENT ON TABLE validation_plugin_configs IS
  'Cấu hình plugin validation — mst=''*'' là global defaults, mst cụ thể ghi đè global';
COMMENT ON COLUMN validation_plugin_configs.mst IS '''*'' = áp dụng cho tất cả công ty';

-- Seed global defaults for all 6 plugins
INSERT INTO validation_plugin_configs (mst, plugin_name, enabled, config) VALUES
  ('*', 'cancelled_filter',      TRUE, '{}'),
  ('*', 'replaced_filter',       TRUE, '{}'),
  ('*', 'cqt_signature_filter',  TRUE, '{}'),
  ('*', 'cash_payment_filter',   TRUE, '{"effective_date": "2025-07-01", "threshold": 5000000}'),
  ('*', 'non_business_filter',   TRUE, '{"keywords": ["cá nhân","sinh hoạt","gia đình","giải trí","du lịch","điện thoại cá nhân"]}'),
  ('*', 'vendor_risk_filter',    TRUE, '{"warn_threshold": 70}')
ON CONFLICT (mst, plugin_name) DO NOTHING;

-- ============================================================
-- 4. Invoice validation audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS invoice_validation_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  mst                 VARCHAR(20) NOT NULL,
  declaration_period  VARCHAR(20) NOT NULL,
  direction           VARCHAR(10) NOT NULL CHECK (direction IN ('input','output','both')),
  status              VARCHAR(20) NOT NULL CHECK (status IN ('valid','excluded','warning')),
  reason_codes        TEXT[]      NOT NULL DEFAULT '{}',
  reason_detail       TEXT,
  plugin_name         VARCHAR(100),
  validated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pipeline_run_id     UUID        NOT NULL
);

COMMENT ON TABLE invoice_validation_log IS
  'Audit log mỗi quyết định của validation pipeline — 1 row / hóa đơn / pipeline run';
COMMENT ON COLUMN invoice_validation_log.pipeline_run_id IS 'UUID v4 nhóm tất cả kết quả trong 1 lần chạy pipeline';

CREATE INDEX IF NOT EXISTS idx_validation_log_invoice  ON invoice_validation_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_validation_log_period   ON invoice_validation_log(mst, declaration_period);
CREATE INDEX IF NOT EXISTS idx_validation_log_run      ON invoice_validation_log(pipeline_run_id);
CREATE INDEX IF NOT EXISTS idx_validation_log_status   ON invoice_validation_log(status) WHERE status != 'valid';

COMMIT;
