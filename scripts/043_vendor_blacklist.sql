-- Migration 043: Vendor blacklist + enhanced risk detection support
-- Purpose: Store blacklisted tax codes + support for new risk flag types

-- 1. Vendor blacklist table
CREATE TABLE IF NOT EXISTS vendor_blacklist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code      VARCHAR(20) NOT NULL,
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = global blacklist
  reason        TEXT NOT NULL,
  added_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes         TEXT,
  UNIQUE (tax_code, company_id)
);

CREATE INDEX IF NOT EXISTS idx_vendor_blacklist_tax_code ON vendor_blacklist (tax_code);
CREATE INDEX IF NOT EXISTS idx_vendor_blacklist_company_id ON vendor_blacklist (company_id);

COMMENT ON TABLE vendor_blacklist IS
  'Danh sách MST nhà cung cấp bị đưa vào blacklist. company_id=NULL = toàn hệ thống.';

-- 2. Add new flag types to FLAG_ICON reference docs (no DB change needed — stored as TEXT in flag_types[])
--    New flags to be implemented:
--    BLACKLISTED          = MST trong blacklist
--    VIRTUAL_OFFICE       = Địa chỉ văn phòng ảo / không hợp lệ
--    DIRECTOR_MULTI_CO    = Giám đốc đứng ≥3 công ty
--    UNREGISTERED_CATEGORY= Ngành nghề xuất HĐ không có trong ĐKKD
--    K_FACTOR_HIGH        = Hệ số K đầu ra/đầu vào bất thường (≥5x)

-- 3. Index for fast blacklist lookups during scan
CREATE INDEX IF NOT EXISTS idx_vendor_blacklist_global ON vendor_blacklist (tax_code) WHERE company_id IS NULL;
