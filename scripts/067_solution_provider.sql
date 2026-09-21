-- Migration 067: Nhận diện nhà cung cấp theo MSTTCGP + link mở thẳng hoá đơn
--
-- PHÁT HIỆN
--   Trước nay hệ thống nhận diện nhà cung cấp HĐĐT bằng trường tvandnkntt của cổng thuế.
--   Sai đối tượng: tvandnkntt là TỔ CHỨC T-VAN nhận/truyền/lưu trữ dữ liệu tới cơ quan
--   thuế, còn bên có CỔNG TRA CỨU là TỔ CHỨC CUNG CẤP GIẢI PHÁP — nằm ở thẻ <MSTTCGP>
--   trong chính XML hoá đơn. Hai bên thường khác nhau:
--
--     MSTTCGP 0106870211 (ICORP / Viet-Invoice) — tvandnkntt 0312303803 (Win Tech)  : 13 HĐ
--     MSTTCGP 0106166781 (NCCA)                 — tvandnkntt 0106026495 (M-Invoice) : 14 HĐ
--
--   Nặng hơn: tvandnkntt rỗng ở 11 hoá đơn, còn MSTTCGP thì luôn có. Đó là lý do giao
--   diện báo "không rõ nhà cung cấp" dù XML thừa thông tin để biết.
--
--   Ghi chú: migration 060 gán NCCA cho MST 0106026495 là nhầm — MST đó là M-Invoice.
--   MST thật của NCCA là 0106166781 (tra cổng thuế).
--
-- Additive + idempotent.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_solution_tax_code TEXT;

COMMENT ON COLUMN invoices.provider_solution_tax_code IS
  'MSTTCGP — MST tổ chức cung cấp giải pháp HĐĐT, đọc từ XML hoá đơn. Đây là bên có cổng '
  'tra cứu; KHÁC gdt_tvandnkntt (tổ chức T-VAN truyền dữ liệu tới cơ quan thuế).';

UPDATE invoices
   SET provider_solution_tax_code = substring(raw_xml from '<MSTTCGP>\s*([0-9-]{10,15})\s*</MSTTCGP>')
 WHERE raw_xml IS NOT NULL
   AND provider_solution_tax_code IS NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_solution_provider
  ON invoices (provider_solution_tax_code)
  WHERE deleted_at IS NULL;

-- ─── Link mở thẳng hoá đơn trên cổng nhà cung cấp ───────────────────────────
--
-- Trang tra cứu chung bắt người dùng gõ lại mã; nhiều cổng nhận mã ngay trên URL nên
-- bấm một phát là ra hoá đơn. {code} = mã tra cứu, {mst} = MST người bán.
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_url_template TEXT;

COMMENT ON COLUMN einvoice_providers.lookup_url_template IS
  'Mẫu URL mở thẳng hoá đơn, vd https://…/?lookupCode={code}. Chỉ điền khi đã kiểm chứng '
  'thật tham số; {code} = mã tra cứu, {mst} = MST người bán.';

-- ICORP / Viet-Invoice: tham số lookupCode đã kiểm chứng trong bundle JS của cổng
-- (main.*.js gọi searchParams.get("lookupCode")).
INSERT INTO einvoice_providers
       (tax_code, name, short_name, portal_url, portal_domain, code_label, lookup_url_template, note)
VALUES ('0106870211', 'CÔNG TY CỔ PHẦN ICORP', 'Viet-Invoice',
        'https://tracuuhoadon.vietinvoice.vn/', 'tracuuhoadon.vietinvoice.vn', 'Mã tra cứu',
        'https://tracuuhoadon.vietinvoice.vn/?lookupCode={code}',
        'Mở thẳng hoá đơn bằng mã tra cứu trên URL')
ON CONFLICT (tax_code) DO UPDATE SET
  short_name          = EXCLUDED.short_name,
  portal_url          = COALESCE(einvoice_providers.portal_url, EXCLUDED.portal_url),
  portal_domain       = COALESCE(einvoice_providers.portal_domain, EXCLUDED.portal_domain),
  lookup_url_template = COALESCE(einvoice_providers.lookup_url_template, EXCLUDED.lookup_url_template),
  updated_at          = NOW();

-- NCCA dưới MST thật của tổ chức cung cấp giải pháp
INSERT INTO einvoice_providers
       (tax_code, name, short_name, portal_url, portal_domain, code_label, note)
VALUES ('0106166781', 'CÔNG TY CỔ PHẦN CÔNG NGHỆ NCCA', 'NCCA',
        'https://nc-ca.com.vn/tra-cuu/', 'nc-ca.com.vn', 'Mã tra cứu',
        'Truyền nhận qua T-VAN M-Invoice, nhưng cổng tra cứu là của NCCA')
ON CONFLICT (tax_code) DO NOTHING;
