-- Migration 068: Plugin tải bản gốc PDF từ cổng tra cứu công khai của nhà cung cấp
--
-- BỐI CẢNH
--   Cổng thuế chỉ có XML ký số + bản thể hiện theo MẪU CHUNG CỦA CỔNG THUẾ (đã kiểm:
--   invoice.html trong gói ZIP không chứa logo hay ảnh của nhà cung cấp nào). Bản PDF
--   mang thương hiệu nhà cung cấp chỉ nằm trên cổng tra cứu của chính họ, mở bằng
--   "Mã tra cứu" in trên hoá đơn.
--
--   Migration này thêm phần cấu hình cho lớp plugin ở bot/src/providers/lookup.
--   Bật/tắt từng nhà cung cấp, đổi endpoint, thêm nhà cung cấp mới — đều làm bằng SQL,
--   không cần deploy lại. Tắt hết thì hệ thống chạy y như trước khi có tính năng này.
--
-- Additive + idempotent.

ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_adapter        TEXT;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_enabled        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_api_base       TEXT;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_api_path       TEXT;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_api_params     JSONB;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_response       TEXT;
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS lookup_file_url_field TEXT;

COMMENT ON COLUMN einvoice_providers.lookup_adapter IS
  'Plugin xử lý cổng này: vietinvoice | minvoice | generic-query. NULL = chưa có plugin.';
COMMENT ON COLUMN einvoice_providers.lookup_enabled IS
  'Công tắc từng nhà cung cấp. Mặc định false — chỉ bật sau khi đã gọi thật và lấy được PDF.';
COMMENT ON COLUMN einvoice_providers.lookup_api_params IS
  'Tham số cho adapter generic-query, dạng {"ten_tham_so":"{code}"}. '
  'Chỗ thay thế: {code} mã tra cứu, {mst} MST người bán, {serial} ký hiệu, {no} số hoá đơn.';

-- ─── 1. Viet-Invoice (ICORP) — ĐÃ KIỂM CHỨNG, BẬT ──────────────────────────
--
-- Gọi thật ngày 26/08/2026 với hoá đơn 1C26TDL-1912:
--   GET /api/v1/misc/find-by-lookup-code?lookupCode=…   → JSON thông tin hoá đơn
--   GET /api/v1/misc/export-by-lookup-code?lookupCode=… → {"fileURL":"…invoice_0106870211_2j7vtq.pdf"}
--   GET fileURL                                          → PDF đúng bản người dùng tải tay
UPDATE einvoice_providers
   SET lookup_adapter = 'vietinvoice',
       lookup_enabled = true,
       updated_at     = NOW()
 WHERE tax_code = '0106870211';

-- ─── 2. M-Invoice — hợp đồng tham số đã kiểm, CHƯA lấy được PDF thật ────────
--
--   GET {base}/api/Search/SearchInvoice?masothue=&sobaomat=&type=PDF&inchuyendoi=false
--   Thiếu type → HTTP 400 nêu đúng tên trường; sai cặp MST/mã → HTTP 500 code 5000.
--   Chưa bật vì chưa có hoá đơn nào nằm trên cổng trung tâm để xác nhận đầu ra là PDF.
UPDATE einvoice_providers
   SET lookup_adapter  = 'minvoice',
       lookup_api_base = 'https://tracuuhoadon.minvoice.com.vn',
       lookup_enabled  = false,
       note            = COALESCE(note, '') ||
                         ' | Plugin minvoice đã cấu hình, chờ xác minh trên hoá đơn thật rồi bật',
       updated_at      = NOW()
 WHERE tax_code = '0106026495';

-- NCCA phát hành qua nền tảng M-Invoice nhưng hoá đơn KHÔNG nằm trên cổng trung tâm
-- (đã thử: HTTP 500 "Thông tin tra cứu không chính xác"), và host riêng
-- 0106166781hd.minvoice.com.vn không mở endpoint tra cứu (404). Ghi lại để khỏi dò lại.
UPDATE einvoice_providers
   SET note       = 'Hoá đơn phát hành trên nền tảng M-Invoice. Chưa tìm được endpoint tra cứu '
                    'công khai: cổng trung tâm không có dữ liệu của NCCA, host riêng không mở API. '
                    'Dùng mã tra cứu trên giao diện.',
       updated_at = NOW()
 WHERE tax_code = '0106166781';

-- ─── 3. Năm nhà cung cấp lớn — khai bằng adapter generic-query, MẶC ĐỊNH TẮT ─
--
-- Khuôn gọi để sẵn theo dạng phổ biến nhất (mã tra cứu + MST người bán → PDF).
-- CHƯA bật: phải kiểm chứng bằng một hoá đơn thật của từng bên rồi mới bật, vì bật nhầm
-- endpoint chỉ tạo request rác chứ không lấy được file. Bật bằng đúng một câu UPDATE.
UPDATE einvoice_providers SET
    lookup_adapter        = 'generic-query',
    lookup_enabled        = false,
    lookup_api_base       = 'https://www.meinvoice.vn',
    lookup_api_path       = '/tra-cuu/api/invoice/download',
    lookup_api_params     = '{"code":"{code}","taxCode":"{mst}","type":"PDF"}'::jsonb,
    lookup_response       = 'pdf',
    updated_at            = NOW()
 WHERE tax_code = '0101243150' AND lookup_adapter IS NULL;   -- MISA meInvoice

UPDATE einvoice_providers SET
    lookup_adapter        = 'generic-query',
    lookup_enabled        = false,
    lookup_api_base       = 'https://sinvoice.viettel.vn',
    lookup_api_path       = '/tracuuhoadon/api/invoice/download',
    lookup_api_params     = '{"secretCode":"{code}","supplierTaxCode":"{mst}","fileType":"PDF"}'::jsonb,
    lookup_response       = 'pdf',
    updated_at            = NOW()
 WHERE tax_code = '0100109106' AND lookup_adapter IS NULL;   -- Viettel S-Invoice

UPDATE einvoice_providers SET
    lookup_adapter        = 'generic-query',
    lookup_enabled        = false,
    lookup_api_base       = 'https://hoadondientu.vnpt.vn',
    lookup_api_path       = '/api/invoice/download',
    lookup_api_params     = '{"code":"{code}","taxCode":"{mst}","type":"PDF"}'::jsonb,
    lookup_response       = 'pdf',
    updated_at            = NOW()
 WHERE tax_code = '0100684378' AND lookup_adapter IS NULL;   -- VNPT Invoice

UPDATE einvoice_providers SET
    lookup_adapter        = 'generic-query',
    lookup_enabled        = false,
    lookup_api_base       = 'https://van.ehoadon.vn',
    lookup_api_path       = '/api/invoice/download',
    lookup_api_params     = '{"code":"{code}","taxCode":"{mst}","type":"PDF"}'::jsonb,
    lookup_response       = 'pdf',
    updated_at            = NOW()
 WHERE tax_code = '0101360697' AND lookup_adapter IS NULL;   -- BKAV eHoadon

UPDATE einvoice_providers SET
    lookup_adapter        = 'generic-query',
    lookup_enabled        = false,
    lookup_api_base       = 'https://ihoadon.vn',
    lookup_api_path       = '/api/invoice/download',
    lookup_api_params     = '{"code":"{code}","taxCode":"{mst}","type":"PDF"}'::jsonb,
    lookup_response       = 'pdf',
    updated_at            = NOW()
 WHERE tax_code = '0102519041' AND lookup_adapter IS NULL;   -- EFY iHoaDon

-- ─── 4. Bổ sung danh bạ: hai tên lớn chưa có ────────────────────────────────
-- MST tra từ hồ sơ doanh nghiệp công khai; cổng tra cứu lấy từ trang chính thức.
INSERT INTO einvoice_providers (tax_code, name, short_name, portal_url, portal_domain, code_label, note) VALUES
  ('0104128565', 'CÔNG TY TNHH HỆ THỐNG THÔNG TIN FPT', 'FPT.eInvoice',
   'https://tracuuhoadon.fpt.com.vn/search.html', 'tracuuhoadon.fpt.com.vn', 'Mã tra cứu', NULL),
  ('0101300842', 'CÔNG TY TNHH PHÁT TRIỂN CÔNG NGHỆ THÁI SƠN', 'E-invoice (Thái Sơn)',
   'https://einvoice.vn/', 'einvoice.vn', 'Mã tra cứu',
   'Nhiều khách hàng lớn dùng cổng riêng dạng <tên>.einvoice.com.vn — ưu tiên link in trong hoá đơn')
ON CONFLICT (tax_code) DO NOTHING;

-- ─── 5. Công tắc và hạn mức, chỉnh live ở trang Cài đặt hệ thống ────────────
INSERT INTO system_settings (key, value, type, group_name, label, description, example, default_value, unit) VALUES

('provider_lookup.enabled', 'true', 'boolean', 'provider_lookup',
 'Bật tải bản gốc PDF từ cổng nhà cung cấp',
 'Tắt là dừng ngay toàn bộ việc gọi ra cổng tra cứu của nhà cung cấp. Mọi phần khác của hệ thống không bị ảnh hưởng — hoá đơn vẫn có XML ký số và bản thể hiện của cổng thuế như cũ.',
 'true = bật | false = tắt hẳn',
 'true', NULL),

('provider_lookup.timeout_ms', '45000', 'number', 'provider_lookup',
 'Thời gian tối đa cho một lần tra cứu',
 'Quá thời gian này thì bỏ, ghi lỗi và đi tiếp. Cổng nhà cung cấp chậm không được phép giữ hàng đợi hoá đơn lại.',
 '30000 = chặt | 45000 = mặc định | 60000 = nới',
 '45000', 'ms'),

('provider_lookup.total_budget_ms', '90000', 'number', 'provider_lookup',
 'Trần thời gian cho cả bước lấy PDF nhà cung cấp của một hoá đơn',
 'Bao gồm cả đường API có tài khoản lẫn đường cổng công khai. Chạm trần là bỏ qua hoá đơn đó, hàng đợi XML chạy tiếp.',
 '60000 = chặt | 90000 = mặc định',
 '90000', 'ms'),

('provider_lookup.min_interval_ms', '4000', 'number', 'provider_lookup',
 'Khoảng cách tối thiểu giữa hai request vào cùng một cổng',
 'Giãn nhịp để không đập dồn vào hệ thống của nhà cung cấp — vừa lịch sự vừa tránh bị chặn IP.',
 '2000 = nhanh | 4000 = mặc định | 8000 = rất thận trọng',
 '4000', 'ms'),

('provider_lookup.breaker_failures', '5', 'number', 'provider_lookup',
 'Số lần lỗi liên tiếp trước khi ngắt mạch một cổng',
 'Cổng nhà cung cấp lỗi liên tiếp đủ số lần này thì ngừng gọi trong một khoảng nghỉ, thay vì thử lại vô ích trên từng hoá đơn.',
 '3 = nhạy | 5 = mặc định | 10 = ít nhạy',
 '5', 'count'),

('provider_lookup.breaker_cooldown_ms', '900000', 'number', 'provider_lookup',
 'Thời gian nghỉ sau khi ngắt mạch một cổng',
 'Hết khoảng này hệ thống tự thử lại cổng đó. Không cần can thiệp tay.',
 '300000 = 5 phút | 900000 = 15 phút mặc định',
 '900000', 'ms')

ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_einvoice_providers_lookup_enabled
  ON einvoice_providers (tax_code) WHERE lookup_enabled = true;
