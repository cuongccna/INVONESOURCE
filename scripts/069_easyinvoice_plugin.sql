-- Migration 069: Bật plugin EasyInvoice (SoftDreams) + ghi nhận kết quả dò các cổng còn lại
--
-- EasyInvoice — ĐÃ KIỂM CHỨNG bằng hoá đơn thật C26TGJ-3213 (mã 2I2I8GLZM):
--   GET  /Search/Index   → mở session
--   GET  /Captcha/Show   → ảnh captcha PNG của session đó (giải bằng 2Captcha)
--   POST /Search/Search  FKey=<mã>&Capcha=<lời giải>
--        → ô ẩn InvData chứa JSON, trường "str" là HTML bản thể hiện theo mẫu nhà cung cấp
--   Runner render HTML đó thành PDF bằng Chromium.
--
-- Cổng của EasyInvoice là RIÊNG THEO TỪNG NGƯỜI BÁN (http://<MST>hd.easyinvoice.com.vn),
-- địa chỉ nằm ngay trong hoá đơn ở trường PortalLink — nên không đặt lookup_api_base.
UPDATE einvoice_providers
   SET lookup_adapter = 'easyinvoice',
       lookup_enabled = true,
       note           = 'Cổng tra cứu riêng theo từng người bán — link ở trường PortalLink '
                        'trong hoá đơn. Cần TWO_CAPTCHA_API_KEY để giải mã xác thực.',
       updated_at     = NOW()
 WHERE tax_code = '0105987432';

-- ─── Ghi lại kết quả dò để lần sau không mất công lặp lại ───────────────────
--
-- CyberLotus (CyberBill): API công khai https://bill1app.xcyber.vn
--   POST /api/services/hddt/TraCuuHoaDon/RefreshCaptcha → {key, image}
--   POST /api/services/hddt/TraCuuHoaDon/TraCuu         → captcha qua được, nhưng mã tra cứu
--        của hoá đơn đang có không nằm trên instance này ("Lỗi phát sinh").
--        Cần xác định đúng instance của người bán trước khi bật.
UPDATE einvoice_providers
   SET note = 'API công khai: bill1app.xcyber.vn (RefreshCaptcha → TraCuu → DownloadPdf), có '
              'captcha. Mã tra cứu hiện có không nằm trên instance tracuuhoadon1 — cần xác '
              'định đúng instance của người bán rồi mới bật.',
       updated_at = NOW()
 WHERE tax_code = '0105232093';

-- VNPT / BKAV / EFY / MISA: hoá đơn của các bên này KHÔNG kèm mã tra cứu trong XML nên
-- không có gì để tra. Gỡ cấu hình generic-query đoán sẵn để khỏi hiểu nhầm là sắp dùng được.
UPDATE einvoice_providers
   SET lookup_adapter    = NULL,
       lookup_enabled    = false,
       lookup_api_base   = NULL,
       lookup_api_path   = NULL,
       lookup_api_params = NULL,
       lookup_response   = NULL,
       note = COALESCE(NULLIF(note, ''), '') ||
              CASE WHEN COALESCE(note,'') = '' THEN '' ELSE ' | ' END ||
              'Hoá đơn của nhà cung cấp này không kèm mã tra cứu trong XML của cổng thuế, '
              'nên không thể tải tự động — người dùng phải xin file từ người bán.',
       updated_at = NOW()
 WHERE tax_code IN ('0100684378', '0101360697', '0102519041', '0101243150');
