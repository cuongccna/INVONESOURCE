-- Migration 035: Declaration Indicator Configs
-- Bảng cấu hình chỉ tiêu tờ khai — Admin có thể chỉnh sửa label, formula, notes
-- UI sẽ load từ bảng này để render form động và tính toán

CREATE TABLE IF NOT EXISTS declaration_indicator_configs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type        VARCHAR(20)  NOT NULL DEFAULT '01/GTGT',
  code             VARCHAR(20)  NOT NULL,          -- nội bộ: 'ct21', 'ct22', 'ct26', ...
  indicator_number VARCHAR(10),                     -- hiển thị: '[21]', '[22]', 'A', 'I', ...
  label            TEXT         NOT NULL,           -- nhãn tiếng Việt
  section_code     VARCHAR(10),                     -- nhóm: 'A','B','C','I','II',...,'VI'
  row_type         VARCHAR(20)  NOT NULL DEFAULT 'indicator',
    -- 'section_header' | 'subsection_header' | 'indicator'
  has_value_col    BOOLEAN      NOT NULL DEFAULT true,   -- có cột "Giá trị HHDV"
  has_vat_col      BOOLEAN      NOT NULL DEFAULT false,  -- có cột "Thuế GTGT"
  value_db_field   VARCHAR(100),   -- tên cột DB cho giá trị (vd: 'ct23_input_subtotal')
  vat_db_field     VARCHAR(100),   -- tên cột DB cho thuế VAT (vd: 'ct23_deductible_input_vat')
  formula_expression TEXT,          -- công thức: 'MAX(0,[36]-[22]+[37]-[38]-[39])'
  is_manual        BOOLEAN      NOT NULL DEFAULT false,  -- user nhập tay
  is_calculated    BOOLEAN      NOT NULL DEFAULT true,   -- auto-calc từ hóa đơn
  display_order    INT          NOT NULL,
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_indicator_config UNIQUE (form_type, code)
);

CREATE INDEX IF NOT EXISTS idx_indicator_configs_form_order
  ON declaration_indicator_configs(form_type, display_order)
  WHERE is_active = true;

-- ── Trigger updated_at ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_indicator_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_indicator_configs_updated_at ON declaration_indicator_configs;
CREATE TRIGGER trg_indicator_configs_updated_at
  BEFORE UPDATE ON declaration_indicator_configs
  FOR EACH ROW EXECUTE FUNCTION update_indicator_configs_updated_at();

-- ── SEED DATA: 01/GTGT (TT80/2021) ───────────────────────────────────────────
-- Thứ tự và nhãn theo mẫu chính thức Mẫu số 01/GTGT

INSERT INTO declaration_indicator_configs
  (form_type, code, indicator_number, label, section_code, row_type,
   has_value_col, has_vat_col, value_db_field, vat_db_field,
   formula_expression, is_manual, is_calculated, display_order, notes)
VALUES

-- ── Dòng A: Không phát sinh ───────────────────────────────────────────────────
('01/GTGT','ct21','[21]',
 'Không phát sinh hoạt động mua, bán trong kỳ (đánh dấu "X")',
 'A', 'indicator', false, false,
 'ct21_no_activity', NULL,
 NULL, true, false, 10,
 'Checkbox; nếu TRUE thì toàn bộ chỉ tiêu còn lại bằng 0'),

-- ── Dòng B: Kết chuyển kỳ trước ──────────────────────────────────────────────
('01/GTGT','ct22','[22]',
 'Thuế GTGT còn được khấu trừ kỳ trước chuyển sang',
 'B', 'indicator', false, true,
 NULL, 'ct24_carried_over_vat',
 'ct43_prev_period', false, true, 20,
 'Tự động lấy từ [43] của tờ khai kỳ liền trước. Admin có thể override qua opening-balance.'),

-- ── Dòng C header ────────────────────────────────────────────────────────────
('01/GTGT','sec_c',NULL,
 'Kê khai thuế GTGT phải nộp Ngân sách nhà nước',
 'C', 'section_header', false, false,
 NULL, NULL, NULL, false, false, 30, NULL),

-- ── Phần I: Đầu vào ───────────────────────────────────────────────────────────
('01/GTGT','sec_i',NULL,
 'Hàng hoá, dịch vụ (HHDV) mua vào trong kỳ',
 'I', 'subsection_header', false, false,
 NULL, NULL, NULL, false, false, 40, NULL),

('01/GTGT','ct23','[23]',
 'Hàng hoá, dịch vụ mua vào trong kỳ',
 'I', 'indicator', true, true,
 'ct23_input_subtotal', 'ct23_deductible_input_vat',
 NULL, false, true, 50,
 'Giá trị HHDV = tiền chưa thuế; Thuế GTGT = ct24 (deductible only). Cột Thuế = [24]'),

('01/GTGT','ct24_row','[23a]',
 'Trong đó: Hàng hoá dịch vụ nhập khẩu',
 'I', 'indicator', true, true,
 NULL, NULL,
 NULL, false, false, 55,
 'Hiện tại hệ thống chưa phân loại nhập khẩu riêng. Giữ = 0.'),

('01/GTGT','ct25','[25]',
 'Tổng số thuế GTGT được khấu trừ kỳ này ([24]+[22])',
 'I', 'indicator', false, true,
 NULL, 'ct25_total_deductible',
 '[24]+[22]', false, true, 60,
 'Công thức: ct25 = ct23_deductible_input_vat + ct24_carried_over_vat'),

-- ── Phần II: Đầu ra ───────────────────────────────────────────────────────────
('01/GTGT','sec_ii',NULL,
 'Hàng hoá, dịch vụ bán ra trong kỳ',
 'II', 'subsection_header', false, false,
 NULL, NULL, NULL, false, false, 70, NULL),

('01/GTGT','ct26','[26]',
 'Hàng hóa, dịch vụ bán ra không chịu thuế GTGT',
 'II', 'indicator', true, false,
 'ct26_kct_revenue', NULL,
 NULL, false, true, 80,
 'tax_category=KCT. Fallback: ct30_exempt_revenue nếu ct26=0'),

('01/GTGT','ct27_28','[27]',
 'Hàng hóa, dịch vụ bán ra chịu thuế GTGT ([27]=[29]+[30]+[32]+[32a]; [28]=[31]+[33])',
 'II', 'indicator', true, true,
 'ct40_total_output_revenue', 'ct40a_total_output_vat',
 '[29]+[30]+[32]+[32a]', false, true, 90,
 'Tổng doanh thu chịu thuế. [27]=sum các dòng a,b,c,d; [28]=tổng thuế'),

('01/GTGT','ct29','[29]',
 'Hàng hoá, dịch vụ bán ra chịu thuế suất 0%',
 'II', 'indicator', true, false,
 'ct29_0pct_revenue', NULL,
 NULL, false, true, 100,
 'tax_category=0 (xuất khẩu). Không có cột thuế vì thuế = 0.'),

('01/GTGT','ct30_31','[30]',
 'Hàng hoá, dịch vụ bán ra chịu thuế suất 5%',
 'II', 'indicator', true, true,
 'ct32_revenue_5pct', 'ct33_vat_5pct',
 NULL, false, true, 110, NULL),

('01/GTGT','ct32_33','[32]',
 'Hàng hoá, dịch vụ bán ra chịu thuế suất 10%',
 'II', 'indicator', true, true,
 'ct36_revenue_10pct', 'ct37_vat_10pct',
 NULL, false, true, 120,
 'Gộp cả 8% (NQ142) vào nhóm 10% theo mẫu HTKK. ct36_revenue_10pct + ct34_revenue_8pct'),

('01/GTGT','ct32a','[32a]',
 'Hàng hóa dịch vụ không phải kê khai, tính nộp thuế GTGT',
 'II', 'indicator', true, false,
 'ct32a_kkknt_revenue', NULL,
 NULL, false, true, 130,
 'tax_category=KKKNT hoặc KKKTT'),

('01/GTGT','ct34_35','[34]',
 'Tổng doanh thu và thuế GTGT của HHDV bán ra ([34]=[26]+[27]; [35]=[28])',
 'II', 'indicator', true, true,
 'ct40_total_output_revenue', 'ct40a_total_output_vat',
 '[26]+[27]', false, true, 140,
 'ct34 = ct26+ct27; ct35 = ct28 = tổng thuế đầu ra'),

-- ── Phần III: Thuế GTGT phát sinh ────────────────────────────────────────────
('01/GTGT','ct36','[36]',
 'Thuế GTGT phát sinh trong kỳ ([36]=[35]-[25])',
 'III', 'indicator', false, true,
 NULL, 'ct40a_total_output_vat',
 '[35]-[25]', false, true, 150,
 'net = tổng thuế đầu ra - tổng thuế được khấu trừ. Có thể âm.'),

-- ── Phần IV: Điều chỉnh ──────────────────────────────────────────────────────
('01/GTGT','sec_iv',NULL,
 'Điều chỉnh tăng, giảm thuế GTGT còn được khấu trừ của các kỳ trước',
 'IV', 'subsection_header', false, false,
 NULL, NULL, NULL, false, false, 160, NULL),

('01/GTGT','ct37','[37]',
 'Điều chỉnh giảm',
 'IV', 'indicator', false, true,
 NULL, 'ct37_adjustment_decrease',
 NULL, true, false, 170,
 'Nhập tay khi có khai bổ sung kỳ trước làm GIẢM thuế được khấu trừ'),

('01/GTGT','ct38','[38]',
 'Điều chỉnh tăng',
 'IV', 'indicator', false, true,
 NULL, 'ct38_adjustment_increase',
 NULL, true, false, 180,
 'Nhập tay khi có khai bổ sung kỳ trước làm TĂNG thuế được khấu trừ'),

-- ── Phần V ────────────────────────────────────────────────────────────────────
('01/GTGT','ct39','[39]',
 'Thuế GTGT đã nộp ở địa phương khác của hoạt động kinh doanh xây dựng, lắp đặt, bán hàng, bất động sản ngoại tỉnh',
 'V', 'indicator', false, true,
 NULL, NULL,
 NULL, true, false, 190,
 'Nhập tay. Hiện tại = 0 cho phần lớn DN.'),

-- ── Phần VI: Xác định nghĩa vụ ───────────────────────────────────────────────
('01/GTGT','sec_vi',NULL,
 'Xác định nghĩa vụ thuế GTGT phải nộp trong kỳ',
 'VI', 'section_header', false, false,
 NULL, NULL, NULL, false, false, 200, NULL),

('01/GTGT','ct40a','[40a]',
 'Thuế GTGT phải nộp của hoạt động sản xuất kinh doanh trong kỳ ([40a]=[36]-[22]+[37]-[38]-[39]≥0)',
 'VI', 'indicator', false, true,
 NULL, 'ct41_payable_vat',
 'MAX(0,[36]-[22]+[37]-[38]-[39])', false, true, 210,
 'Nếu kết quả < 0 thì [40a]=0. Số dư chuyển sang [41].'),

('01/GTGT','ct40b','[40b]',
 'Thuế GTGT mua vào của dự án đầu tư được bù trừ với thuế GTGT còn phải nộp',
 'VI', 'indicator', false, true,
 NULL, 'ct40b_investment_vat',
 NULL, true, false, 220,
 'Nhập tay khi có dự án đầu tư bù trừ.'),

('01/GTGT','ct40','[40]',
 'Thuế GTGT còn phải nộp trong kỳ ([40]=[40a]-[40b])',
 'VI', 'indicator', false, true,
 NULL, 'ct41_payable_vat',
 '[40a]-[40b]', false, true, 230,
 'ct40 = ct40a - ct40b. Số này là số phải nộp vào NSNN.'),

('01/GTGT','ct41','[41]',
 'Thuế GTGT chưa khấu trừ hết kỳ này (nếu [41]=[36]-[22]+[37]-[38]-[39] < 0)',
 'VI', 'indicator', false, true,
 NULL, 'ct41_payable_vat',
 'MAX(0,([22]-[36]+[38]-[37]+[39]))', false, true, 240,
 'Phần thuế đầu vào còn dư, chưa được khấu trừ hết trong kỳ.'),

('01/GTGT','ct42','[42]',
 'Tổng số thuế GTGT đề nghị hoàn',
 'VI', 'indicator', false, true,
 NULL, NULL,
 NULL, true, false, 250,
 'Nhập tay khi có đề nghị hoàn thuế. Hiện tại = 0 cho phần lớn.'),

('01/GTGT','ct43','[43]',
 'Thuế GTGT còn được khấu trừ chuyển kỳ sau ([43]=[41]-[42])',
 'VI', 'indicator', false, true,
 NULL, 'ct43_carry_forward_vat',
 '[41]-[42]', false, true, 260,
 'Tự động chuyển sang [22] của kỳ tiếp theo.')

ON CONFLICT (form_type, code) DO UPDATE SET
  indicator_number   = EXCLUDED.indicator_number,
  label              = EXCLUDED.label,
  section_code       = EXCLUDED.section_code,
  row_type           = EXCLUDED.row_type,
  has_value_col      = EXCLUDED.has_value_col,
  has_vat_col        = EXCLUDED.has_vat_col,
  value_db_field     = EXCLUDED.value_db_field,
  vat_db_field       = EXCLUDED.vat_db_field,
  formula_expression = EXCLUDED.formula_expression,
  is_manual          = EXCLUDED.is_manual,
  is_calculated      = EXCLUDED.is_calculated,
  display_order      = EXCLUDED.display_order,
  notes              = EXCLUDED.notes,
  updated_at         = NOW();
