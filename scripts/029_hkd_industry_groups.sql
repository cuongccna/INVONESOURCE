-- Migration 029: HKD Industry Groups (TT40/2021/TT-BTC)
-- Thêm nhóm ngành cho HKD theo Phụ lục I TT40:
--   [28] Phân phối, cung cấp hàng hóa              → GTGT 1%, TNCN 0.5%
--   [29] Dịch vụ, xây dựng không bao thầu NVL      → GTGT 5%, TNCN 2%
--   [30] Sản xuất, vận tải, XD có bao thầu NVL     → GTGT 3%, TNCN 1.5%
--   [31] Hoạt động kinh doanh khác                  → GTGT 2%, TNCN 1%

-- 1. Thêm nhóm ngành vào bảng companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS hkd_industry_group SMALLINT DEFAULT 28;

-- CHECK constraint riêng (idempotent)
DO $$ BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_hkd_industry_group
    CHECK (hkd_industry_group IS NULL OR hkd_industry_group IN (28, 29, 30, 31));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Thêm cột nhóm ngành + pit_rate vào hkd_declarations
ALTER TABLE hkd_declarations
  ADD COLUMN IF NOT EXISTS industry_group SMALLINT DEFAULT 28,
  ADD COLUMN IF NOT EXISTS pit_rate NUMERIC(4,2) NOT NULL DEFAULT 0.5;

-- 3. Backfill existing declarations: đọc từ companies.hkd_industry_group
UPDATE hkd_declarations hd
SET industry_group = COALESCE(c.hkd_industry_group, 28)
FROM companies c
WHERE c.id = hd.company_id
  AND hd.industry_group IS NULL;
