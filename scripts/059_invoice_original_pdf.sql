-- Migration 059: Bản thể hiện PDF của hoá đơn gốc
--
-- Gói ZIP mà GDT trả về ở /query/invoices/export-xml chứa TOÀN BỘ bản gốc:
--   invoice.xml          — dữ liệu hoá đơn đã ký số (người bán + CQT)
--   invoice.html         — bản thể hiện khổ A4 do nhà cung cấp HĐĐT phát hành
--   details.js           — dữ liệu render cho invoice.html
--   viewinvoice-bg.jpg   — nền hoá đơn
--   sign-check.jpg       — ảnh dấu kiểm tra chữ ký
--
-- GDT KHÔNG cấp sẵn PDF ⇒ bot render invoice.html (Chromium headless) thành PDF A4.
-- File lưu ngoài DB (INVOICE_STORAGE_DIR) để DB không phình theo dung lượng hoá đơn.
--
-- Additive + idempotent.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_status       VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_path         TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_size         INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_generated_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_error        TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zip_path         TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zip_size         INTEGER;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoice_pdf_status;
ALTER TABLE invoices ADD CONSTRAINT chk_invoice_pdf_status CHECK (
  pdf_status IN ('unknown','queued','available','unavailable','failed')
);

COMMENT ON COLUMN invoices.pdf_status IS
  'unknown = chưa xét | queued = đang tải/render | available = đã có file PDF | '
  'unavailable = GDT không lưu bản gốc (HĐ không mã CQT / uỷ nhiệm) | failed = render lỗi';
COMMENT ON COLUMN invoices.pdf_path IS
  'Đường dẫn tương đối trong INVOICE_STORAGE_DIR, dạng <company_id>/<invoice_id>/invoice.pdf';
COMMENT ON COLUMN invoices.zip_path IS
  'Gói ZIP gốc từ GDT (giữ nguyên bản để đối chiếu / render lại khi cần)';

-- Hoá đơn chắc chắn không có bản gốc trên hệ thống GDT thì cũng không có PDF
UPDATE invoices
   SET pdf_status = 'unavailable'
 WHERE pdf_status = 'unknown'
   AND xml_status = 'unavailable';

CREATE INDEX IF NOT EXISTS idx_invoices_pdf_status
  ON invoices (company_id, pdf_status)
  WHERE deleted_at IS NULL;

-- Hàng đợi dùng chung với XML: thêm cờ để biết yêu cầu cần PDF hay chỉ XML
ALTER TABLE invoice_xml_queue ADD COLUMN IF NOT EXISTS want_pdf BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN invoice_xml_queue.want_pdf IS
  'true = sau khi tải ZIP thì render luôn bản thể hiện PDF (mặc định).';
