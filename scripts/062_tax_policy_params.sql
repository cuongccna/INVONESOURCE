-- Migration 062: Tham số pháp lý có NGÀY HIỆU LỰC + hồ sơ khai bổ sung
--
-- Vì sao: chính sách thuế Việt Nam đổi hằng năm (ngưỡng thanh toán không dùng tiền mặt,
-- ngưỡng doanh thu hộ kinh doanh, lệ phí môn bài, nghị quyết giảm thuế GTGT…).
-- Trước đây các con số này nằm cứng trong mã nguồn → mỗi lần luật đổi phải sửa code
-- và dễ để sót (đúng các lỗi F3, F4, F5 trong báo cáo rà soát).
--
-- Additive + idempotent.

-- ─── 1. Tham số chính sách thuế theo thời kỳ ───────────────────────────────
CREATE TABLE IF NOT EXISTS tax_policy_params (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  param_key      VARCHAR(80)   NOT NULL,        -- vd 'vat.non_cash_payment_threshold'
  effective_from DATE          NOT NULL,        -- áp dụng từ ngày (theo kỳ tính thuế)
  effective_to   DATE,                          -- NULL = còn hiệu lực
  num_value      NUMERIC(20,4),
  text_value     TEXT,
  legal_basis    TEXT          NOT NULL,        -- căn cứ pháp lý, bắt buộc ghi rõ
  note           TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (param_key, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_tax_policy_lookup
  ON tax_policy_params (param_key, effective_from DESC);

COMMENT ON TABLE tax_policy_params IS
  'Tham số pháp lý tra theo kỳ tính thuế. Sửa chính sách = thêm dòng mới, không sửa code.';

-- Ngưỡng bắt buộc có chứng từ thanh toán không dùng tiền mặt để được khấu trừ GTGT
INSERT INTO tax_policy_params (param_key, effective_from, effective_to, num_value, legal_basis, note) VALUES
  ('vat.non_cash_payment_threshold', '2014-01-01', '2025-06-30', 20000000,
   'Luật Thuế GTGT 13/2008/QH12 (sửa đổi 31/2013/QH13) và các văn bản hướng dẫn',
   'Hoá đơn từ 20 triệu đồng trở lên phải có chứng từ thanh toán không dùng tiền mặt'),
  ('vat.non_cash_payment_threshold', '2025-07-01', NULL, 5000000,
   'Luật Thuế GTGT 48/2024/QH15 và nghị định hướng dẫn',
   'Bỏ ngưỡng 20 triệu; chỉ miễn chứng từ thanh toán không dùng tiền mặt với giao dịch giá trị nhỏ')
ON CONFLICT (param_key, effective_from) DO NOTHING;

-- Ngưỡng doanh thu năm không chịu thuế GTGT / không nộp TNCN của hộ kinh doanh
INSERT INTO tax_policy_params (param_key, effective_from, effective_to, num_value, legal_basis, note) VALUES
  ('hkd.revenue_exempt_threshold_year', '2021-08-01', '2025-06-30', 100000000,
   'Thông tư 40/2021/TT-BTC', 'Doanh thu từ 100 triệu đồng/năm trở xuống không phải nộp thuế'),
  ('hkd.revenue_exempt_threshold_year', '2025-07-01', '2025-12-31', 200000000,
   'Luật Thuế GTGT 48/2024/QH15', 'Nâng ngưỡng lên 200 triệu đồng/năm'),
  ('hkd.revenue_exempt_threshold_year', '2026-01-01', NULL, 1000000000,
   'Nghị quyết 198/2025/QH15',
   'Doanh thu từ 1 tỷ đồng/năm trở xuống không chịu thuế GTGT và không phải nộp thuế TNCN, áp dụng từ 01/01/2026')
ON CONFLICT (param_key, effective_from) DO NOTHING;

-- Lệ phí môn bài của hộ kinh doanh: 1 = còn thu, 0 = đã bãi bỏ
INSERT INTO tax_policy_params (param_key, effective_from, effective_to, num_value, legal_basis, note) VALUES
  ('hkd.license_fee_applicable', '2017-01-01', '2025-12-31', 1,
   'Nghị định 139/2016/NĐ-CP', 'Lệ phí môn bài theo bậc doanh thu'),
  ('hkd.license_fee_applicable', '2026-01-01', NULL, 0,
   'Nghị quyết 198/2025/QH15', 'Bãi bỏ lệ phí môn bài đối với hộ, cá nhân kinh doanh từ 01/01/2026')
ON CONFLICT (param_key, effective_from) DO NOTHING;

-- Mốc phân nhóm hộ kinh doanh để xác định bộ sổ kế toán phải ghi (TT152/2025)
INSERT INTO tax_policy_params (param_key, effective_from, effective_to, num_value, legal_basis, note) VALUES
  ('hkd.book_group_small_max', '2026-01-01', NULL, 1000000000,
   'Nghị quyết 198/2025/QH15 và Thông tư 152/2025/TT-BTC',
   'Hộ không thuộc diện nộp thuế (doanh thu ≤ 1 tỷ/năm) chỉ ghi sổ S1a-HKD'),
  ('hkd.book_group_medium_max', '2026-01-01', NULL, 3000000000,
   'Thông tư 152/2025/TT-BTC', 'Từ 500 triệu đến 3 tỷ: S2a-HKD (tỷ lệ %) hoặc bộ S2b–S2e (thu nhập tính thuế)')
ON CONFLICT (param_key, effective_from) DO NOTHING;

-- ─── 2. Chính sách giảm thuế GTGT theo nghị quyết, tra theo kỳ ─────────────
CREATE TABLE IF NOT EXISTS vat_reduction_policies (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from DATE        NOT NULL,
  effective_to   DATE        NOT NULL,
  standard_rate  NUMERIC(5,2) NOT NULL DEFAULT 10,   -- thuế suất theo quy định
  reduced_rate   NUMERIC(5,2) NOT NULL DEFAULT 8,    -- thuế suất sau giảm
  xml_block_tag  VARCHAR(60) NOT NULL,               -- tên khối phụ lục trong XML HTKK
  legal_basis    TEXT        NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (effective_from, effective_to)
);

COMMENT ON TABLE vat_reduction_policies IS
  'Nghị quyết giảm thuế GTGT theo từng thời kỳ. xml_block_tag phải khớp bộ chuẩn XML của HTKK đang dùng.';

INSERT INTO vat_reduction_policies (effective_from, effective_to, standard_rate, reduced_rate, xml_block_tag, legal_basis, note) VALUES
  ('2022-02-01', '2022-12-31', 10, 8, 'PL_NQ43_GTGT',  'Nghị quyết 43/2022/QH15', NULL),
  ('2023-07-01', '2023-12-31', 10, 8, 'PL_NQ101_GTGT', 'Nghị quyết 101/2023/QH15', NULL),
  ('2024-01-01', '2024-06-30', 10, 8, 'PL_NQ110_GTGT', 'Nghị quyết 110/2023/QH15', NULL),
  ('2024-07-01', '2024-12-31', 10, 8, 'PL_NQ142_GTGT', 'Nghị quyết 142/2024/QH15', NULL),
  ('2025-01-01', '2025-06-30', 10, 8, 'PL_NQ174_GTGT', 'Nghị quyết 174/2024/QH15', NULL),
  ('2025-07-01', '2026-12-31', 10, 8, 'PL_NQ204_GTGT', 'Nghị quyết của Quốc hội về giảm thuế GTGT giai đoạn 7/2025–2026',
   'CẦN ĐỐI CHIẾU tên khối phụ lục với bộ chuẩn XML của phiên bản HTKK đang dùng trước khi nộp')
ON CONFLICT (effective_from, effective_to) DO NOTHING;

-- ─── 3. Thông tin phục vụ header tờ khai (F9) ─────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_authority_code  VARCHAR(20);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_authority_name  VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS signer_name         VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS signer_title        VARCHAR(120);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS business_line_code  VARCHAR(10);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS accounting_regime   VARCHAR(20);

ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_accounting_regime;
ALTER TABLE companies ADD CONSTRAINT chk_accounting_regime CHECK (
  accounting_regime IS NULL OR accounting_regime IN ('tt133', 'tt200', 'tt132', 'hkd')
);

COMMENT ON COLUMN companies.tax_authority_code IS 'Mã cơ quan thuế quản lý — điền vào maCQTNoiNop của tờ khai';
COMMENT ON COLUMN companies.accounting_regime  IS 'Chế độ kế toán áp dụng: tt133 (DNNVV), tt200 (DN), tt132 (siêu nhỏ), hkd (hộ kinh doanh)';

-- Điền sẵn tên cơ quan thuế từ kết quả tra cứu mã số thuế đã có
UPDATE companies c
   SET tax_authority_name = v.tax_authority
  FROM company_verification_cache v
 WHERE v.tax_code = c.tax_code
   AND v.tax_authority IS NOT NULL
   AND c.tax_authority_name IS NULL;

-- ─── 4. Tờ khai bổ sung (F8) ──────────────────────────────────────────────
ALTER TABLE tax_declarations ADD COLUMN IF NOT EXISTS declaration_type       VARCHAR(20) NOT NULL DEFAULT 'chinh_thuc';
ALTER TABLE tax_declarations ADD COLUMN IF NOT EXISTS amendment_no           SMALLINT    NOT NULL DEFAULT 0;
ALTER TABLE tax_declarations ADD COLUMN IF NOT EXISTS amends_declaration_id  UUID        REFERENCES tax_declarations(id) ON DELETE SET NULL;
ALTER TABLE tax_declarations ADD COLUMN IF NOT EXISTS khbs_reason            TEXT;
ALTER TABLE tax_declarations ADD COLUMN IF NOT EXISTS khbs_snapshot          JSONB;

ALTER TABLE tax_declarations DROP CONSTRAINT IF EXISTS chk_declaration_type;
ALTER TABLE tax_declarations ADD CONSTRAINT chk_declaration_type CHECK (
  declaration_type IN ('chinh_thuc', 'bo_sung')
);

COMMENT ON COLUMN tax_declarations.declaration_type IS
  'chinh_thuc = tờ khai lần đầu (loaiTKhai C) | bo_sung = khai bổ sung (loaiTKhai B, kèm số lần)';
COMMENT ON COLUMN tax_declarations.khbs_snapshot IS
  'Ảnh chụp chỉ tiêu của tờ khai bị thay thế — dùng lập bản giải trình khai bổ sung 01/KHBS';

CREATE INDEX IF NOT EXISTS idx_declarations_amendment
  ON tax_declarations (company_id, period_year, period_month, declaration_type, amendment_no);
