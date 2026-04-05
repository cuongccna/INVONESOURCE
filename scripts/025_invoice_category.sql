-- 025_invoice_category.sql
-- Thêm các cột phân loại vào bảng invoices cho tính năng gán mã hàng / mã KH (FIX-INV-02)
-- Idempotent: IF NOT EXISTS

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS item_code      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS customer_code  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS notes          TEXT;

-- Index để tìm nhanh theo mã hàng / mã khách (dùng trong báo cáo danh mục)
CREATE INDEX IF NOT EXISTS idx_invoices_item_code     ON invoices(company_id, item_code)     WHERE item_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_customer_code ON invoices(company_id, customer_code) WHERE customer_code IS NOT NULL;

COMMENT ON COLUMN invoices.item_code     IS 'Mã hàng hoá từ product_catalog — gán thủ công hoặc hàng loạt';
COMMENT ON COLUMN invoices.customer_code IS 'Mã khách hàng / NCC từ customer_catalog / supplier_catalog';
COMMENT ON COLUMN invoices.notes         IS 'Ghi chú nội bộ về hóa đơn';
