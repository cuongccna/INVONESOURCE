-- Migration 049: HKD Inventory Opening Balances (TT152/2025/TT-BTC)
--
-- Thông tư 152/2025/TT-BTC (hiệu lực 01/01/2026) thay thế TT88/2021.
-- Sổ S2d (Chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa) yêu cầu ghi
-- tồn đầu kỳ bắt buộc. Bảng này lưu số dư đầu kỳ theo tháng cho từng mặt hàng.
--
-- Nếu kỳ không có dữ liệu thủ công, hệ thống tự tính từ dữ liệu hóa đơn
-- các kỳ trước (closing balance forward).

CREATE TABLE IF NOT EXISTS hkd_inventory_opening (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_year  SMALLINT     NOT NULL,
  period_month SMALLINT     NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  item_name    TEXT         NOT NULL,
  unit         TEXT,
  quantity     NUMERIC(18,4) NOT NULL DEFAULT 0,
  amount       NUMERIC(18,0) NOT NULL DEFAULT 0,
  is_manual    BOOLEAN      NOT NULL DEFAULT false,  -- true = admin set; false = auto-calculated
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_year, period_month, item_name)
);

CREATE INDEX IF NOT EXISTS idx_hkd_inv_open_company_period
  ON hkd_inventory_opening (company_id, period_year, period_month);
