-- Migration 055: Tờ khai khấu trừ thuế TNCN — Mẫu 05/KK-TNCN (TT80/2021)
CREATE TABLE IF NOT EXISTS pit_declarations (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Kỳ kê khai (quý)
  period_quarter    SMALLINT     NOT NULL CHECK (period_quarter BETWEEN 1 AND 4),
  period_year       SMALLINT     NOT NULL CHECK (period_year >= 2021),

  -- Metadata XML / tờ khai
  loai_tkhai        VARCHAR(5)   NOT NULL DEFAULT 'C',   -- C = chính thức, BS = bổ sung
  so_lan            SMALLINT     NOT NULL DEFAULT 0,     -- Lần nộp bổ sung
  ma_cqt_noi_nop    VARCHAR(20),
  ten_cqt_noi_nop   VARCHAR(300),
  mst_cu            VARCHAR(20),                         -- MST cũ khi thay đổi MST
  nguoi_ky          VARCHAR(200),                        -- Tên người ký

  -- Chỉ tiêu kê khai chính (ánh xạ trực tiếp sang XML tag CTieuTKhaiChinh)
  ct15   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Số LĐ ký HĐ từ 3 tháng trở lên
  ct16   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Số LĐ ký HĐ dưới 3 tháng / không HĐ
  ct17   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Tổng số cá nhân phát sinh thu nhập (=ct15+ct16)
  ct18   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Số người giảm trừ gia cảnh bản thân
  ct19   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Tổng thu nhập chịu thuế (HĐ >= 3 tháng)
  ct20   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Giảm trừ gia cảnh (HĐ >= 3 tháng)
  ct21   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế TNCN đã khấu trừ (HĐ >= 3 tháng)
  ct22   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Tổng thu nhập trả (HĐ < 3 tháng, tỷ lệ 10%)
  ct23   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế TNCN đã khấu trừ (HĐ < 3 tháng)
  ct24   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thu nhập từ đại lý BH / xổ số / MLM
  ct25   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế khấu trừ (đại lý BH / xổ số / MLM)
  ct25_1 NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế khấu trừ nhóm khác
  ct26   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thu nhập từ bản quyền / nhượng quyền TM
  ct27   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế khấu trừ (bản quyền / nhượng quyền)
  ct28   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thu nhập từ chứng khoán
  ct29   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế khấu trừ (chứng khoán)
  ct30   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thu nhập từ trúng thưởng
  ct31   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Thuế khấu trừ (trúng thưởng)
  ct32   NUMERIC(18,0) NOT NULL DEFAULT 0,  -- Tổng thuế TNCN đã khấu trừ trong kỳ

  -- Trạng thái & xuất file
  notes             TEXT,
  xml_content       TEXT,
  xml_generated_at  TIMESTAMPTZ,
  submission_status VARCHAR(20)  NOT NULL DEFAULT 'draft'
                    CHECK (submission_status IN ('draft','ready','submitted','accepted','rejected')),
  submission_at     TIMESTAMPTZ,
  created_by        UUID         REFERENCES users(id),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, period_quarter, period_year)
);

CREATE INDEX IF NOT EXISTS idx_pit_declarations_company ON pit_declarations (company_id);
CREATE INDEX IF NOT EXISTS idx_pit_declarations_period  ON pit_declarations (company_id, period_year, period_quarter);
CREATE INDEX IF NOT EXISTS idx_pit_declarations_status  ON pit_declarations (submission_status);
