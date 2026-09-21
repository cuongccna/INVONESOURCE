-- Migration 061: Bản gốc PDF theo mẫu NHÀ CUNG CẤP (Viettel S-Invoice, MISA…)
--
-- Ba loại tài liệu của một hoá đơn, đừng nhầm lẫn:
--   xml_status / raw_xml        — XML ký số, bản gốc hợp pháp (từ cổng thuế)
--   pdf_status / pdf_path       — bản thể hiện do CỔNG THUẾ phát hành (INVONE render)
--   provider_pdf_status / …     — PDF theo MẪU RIÊNG CỦA NHÀ CUNG CẤP, lấy qua API của họ
--                                 khi công ty đã cấu hình kết nối (Cài đặt → Kết nối hoá đơn)
--
-- Additive + idempotent.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_status VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_path   TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_size   INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_at     TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_error  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_pdf_source VARCHAR(40);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoice_provider_pdf_status;
ALTER TABLE invoices ADD CONSTRAINT chk_invoice_provider_pdf_status CHECK (
  provider_pdf_status IN ('unknown','queued','available','unavailable','failed','no_connector')
);

COMMENT ON COLUMN invoices.provider_pdf_status IS
  'unknown = chưa xét | queued = đang lấy | available = đã có PDF của nhà cung cấp | '
  'no_connector = công ty chưa cấu hình tài khoản nhà cung cấp | unavailable = nhà cung cấp không cấp file | failed = lỗi';
COMMENT ON COLUMN invoices.provider_pdf_source IS
  'Nguồn lấy được, vd "viettel_api" — để biết bản PDF đến từ hệ thống nào';

CREATE INDEX IF NOT EXISTS idx_invoices_provider_pdf_status
  ON invoices (company_id, provider_pdf_status)
  WHERE deleted_at IS NULL;

-- Cờ trong hàng đợi: có cần lấy thêm bản PDF của nhà cung cấp không
ALTER TABLE invoice_xml_queue ADD COLUMN IF NOT EXISTS want_provider_pdf BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN invoice_xml_queue.want_provider_pdf IS
  'true = sau khi lấy gói cổng thuế thì gọi tiếp API nhà cung cấp để tải PDF theo mẫu của họ';
