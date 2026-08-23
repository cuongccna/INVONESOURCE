-- Migration 060: Nhà cung cấp HĐĐT + mã tra cứu bản gốc của nhà cung cấp
--
-- Bối cảnh: hệ thống GDT chỉ lưu XML ký số và bản thể hiện do CHÍNH CỔNG THUẾ render.
-- File PDF theo mẫu riêng của từng nhà cung cấp (Viettel S-Invoice, MISA meInvoice,
-- VNPT, EFY, BKAV…) chỉ lấy được trên cổng tra cứu của nhà cung cấp đó, bằng
-- "Mã tra cứu" / "Mã số bí mật" in trên hoá đơn — mã này nằm trong XML gốc (TTKhac).
--
-- Migration này:
--   1. Tạo danh bạ nhà cung cấp HĐĐT (MST T-VAN → tên + cổng tra cứu)
--   2. Thêm invoices.provider_lookup_code và backfill từ raw_xml đã tải về
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS einvoice_providers (
  tax_code    VARCHAR(20) PRIMARY KEY,          -- MST đơn vị cung cấp giải pháp (tvandnkntt)
  name        TEXT        NOT NULL,             -- tên đầy đủ
  short_name  TEXT,                             -- tên thương hiệu, vd "Viettel S-Invoice"
  portal_url  TEXT,                             -- trang tra cứu hoá đơn cho người mua
  code_label  TEXT        DEFAULT 'Mã tra cứu', -- nhãn ô nhập mã trên cổng đó
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE einvoice_providers IS
  'Danh bạ nhà cung cấp hoá đơn điện tử — dùng để chỉ đường tới bản gốc theo mẫu '
  'riêng của nhà cung cấp (cổng thuế chỉ có XML ký số + bản thể hiện của cổng thuế).';

INSERT INTO einvoice_providers (tax_code, name, short_name, portal_url, code_label, note) VALUES
  ('0100109106', 'TẬP ĐOÀN CÔNG NGHIỆP - VIỄN THÔNG QUÂN ĐỘI', 'Viettel S-Invoice',
   'https://sinvoice.viettel.vn/tracuuhoadon', 'Mã số bí mật',
   'Nhập MST người bán + mã số bí mật + mã bảo mật để xem và tải PDF/XML'),
  ('0101243150', 'CÔNG TY CỔ PHẦN MISA', 'MISA meInvoice',
   'https://www.meinvoice.vn/tra-cuu/', 'Mã tra cứu',
   'Chọn thẻ "Theo mã tra cứu"; có thể tải PDF và XML'),
  ('0102519041', 'CÔNG TY CỔ PHẦN CÔNG NGHỆ TIN HỌC EFY VIỆT NAM', 'EFY iHoaDon',
   'https://ihoadon.vn/kiem-tra/', 'Mã tra cứu', NULL),
  ('0106026495', 'CÔNG TY CỔ PHẦN CÔNG NGHỆ NCCA', 'NCCA',
   'https://nc-ca.com.vn/tra-cuu/', 'Mã tra cứu', NULL),
  ('0100684378', 'TẬP ĐOÀN BƯU CHÍNH VIỄN THÔNG VIỆT NAM', 'VNPT Invoice',
   'https://hoadondientu.vnpt.vn/', 'Mã tra cứu',
   'Một số tỉnh dùng cổng riêng dạng https://<tinh>.vnpt-invoice.com.vn'),
  ('0100686209', 'TỔNG CÔNG TY VIỄN THÔNG MOBIFONE', 'MobiFone Invoice',
   'https://mobifoneinvoice.vn/', 'Mã tra cứu', NULL),
  ('0101360697', 'CÔNG TY CỔ PHẦN BKAV', 'BKAV eHoadon',
   'https://van.ehoadon.vn/', 'Mã tra cứu', NULL)
ON CONFLICT (tax_code) DO UPDATE SET
  name       = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  portal_url = EXCLUDED.portal_url,
  code_label = EXCLUDED.code_label,
  note       = EXCLUDED.note,
  updated_at = NOW();

-- ─── Mã tra cứu của nhà cung cấp trên từng hoá đơn ──────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_lookup_code  TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_lookup_label TEXT;

COMMENT ON COLUMN invoices.provider_lookup_code IS
  'Mã tra cứu / mã số bí mật do nhà cung cấp HĐĐT cấp, trích từ TTKhac của XML gốc. '
  'Dùng để lấy bản gốc theo mẫu nhà cung cấp trên cổng tra cứu của họ.';

-- Backfill từ XML đã tải: XML có 2 thứ tự trường khác nhau tuỳ nhà cung cấp
UPDATE invoices SET
  provider_lookup_label = COALESCE(
    substring(raw_xml from '<TTruong>(Mã tra cứu|Mã số bí mật)</TTruong>'),
    substring(raw_xml from '<TTruong>(Mã tra cứu|Mã số bí mật)</TTruong>')
  ),
  provider_lookup_code = COALESCE(
    -- dạng 1: <TTruong>Mã tra cứu</TTruong><KDLieu>…</KDLieu><DLieu>CODE</DLieu>
    substring(raw_xml from '<TTruong>(?:Mã tra cứu|Mã số bí mật)</TTruong><KDLieu>[^<]*</KDLieu><DLieu>([^<]+)</DLieu>'),
    -- dạng 2: <DLieu>CODE</DLieu><KDLieu>…</KDLieu><TTruong>Mã tra cứu</TTruong>
    substring(raw_xml from '<DLieu>([^<]+)</DLieu><KDLieu>[^<]*</KDLieu><TTruong>(?:Mã tra cứu|Mã số bí mật)</TTruong>')
  )
WHERE raw_xml IS NOT NULL
  AND provider_lookup_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_provider_lookup
  ON invoices (gdt_tvandnkntt)
  WHERE deleted_at IS NULL;
