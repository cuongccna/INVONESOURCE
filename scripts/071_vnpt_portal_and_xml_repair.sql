-- Migration 071: Cổng tra cứu cấp riêng theo từng tài khoản (VNPT, xcyber bản 2)
--                 + dọn bản gốc XML hỏng
--
-- ─── PHẦN 1. XML gốc hỏng ───────────────────────────────────────────────────
--
--   Cổng thuế trả về GÓI ZIP (invoice.xml + invoice.html + ảnh), không phải XML. Đường
--   nhập liệu bot/src/backfill-xml.ts từng ghi thẳng buffer ZIP đó vào cột raw_xml dưới
--   dạng chuỗi UTF-8. Hậu quả: người dùng bấm "Tải XML" ra file .xml có nội dung là ZIP
--   hỏng — mở lên báo lỗi. Mã nguồn đã sửa để bóc invoice.xml trước khi lưu; migration
--   này dọn các bản ghi đã hỏng để hệ thống tự tải lại bản đúng.
--
-- ─── PHẦN 2. Cổng riêng theo từng tài khoản HĐĐT ────────────────────────────
--
--   Nhiều nhà cung cấp cấp cho MỖI TÀI KHOẢN hoá đơn một tên miền tra cứu riêng, địa chỉ
--   chỉ có trong chính hoá đơn / thư người bán gửi:
--
--     VNPT        https://1800546671-tt78.vnpt-invoice.com.vn   + "Mã tra cứu hóa đơn"
--     EasyInvoice http://<MST>hd.easyinvoice.com.vn             (đã xử lý ở 069)
--
--   Không thể liệt kê hết trong danh bạ, nên danh bạ chỉ giữ TÊN MIỀN CHA và hệ thống
--   khớp theo hậu tố; địa chỉ thật lấy từ invoices.provider_lookup_url của từng hoá đơn.
--
--   Nền tảng xcyber (CyberBill/NewCA) chạy nhiều bản song song, mỗi bản một kho dữ liệu:
--     tracuuhoadon1.xcyber.vn → https://bill1app.xcyber.vn
--     tracuuhoadon2.xcyber.vn → https://bill2app.xcyber.vn   ← bản mới, trước đây chưa biết
--   Hỏi nhầm bản thì cổng báo "không có hoá đơn" dù mã đúng. Driver nay tự đọc
--   /assets/appconfig.production.json của cổng in trong hoá đơn để biết máy chủ nào,
--   nên chỉ cần khai thêm tên miền phụ ở đây là nhận diện được.
--
-- Additive + idempotent.

-- ─── 1. Dọn raw_xml không phải XML ──────────────────────────────────────────
-- Nhận diện: bỏ BOM và khoảng trắng đầu chuỗi rồi ký tự đầu không phải '<'
-- (gói ZIP bắt đầu bằng "PK", chuỗi base64 bắt đầu bằng chữ/số).
UPDATE invoices
   SET raw_xml      = NULL,
       raw_xml_size = NULL,
       xml_status   = 'queued',
       xml_error    = 'Bản gốc lưu trước đây không phải XML hợp lệ — đã xoá để tải lại',
       updated_at   = NOW()
 WHERE raw_xml IS NOT NULL
   AND deleted_at IS NULL
   AND left(ltrim(replace(raw_xml, chr(65279), '')), 1) <> '<';

-- Xếp hàng tải lại bản đúng (ưu tiên 10 = backfill hàng loạt, chạy sau mọi yêu cầu của
-- người dùng). Chỉ những hoá đơn cơ quan thuế THẬT SỰ có lưu bản gốc: hoá đơn không mã
-- (ttxly 6) và uỷ nhiệm/máy tính tiền (ttxly 8) thì tải lại cũng không có gì.
INSERT INTO invoice_xml_queue
       (invoice_id, company_id, nbmst, khhdon, shdon, khmshdon, priority, want_pdf)
SELECT i.id, i.company_id, i.seller_tax_code, i.serial_number, i.invoice_number,
       COALESCE(i.gdt_khmshdon, 1), 10, true
  FROM invoices i
 WHERE i.xml_error = 'Bản gốc lưu trước đây không phải XML hợp lệ — đã xoá để tải lại'
   AND i.raw_xml IS NULL
   AND i.deleted_at IS NULL
   AND i.seller_tax_code IS NOT NULL
   AND i.serial_number   IS NOT NULL
   AND i.invoice_number  IS NOT NULL
   AND COALESCE(i.gdt_ttxly, 0) NOT IN (6, 8)
ON CONFLICT (invoice_id) DO UPDATE
   SET status      = CASE WHEN invoice_xml_queue.status = 'processing'
                          THEN invoice_xml_queue.status ELSE 'pending' END,
       attempts    = 0,
       enqueued_at = NOW();

-- ─── 2. VNPT — cổng cấp riêng theo từng tài khoản, CÓ mã xác thực ───────────
--
-- Luồng đã gọi thật ngày 30/08/2026 vào 1800546671-tt78.vnpt-invoice.com.vn:
--   GET  /HomeNoLogin/SearchByFkey  → cookie phiên + trường ẩn __RequestVerificationToken
--   GET  /Captcha/Show              → ảnh PNG của phiên đó (đẩy lên giao diện INVONE)
--   POST /HomeNoLogin/SearchByFkey  __RequestVerificationToken, isHomepage, strFkey, captch
--        → 302 về "/" khi mã xác thực sai · 200 kèm trang kết quả khi đúng
--   GET  /Invoice/Download?checkCode=…        → file bản gốc
--   POST /HomeNoLogin/ajxPreview/ checkCode=… → { str: "<html bản thể hiện>" }
--
-- KHÔNG đặt lookup_api_base: mỗi tài khoản một tên miền, địa chỉ đúng nằm trong hoá đơn.
UPDATE einvoice_providers
   SET lookup_adapter    = 'vnpt',
       lookup_enabled    = true,
       lookup_api_base   = NULL,
       lookup_api_path   = NULL,
       lookup_api_params = NULL,
       lookup_response   = NULL,
       code_label        = 'Mã tra cứu',
       portal_url        = COALESCE(portal_url, 'https://vnpt-invoice.com.vn/'),
       portal_domain     = 'vnpt-invoice.com.vn',
       portal_domain_aliases = ARRAY[
         'vnpt-invoice.vn', 'vnptinvoice.vn', 'hoadondientu.vnpt.vn', 'vnpt.vn'
       ],
       note = 'VNPT cấp cho MỖI TÀI KHOẢN hoá đơn một cổng tra cứu riêng '
              '(https://<mã>-tt78.vnpt-invoice.com.vn). Hệ thống dùng đúng link in trong '
              'hoá đơn, hoặc link người dùng dán vào. Cổng có mã xác thực — ảnh hiện thẳng '
              'trên giao diện INVONE cho người dùng nhập.',
       updated_at = NOW()
 WHERE tax_code = '0100684378';

-- Chưa có trong danh bạ thì thêm mới (cài đặt sạch chưa chạy 068)
INSERT INTO einvoice_providers
       (tax_code, name, short_name, portal_url, portal_domain, code_label,
        lookup_adapter, lookup_enabled, note)
SELECT '0100684378', 'TẬP ĐOÀN BƯU CHÍNH VIỄN THÔNG VIỆT NAM', 'VNPT Invoice',
       'https://vnpt-invoice.com.vn/', 'vnpt-invoice.com.vn', 'Mã tra cứu',
       'vnpt', true,
       'Cổng tra cứu cấp riêng theo từng tài khoản hoá đơn — dùng link in trong hoá đơn.'
 WHERE NOT EXISTS (SELECT 1 FROM einvoice_providers WHERE tax_code = '0100684378');

UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY[
         'vnpt-invoice.vn', 'vnptinvoice.vn', 'hoadondientu.vnpt.vn', 'vnpt.vn'
       ],
       updated_at = NOW()
 WHERE tax_code = '0100684378'
   AND portal_domain_aliases IS NULL;

-- ─── 3. xcyber — bổ sung bản thứ hai của cổng tra cứu ───────────────────────
-- Driver tự đọc cấu hình của cổng để biết máy chủ API, nên chỉ cần nhận diện được tên
-- miền là đủ; lookup_api_base giữ nguyên làm đường lui.
UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY[
         'tracuuhoadon1.xcyber.vn', 'tracuuhoadon2.xcyber.vn',
         'bill1app.xcyber.vn', 'bill2app.xcyber.vn', 'xcyber.vn'
       ],
       note = 'Nền tảng CyberLotus. Cổng chạy nhiều bản song song (tracuuhoadon1 → '
              'bill1app, tracuuhoadon2 → bill2app); hệ thống chọn đúng bản theo link in '
              'trong hoá đơn. Cổng có mã xác thực — ảnh hiện trên giao diện INVONE.',
       updated_at = NOW()
 WHERE tax_code = '0105232093';

-- ─── 4. Ghi chú lại cho Viettel và EFY: hoá đơn KHÔNG MÃ ────────────────────
--
-- Hoá đơn không mã cơ quan thuế không có bản gốc trên hệ thống GDT, nên hệ thống không
-- có XML để trích mã tra cứu — không phải cổng của họ không tra được. Đường đi đúng là
-- người dùng dán đoạn "link + mã tra cứu" người bán gửi kèm (PATCH /invoices/:id/lookup-info),
-- sau đó driver chạy như mọi hoá đơn khác.
UPDATE einvoice_providers
   SET note = 'Hoá đơn KHÔNG MÃ cơ quan thuế không có bản gốc trên hệ thống GDT nên hệ thống '
              'không tự trích được mã tra cứu. Dán link + mã tra cứu người bán gửi kèm hoá '
              'đơn vào INVONE là tra được. | ' || COALESCE(note, ''),
       updated_at = NOW()
 WHERE tax_code IN ('0100109106', '0102519041')
   AND COALESCE(note, '') NOT LIKE 'Hoá đơn KHÔNG MÃ%';

-- ─── 5. Chỉ mục nhận diện ngược theo tên miền phụ ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_einvoice_providers_domain_aliases
  ON einvoice_providers USING GIN (portal_domain_aliases)
  WHERE portal_domain_aliases IS NOT NULL;
