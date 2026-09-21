-- Migration 070: Tra cứu bản gốc TRỰC TIẾP trên cổng nhà cung cấp, có ô nhập mã xác thực
--
-- BỐI CẢNH
--   Migration 068/069 dựng lớp plugin chạy nền trong bot: tự tra cứu và giải mã xác thực
--   bằng dịch vụ 2Captcha. Cách đó chỉ chạy được cho vài cổng và tốn tiền giải captcha.
--
--   Từ đây có thêm đường THỨ HAI, chạy ngay khi người dùng bấm "Lấy bản gốc":
--     - Cổng KHÔNG có mã xác thực → hệ thống tự điền MST người bán + mã tra cứu đã có sẵn
--       trong hoá đơn rồi tải file về, người dùng không phải làm gì.
--     - Cổng CÓ mã xác thực → ảnh captcha hiện thẳng trên giao diện cho người dùng nhập.
--   Cấu hình dùng chung bộ cột lookup_* của 068 nên không thêm cột mới.
--
-- KẾT QUẢ DÒ CỔNG (ngày 29/08/2026, gọi thật vào từng cổng)
--
--   xcyber (CyberLotus) — ĐÃ LẤY ĐƯỢC BẢN GỐC THẬT
--     NewCA và CyberBill là hai thương hiệu chạy trên cùng bộ mã ASP.NET Boilerplate "hddt";
--     mỗi bên một máy chủ API, địa chỉ nằm trong assets/appconfig.production.json của cổng:
--       tracuuhoadon.newca.vn → https://mspapp.xcyber.vn
--       tracuu.cyberbill.vn   → https://bill1app.xcyber.vn
--     Luồng: RefreshCaptcha → TraCuu {key, captcha, doanhNghiep_MST, maSoBiMat} → DownloadPdf.
--     Thử với mã 25UZ7XX3AN7S: trả về HTML bản thể hiện có logo NEWCA (301KB, ảnh nhúng
--     data URI, không script) — đúng bản gốc theo mẫu nhà cung cấp. MST người bán có thể
--     để trống, cổng vẫn tra được.
--
--     CHỌN ĐÚNG MÁY CHỦ: hoá đơn của NEWCA trong dữ liệu thật ghi MSTTCGP 0105232093
--     (CyberLotus — bên sở hữu nền tảng), nhưng dữ liệu nằm trên máy chủ của NewCA. Tra vào
--     máy chủ CyberLotus thì báo không có. Vì vậy registry ưu tiên máy chủ của CHÍNH NGƯỜI
--     BÁN khi người bán cũng nằm trong danh bạ và chạy cùng nền tảng
--     (backend/src/services/providerPortal/registry.ts → preferSellerInstance).
--
--   M-Invoice / NCInvoice — cùng một API, KHÔNG có mã xác thực — ĐÃ LẤY ĐƯỢC PDF THẬT
--     Cổng của NCCA (http://tracuuhoadon.hddt-nc.vn) là giao diện React chạy trên nền tảng
--     M-Invoice, dùng ĐÚNG đường dẫn và tham số của M-Invoice nhưng trên HOST CỦA CHÍNH NÓ:
--       GET https://tracuuhoadon.hddt-nc.vn/api/Search/SearchInvoice
--           ?masothue=&sobaomat=&type=PDF&inchuyendoi=false
--     Đã tra thật hoá đơn C26TNC-432 (MST 0106166781, mã FDB63D6) → PDF 390KB.
--     Ghi chú ở 068 rằng "hoá đơn NCCA không nằm trên cổng trung tâm" là ĐÚNG — nhưng lý do
--     không phải vì thiếu endpoint, mà vì mỗi đại lý M-Invoice có host riêng. Đó là lý do
--     lookup_api_base phải đọc từ DB chứ không gắn cứng.
--     Cần MST người bán + mã bảo mật, cả hai đều đã có sẵn trong hoá đơn.
--
--   EFY iHoaDon — KHÔNG có mã xác thực ở lần tra bình thường
--     http://tracuu.ihoadon.vn chuyển hướng về https://ihoadon.vn/kiem-tra/.
--     POST https://ihoadon.vn/kiem-tra/check  certificate_id=<số HĐ>&signature=<mã tra cứu>
--     Đã gọi thật: endpoint sống, mã sai trả {"code":"VE001","message":"Mã xác minh không đúng"}.
--     reCAPTCHA của Google chỉ bật khi cổng thấy bất thường (require_captcha=1); loại mã đó
--     gắn với tên miền của họ nên không nhập hộ được — gặp thì hệ thống chỉ người dùng mở
--     thẳng cổng EFY.
--
--   Viettel Telecom — KHÔNG có mã xác thực, PHẠM VI HẸP
--     https://vietteltelecom.vn/hoadondientu gọi
--     POST https://apigami.viettel.vn/mvt-api/myviettel.php/getSingleSellBillingV2
--     với tham số trên query string: invoiceNo, reservationCode, fromDate/toDate (yyyy-MM-dd,
--     tối đa 90 ngày), fileType=pdf. Đã gọi thật để chốt tên tham số, định dạng ngày và mã
--     lỗi (3 thiếu tham số · 4 sai định dạng ngày · 1 không tìm thấy).
--     CHỈ tra được hoá đơn do chính Viettel Telecom phát hành, không phải mọi hoá đơn đi qua
--     nền tảng S-Invoice — driver tự chặn khi người bán không phải Viettel.
--
-- Additive + idempotent.

-- ─── 0. Tên miền phụ của cùng một cổng ──────────────────────────────────────
-- Một nhà cung cấp thường có nhiều tên miền tra cứu (đích redirect, tên miền cũ vẫn in
-- trên hoá đơn đã phát hành). Trước đây chỉ lưu được MỘT tên miền nên nhận diện ngược từ
-- link trong hoá đơn hay trượt. Thêm danh sách tên miền phụ thay vì tạo bản ghi giả.
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS portal_domain_aliases TEXT[];

COMMENT ON COLUMN einvoice_providers.lookup_url_template IS
  'Mẫu URL mở thẳng hoá đơn trên cổng nhà cung cấp. Chỗ thay thế: {code} mã tra cứu, '
  '{mst} MST người bán, {no} số hoá đơn.';

COMMENT ON COLUMN einvoice_providers.portal_domain_aliases IS
  'Các tên miền khác cùng trỏ về cổng tra cứu của nhà cung cấp này (đích redirect, tên miền '
  'cũ). Dùng để suy ngược ra nhà cung cấp từ link in trong hoá đơn.';

-- ─── 1. NewCA — nền tảng xcyber, có mã xác thực, ĐÃ KIỂM CHỨNG ──────────────
INSERT INTO einvoice_providers
       (tax_code, name, short_name, portal_url, portal_domain, code_label,
        lookup_adapter, lookup_enabled, lookup_api_base, note)
VALUES ('0106234569', 'CÔNG TY CỔ PHẦN NEWCA', 'NewCA',
        'https://tracuuhoadon.newca.vn/', 'tracuuhoadon.newca.vn', 'Mã số bí mật',
        'xcyber', true, 'https://mspapp.xcyber.vn',
        'Cổng có mã xác thực — ảnh hiện trên giao diện INVONE cho người dùng nhập. '
        'Không cần MST người bán.')
ON CONFLICT (tax_code) DO UPDATE SET
  short_name      = EXCLUDED.short_name,
  portal_url      = COALESCE(einvoice_providers.portal_url, EXCLUDED.portal_url),
  portal_domain   = COALESCE(einvoice_providers.portal_domain, EXCLUDED.portal_domain),
  code_label      = EXCLUDED.code_label,
  lookup_adapter  = EXCLUDED.lookup_adapter,
  lookup_enabled  = true,
  lookup_api_base = EXCLUDED.lookup_api_base,
  note            = EXCLUDED.note,
  updated_at      = NOW();

-- ─── 2. CyberLotus / CyberBill — cùng nền tảng xcyber, máy chủ riêng ────────
-- Hoá đơn của FastCA phát hành qua CyberBill nằm ở đây.
UPDATE einvoice_providers
   SET lookup_adapter  = 'xcyber',
       lookup_enabled  = true,
       lookup_api_base = 'https://bill1app.xcyber.vn',
       portal_url      = COALESCE(portal_url, 'https://tracuu.cyberbill.vn/'),
       portal_domain   = COALESCE(portal_domain, 'tracuu.cyberbill.vn'),
       note            = 'Nền tảng CyberLotus, API bill1app.xcyber.vn. Cổng có mã xác thực — '
                         'ảnh hiện trên giao diện INVONE cho người dùng nhập.',
       updated_at      = NOW()
 WHERE tax_code = '0105232093';

-- Cổng CyberBill còn phục vụ dưới tracuuhoadon1.xcyber.vn (đích của redirect) và
-- bill1app.xcyber.vn (máy chủ API) — cả hai đều gặp trong link in trên hoá đơn.
UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY['tracuuhoadon1.xcyber.vn', 'bill1app.xcyber.vn'],
       updated_at = NOW()
 WHERE tax_code = '0105232093';

-- ─── 3. NCCA / NCInvoice — nền tảng M-Invoice, KHÔNG mã xác thực ────────────
UPDATE einvoice_providers
   SET lookup_adapter  = 'minvoice',
       lookup_enabled  = true,
       -- Host RIÊNG của NCCA, không phải cổng M-Invoice trung tâm (đã tra thật ra PDF 390KB)
       lookup_api_base = 'https://tracuuhoadon.hddt-nc.vn',
       portal_url      = 'https://tracuuhoadon.hddt-nc.vn/',
       portal_domain   = 'tracuuhoadon.hddt-nc.vn',
       code_label      = 'Mã số bảo mật',
       note            = 'Cổng riêng của NCCA chạy trên nền tảng M-Invoice, cùng đường dẫn API. '
                         'Cần MST người bán + mã bảo mật — hệ thống tự điền cả hai, không có '
                         'mã xác thực.',
       updated_at      = NOW()
 WHERE tax_code = '0106166781';

-- M-Invoice (bên sở hữu nền tảng) dùng chung driver, bật luôn: hợp đồng tham số đã kiểm ở 068
UPDATE einvoice_providers
   SET lookup_adapter  = 'minvoice',
       lookup_enabled  = true,
       lookup_api_base = COALESCE(lookup_api_base, 'https://tracuuhoadon.minvoice.com.vn'),
       updated_at      = NOW()
 WHERE tax_code = '0106026495';

-- ─── 4. EFY iHoaDon — KHÔNG mã xác thực ở lần tra bình thường ───────────────
UPDATE einvoice_providers
   SET lookup_adapter    = 'efy',
       lookup_enabled    = true,
       lookup_api_base   = 'https://ihoadon.vn',
       lookup_api_path   = NULL,
       lookup_api_params = NULL,
       lookup_response   = NULL,
       portal_url        = 'https://ihoadon.vn/kiem-tra/',
       portal_domain     = 'ihoadon.vn',
       -- Trang EFY nhận sẵn mã tra cứu (mtc) và số hoá đơn (shd) trên URL — bấm một phát
       -- là biểu mẫu đã điền, người dùng chỉ còn tích reCAPTCHA nếu cổng đòi.
       lookup_url_template = 'https://ihoadon.vn/kiem-tra/?mtc={code}&shd={no}',
       note              = 'Cần số hoá đơn + mã tra cứu, hệ thống tự điền cả hai. Khi cổng bật '
                           'reCAPTCHA của Google (require_captcha=1) thì phải mở cổng EFY tự tra — '
                           'loại mã đó không nhập hộ được.',
       updated_at        = NOW()
 WHERE tax_code = '0102519041';

-- Tên miền cũ tracuu.ihoadon.vn vẫn in trên nhiều hoá đơn (redirect về ihoadon.vn)
UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY['tracuu.ihoadon.vn', 'efy.com.vn'],
       updated_at = NOW()
 WHERE tax_code = '0102519041';

-- NewCA: tên miền API cũng hay xuất hiện trong link tra cứu của hoá đơn cũ
UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY['mspapp.xcyber.vn', 'hddt.esamho.com'],
       updated_at = NOW()
 WHERE tax_code = '0106234569';

-- NCInvoice: hoá đơn cũ in tên miền của chính NCCA
UPDATE einvoice_providers
   SET portal_domain_aliases = ARRAY['nc-ca.com.vn', 'hddt-nc.vn'],
       updated_at = NOW()
 WHERE tax_code = '0106166781';

-- ─── 5. Viettel Telecom — hoá đơn bán hàng của chính Viettel ────────────────
UPDATE einvoice_providers
   SET lookup_adapter  = 'viettel-telecom',
       lookup_enabled  = true,
       lookup_api_base = 'https://apigami.viettel.vn/mvt-api/myviettel.php',
       -- Gỡ khuôn generic-query đoán sẵn ở 068 (sinvoice.viettel.vn) để khỏi hiểu nhầm
       lookup_api_path   = NULL,
       lookup_api_params = NULL,
       lookup_response   = NULL,
       portal_url      = COALESCE(portal_url, 'https://vietteltelecom.vn/hoadondientu'),
       portal_domain   = COALESCE(portal_domain, 'vietteltelecom.vn'),
       note            = 'Cổng vietteltelecom.vn/hoadondientu chỉ tra được hoá đơn do chính '
                         'Viettel Telecom phát hành (cước di động, internet…), không phải mọi '
                         'hoá đơn đi qua nền tảng S-Invoice. Cần số hoá đơn + mã số bí mật, '
                         'không có mã xác thực. Chưa xác nhận được hình dạng phản hồi khi tìm '
                         'thấy vì chưa có hoá đơn Viettel thật để thử.',
       updated_at      = NOW()
 WHERE tax_code = '0100109106';

-- ─── 6. Viet-Invoice và EasyInvoice: giữ nguyên, chỉ dùng lại ở lớp tương tác ─
-- Hai driver này đã được kiểm chứng ở 068/069; lớp tra cứu theo yêu cầu người dùng dùng
-- lại đúng adapter id nên không cần đổi cấu hình. EasyInvoice từ nay KHÔNG cần
-- TWO_CAPTCHA_API_KEY khi người dùng tự bấm tra cứu — ảnh captcha hiện thẳng trên giao diện.

-- ─── 7. Chỉ mục nhận diện ngược theo tên miền ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_einvoice_providers_lookup_domain
  ON einvoice_providers (portal_domain)
  WHERE lookup_adapter IS NOT NULL AND lookup_enabled = true;
