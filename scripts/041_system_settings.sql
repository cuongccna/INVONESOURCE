-- Migration 041: System Settings
-- Bảng cài đặt hệ thống — admin thay đổi live qua trang /admin/system-settings/
-- Giá trị được load vào Redis Hash `system:config` khi khởi động.
-- Thay đổi qua API → HSET + PUBLISH system:config:updated → in-memory update tức thì.

CREATE TABLE IF NOT EXISTS system_settings (
  key           TEXT        NOT NULL PRIMARY KEY,
  value         TEXT        NOT NULL,
  type          TEXT        NOT NULL CHECK (type IN ('number','string','boolean')),
  group_name    TEXT        NOT NULL,
  label         TEXT        NOT NULL,
  description   TEXT,
  example       TEXT,
  default_value TEXT        NOT NULL,
  unit          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_settings_group ON system_settings(group_name);

-- ─── Seed — Group: bot_safety ────────────────────────────────────────────────
INSERT INTO system_settings (key, value, type, group_name, label, description, example, default_value, unit) VALUES

('bot.max_concurrent_per_proxy_ip', '3', 'number', 'bot_safety',
 'Số session đồng thời tối đa trên mỗi proxy IP',
 'GDT rate-limit khoảng 20 request/phút/IP. Mỗi session sync cần ~10 request → 3 session ≈ 30 req/phút ≈ ngưỡng an toàn. Tăng lên 4-5 nếu proxy có băng thông riêng. Giảm xuống 2 nếu vẫn thấy 429.',
 '2 = rất an toàn | 3 = mặc định | 4-5 = proxy riêng/tốc độ cao',
 '3', 'count'),

('bot.max_consecutive_auth_failures', '5', 'number', 'bot_safety',
 'Số lần sai thông tin đăng nhập trước khi deactivate bot',
 'GDT khóa tài khoản sau khoảng 10 lần nhập sai liên tiếp (captcha sai + sai mật khẩu đều tính). Bot dừng ở 5 để tránh vào vùng nguy hiểm và thông báo user kiểm tra.',
 '3 = stop sớm | 5 = mặc định | 8 = không khuyến khích',
 '5', 'count'),

('bot.max_concurrent_companies', '3', 'number', 'bot_safety',
 'Số công ty xử lý song song trong detail worker',
 'Detail worker fetch chi tiết hóa đơn từ GDT. Quá nhiều request đồng thời từ cùng IP → 429. Giá trị 3 cho phép 3 công ty dùng cùng proxy IP đồng thời.',
 '2 = cẩn thận | 3 = mặc định | 5 = proxy riêng',
 '3', 'count'),

('bot.proxy_timeout_threshold', '3', 'number', 'bot_safety',
 'Số TCP timeout liên tiếp trước khi đánh dấu proxy lỗi và rotate',
 'Proxy bị block hoặc mạng chập chờn đều gây TCP timeout. Sau N lần timeout trên cùng proxy → rotate sang proxy khác để tránh stall.',
 '2 = nhạy | 3 = mặc định | 5 = ít nhạy',
 '3', 'count'),

('bot.max_proxy_rotations', '5', 'number', 'bot_safety',
 'Số lần rotate proxy trước khi thông báo user hết proxy pool',
 'Nếu rotate 5 lần vẫn không có proxy hoạt động → pool cạn kiệt hoặc tất cả bị block. Dừng và gửi thông báo user thêm proxy.',
 '3 = báo sớm | 5 = mặc định',
 '5', 'count'),

('bot.min_login_interval_ms', '300000', 'number', 'bot_safety',
 'Thời gian tối thiểu giữa hai lần đăng nhập GDT cùng một công ty (ms)',
 'Đăng nhập quá thường xuyên → GDT detect pattern bot → rate limit hoặc khóa tài khoản. 5 phút (300.000ms) là ngưỡng an toàn theo quan sát thực tế.',
 '60000 = 1 phút | 300000 = 5 phút (mặc định) | 600000 = 10 phút',
 '300000', 'ms'),

('bot.no_crawl_hour_start', '2', 'number', 'bot_safety',
 'Giờ bắt đầu cửa sổ không crawl (giờ VN, 0-23)',
 'GDT có maintenance window từ 2-4 giờ sáng. Crawl trong giờ này thường trả 503 hoặc timeout → tốn quota proxy + 2Captcha vô ích.',
 '0 = nửa đêm | 2 = mặc định',
 '2', 'hour'),

('bot.no_crawl_hour_end', '4', 'number', 'bot_safety',
 'Giờ kết thúc cửa sổ không crawl (giờ VN, 0-23)',
 'Bot sẽ resume sau giờ này. Kết hợp với no_crawl_hour_start để định nghĩa sleep window.',
 '4 = mặc định | 6 = nghỉ dài hơn',
 '4', 'hour'),

-- ─── Group: queue ────────────────────────────────────────────────────────────

('bot.auto_sync_interval_ms', '300000', 'number', 'queue',
 'Chu kỳ scheduler auto-sync (ms)',
 'Cứ mỗi N ms, scheduler kiểm tra DB và enqueue các công ty đến hạn sync. 5 phút (300.000ms) đủ để công ty vừa sync xong có thể nghỉ trước lượt tiếp theo.',
 '60000 = 1 phút | 300000 = 5 phút (mặc định) | 900000 = 15 phút',
 '300000', 'ms'),

('bot.auto_sync_companies_per_cycle', '15', 'number', 'queue',
 'Số công ty tối đa enqueue mỗi chu kỳ auto-sync',
 'Giới hạn số lượng job được thêm vào queue mỗi lần scheduler chạy. Tránh queue bị tràn khi hệ thống có nhiều công ty đến hạn cùng lúc.',
 '5 = cẩn thận | 15 = mặc định | 30 = nhiều proxy/server mạnh',
 '15', 'count'),

('bot.dispatch_jitter_max_ms', '480000', 'number', 'queue',
 'Jitter ngẫu nhiên tối đa khi dispatch auto-sync (ms)',
 'Mỗi job auto-sync được delay thêm 0 đến N ms ngẫu nhiên trước khi chạy. Trải đều 15 công ty qua 8 phút → tối đa 2 công ty đồng thời trên cùng proxy IP.',
 '180000 = 3 phút | 480000 = 8 phút (mặc định) | 600000 = 10 phút',
 '480000', 'ms'),

('bot.auto_queue_backoff_delay_ms', '120000', 'number', 'queue',
 'Backoff ban đầu của queue auto-sync sau khi job lỗi (ms)',
 'Khi job lỗi và retry, BullMQ tính delay theo công thức exponential: delay × 2^(attempt-1). Base 2 phút → retry lần 1 sau 2 phút, lần 2 sau 4 phút, ...',
 '60000 = 1 phút | 120000 = 2 phút (mặc định) | 300000 = 5 phút',
 '120000', 'ms'),

('bot.manual_queue_backoff_delay_ms', '300000', 'number', 'queue',
 'Backoff ban đầu của queue manual-sync sau khi job lỗi (ms)',
 'Manual sync do user trigger → timeout dài hơn auto. Base 5 phút cho phép GDT phục hồi trước khi retry. Không nên quá ngắn vì user đang đợi.',
 '120000 = 2 phút | 300000 = 5 phút (mặc định)',
 '300000', 'ms'),

('bot.auto_sync_skip_failures_threshold', '3', 'number', 'queue',
 'Số consecutive_failures tối đa trước khi scheduler bỏ qua công ty',
 'Nếu công ty liên tục lỗi, scheduler tạm thời bỏ qua để không lãng phí job slot. Sau khi admin kiểm tra và fix lỗi, reset consecutive_failures về 0 để resume.',
 '2 = bỏ qua sớm | 3 = mặc định | 5 = kiên nhẫn hơn',
 '3', 'count'),

('bot.manual_sync_serial_delay_ms', '2400000', 'number', 'queue',
 'Thời gian chờ giữa hai lần manual sync liên tiếp của cùng một user (ms)',
 '40 phút (2.400.000ms) ngăn user spam nút sync. GDT ghi nhận pattern đăng nhập liên tục từ cùng IP/account → có thể throttle hoặc yêu cầu CAPTCHA khó hơn.',
 '600000 = 10 phút | 2400000 = 40 phút (mặc định)',
 '2400000', 'ms'),

('bot.stale_run_grace_ms', '15000', 'number', 'queue',
 'Grace period trước khi đánh dấu một bot run là stale (ms)',
 'Khi bot run vừa tạo, cần vài giây để worker nhận job và cập nhật trạng thái. 15s grace tránh mark stale quá sớm.',
 '5000 = 5 giây | 15000 = 15 giây (mặc định) | 30000 = 30 giây',
 '15000', 'ms'),

-- ─── Group: circuit_breaker ──────────────────────────────────────────────────

('bot.global_cb_trip_count', '20', 'number', 'circuit_breaker',
 'Số lỗi structural để trip global circuit breaker',
 'Nếu hệ thống gặp 20 lỗi structural (không phải auth) trong vòng 1 giờ → tất cả sync dừng để tránh hammering GDT khi có sự cố lớn (GDT maintenance, network outage).',
 '10 = nhạy | 20 = mặc định | 50 = chịu đựng hơn',
 '20', 'count'),

('bot.global_cb_ttl_sec', '3600', 'number', 'circuit_breaker',
 'Cửa sổ thời gian tính lỗi cho global circuit breaker (giây)',
 'Lỗi cũ hơn N giây không được tính vào circuit breaker. 3600s = 1 giờ là window hợp lý để phân biệt lỗi tạm thời với outage thực sự.',
 '1800 = 30 phút | 3600 = 1 giờ (mặc định)',
 '3600', 'seconds'),

('bot.per_company_cb_threshold', '12', 'number', 'circuit_breaker',
 'Số HTTP 500 để trip circuit breaker per-company',
 '12 lỗi HTTP 500 trong cửa sổ 15 phút → GDT đang có vấn đề với công ty này (account suspended, data issue). Bot tạm dừng công ty đó 5 phút rồi thử lại.',
 '5 = nhạy | 12 = mặc định | 20 = chịu đựng',
 '12', 'count'),

('bot.per_company_cb_window_ms', '900000', 'number', 'circuit_breaker',
 'Cửa sổ thời gian tính lỗi per-company (ms)',
 '15 phút (900.000ms). Lỗi cũ hơn 15 phút không tính vào CB counter.',
 '300000 = 5 phút | 900000 = 15 phút (mặc định)',
 '900000', 'ms'),

('bot.per_company_cb_cooldown_ms', '300000', 'number', 'circuit_breaker',
 'Thời gian pause per-company sau khi CB trip (ms)',
 'Sau khi CB trip, bot chờ 5 phút rồi thử một lần (HALF_OPEN). Nếu thành công → CLOSED. Nếu vẫn lỗi → OPEN thêm 5 phút nữa.',
 '60000 = 1 phút | 300000 = 5 phút (mặc định)',
 '300000', 'ms'),

('connector.cb_failure_threshold', '3', 'number', 'circuit_breaker',
 'Số lỗi để trip circuit breaker của connector MISA/Viettel/BKAV',
 'Connector CB bảo vệ provider API (không phải GDT). 3 lỗi liên tiếp → OPEN → 60s cooldown → thử lại.',
 '2 = nhạy | 3 = mặc định | 5 = kiên nhẫn',
 '3', 'count'),

('connector.cb_cooldown_ms', '60000', 'number', 'circuit_breaker',
 'Transient cooldown của connector CB sau khi trip (ms)',
 '60s cooldown cho lỗi mạng tạm thời (timeout, 503). Connector sẽ thử lại sau 60s.',
 '30000 = 30s | 60000 = 1 phút (mặc định) | 300000 = 5 phút',
 '60000', 'ms'),

('connector.cb_auth_cooldown_ms', '86400000', 'number', 'circuit_breaker',
 'Cooldown của connector CB sau khi xác thực thất bại (ms)',
 '24h lockout cho lỗi auth (sai credentials MISA/Viettel). Không retry liên tục vì provider có thể khóa tài khoản.',
 '3600000 = 1 giờ | 86400000 = 24 giờ (mặc định)',
 '86400000', 'ms'),

-- ─── Group: anti_detection ───────────────────────────────────────────────────

('bot.jitter_every_n_invoices', '10', 'number', 'anti_detection',
 'Inject jitter sau mỗi N hóa đơn',
 'Giả lập hành vi người dùng: dừng lại để "đọc" sau mỗi N hóa đơn. Pattern đều đặn sẽ bị GDT detect là bot.',
 '5 = dừng thường xuyên | 10 = mặc định | 20 = ít dừng',
 '10', 'count'),

('bot.jitter_min_ms', '1200', 'number', 'anti_detection',
 'Jitter tối thiểu giữa các trang hóa đơn (ms)',
 'Delay ngẫu nhiên từ jitter_min đến jitter_max ms giữa mỗi request. Quá thấp → pattern cơ học. Quá cao → sync chậm.',
 '500 = nhanh | 1200 = mặc định | 3000 = chậm',
 '1200', 'ms'),

('bot.jitter_max_ms', '2500', 'number', 'anti_detection',
 'Jitter tối đa giữa các trang hóa đơn (ms)',
 'Phải lớn hơn jitter_min_ms. Khoảng cách min-max lớn hơn = pattern tự nhiên hơn.',
 '2000 = mặc định | 3000 = thận trọng',
 '2500', 'ms'),

('bot.read_pause_every_min', '25', 'number', 'anti_detection',
 'Pause dài sau ít nhất N hóa đơn',
 'Sau khi đã xem read_pause_every_min đến read_pause_every_max hóa đơn → inject một pause dài (vài giây) giả lập người dùng đang đọc/xem xét.',
 '15 = dừng thường | 25 = mặc định | 50 = ít dừng',
 '25', 'count'),

('bot.read_pause_every_max', '40', 'number', 'anti_detection',
 'Pause dài sau nhiều nhất N hóa đơn',
 'Phải lớn hơn read_pause_every_min. Khoảng ngẫu nhiên [min, max] tạo sự không đều.',
 '40 = mặc định | 60 = ít dừng',
 '40', 'count'),

('bot.read_pause_min_ms', '3000', 'number', 'anti_detection',
 'Thời gian pause dài tối thiểu (ms)',
 '3s là thời gian tối thiểu một người cần để "liếc qua" một danh sách hóa đơn.',
 '2000 = nhanh | 3000 = mặc định | 5000 = chậm',
 '3000', 'ms'),

('bot.read_pause_max_ms', '10000', 'number', 'anti_detection',
 'Thời gian pause dài tối đa (ms)',
 '10s là thời gian thực tế để đọc qua 1-2 hóa đơn. Giá trị cao hơn → nhìn tự nhiên hơn nhưng sync lâu hơn.',
 '8000 = mặc định | 15000 = thận trọng',
 '10000', 'ms'),

-- ─── Group: gdt_api ──────────────────────────────────────────────────────────

('gdt.page_size', '50', 'number', 'gdt_api',
 'Số hóa đơn tối đa mỗi trang khi query GDT',
 'GDT API cho phép tối đa 50 rows/page. Giảm xuống 20-30 nếu GDT thường xuyên timeout trên response lớn.',
 '20 = nhỏ/an toàn | 50 = tối đa (mặc định)',
 '50', 'count'),

('gdt.request_timeout_ms', '30000', 'number', 'gdt_api',
 'Default axios timeout cho tất cả request GDT (ms)',
 '30s đủ cho các API list thông thường. Các endpoint binary (XML/XLSX) dùng gdt.binary_timeout_ms riêng.',
 '15000 = nhanh thất bại | 30000 = mặc định | 60000 = kiên nhẫn',
 '30000', 'ms'),

('gdt.binary_timeout_ms', '120000', 'number', 'gdt_api',
 'Timeout cho download file XML/XLSX từ GDT (ms)',
 'XML hóa đơn có thể lớn đến vài MB. Download qua proxy với mạng chậm cần 60-120s.',
 '60000 = 1 phút | 120000 = 2 phút (mặc định)',
 '120000', 'ms'),

('gdt.validate_rate_ms', '2000', 'number', 'gdt_api',
 'Thời gian chờ giữa hai request validation GDT (ms)',
 'GDT Validation API (hoadondientu.gdt.gov.vn) có rate limit khoảng 30 req/phút. 1 req/2s = 30 req/phút = đúng ngưỡng. Tăng lên 3000ms nếu bị 429.',
 '1000 = nhanh/rủi ro | 2000 = mặc định | 3000 = an toàn',
 '2000', 'ms'),

('gdt.peak_start_day', '18', 'number', 'gdt_api',
 'Ngày bắt đầu peak period hàng tháng',
 'Từ ngày 18-25 hàng tháng là deadline nộp thuế VAT. GDT bị overload → timeout cao hơn nhiều. Bot tự động tăng timeout theo gdt.peak_timeout_multiplier.',
 '15 = sớm | 18 = mặc định | 20 = trễ',
 '18', 'day'),

('gdt.peak_end_day', '25', 'number', 'gdt_api',
 'Ngày kết thúc peak period hàng tháng',
 'Ngày 20 là hạn nộp thuế hàng tháng (TT80/2021). Ngày 25 là hạn cho doanh nghiệp khai theo quý. Bot giữ timeout cao đến ngày 25.',
 '22 = ngắn | 25 = mặc định | 28 = thận trọng',
 '25', 'day'),

('gdt.peak_timeout_multiplier', '6.0', 'number', 'gdt_api',
 'Hệ số nhân timeout khi đang trong peak period',
 'Trong peak (ngày 18-25), timeout × 6.0. VD: endpoint 30s → 180s. Quan sát thực tế GDT có thể mất 90-120s để phản hồi trong peak.',
 '3.0 = nhẹ | 6.0 = mặc định | 10.0 = rất kiên nhẫn',
 '6.0', 'ratio'),

('gdt.peak_max_retries', '5', 'number', 'gdt_api',
 'Số lần retry tối đa trong peak period',
 'Ngoài peak: 3 retries. Trong peak GDT hay timeout rồi phục hồi → tăng lên 5 để tận dụng lần cuối.',
 '3 = ngoài peak | 5 = mặc định peak | 7 = rất kiên nhẫn',
 '5', 'count'),

('gdt.captcha_timeout_ms', '15000', 'number', 'gdt_api',
 'Timeout lấy CAPTCHA từ GDT (ms)',
 'CAPTCHA endpoint GDT thường nhanh (< 5s). 15s đủ để xử lý trường hợp GDT chậm.',
 '8000 = nhanh | 15000 = mặc định | 30000 = thận trọng',
 '15000', 'ms'),

('gdt.login_timeout_ms', '20000', 'number', 'gdt_api',
 'Timeout bước authenticate GDT (ms)',
 'Login GDT gồm 2 bước: submit credentials + verify CAPTCHA. 20s đủ cho cả 2 bước kể cả khi GDT chậm.',
 '10000 = nhanh | 20000 = mặc định | 45000 = peak',
 '20000', 'ms'),

-- ─── Group: business_rules ───────────────────────────────────────────────────

('vat.cash_threshold_vnd', '5000000', 'number', 'business_rules',
 'Ngưỡng tiền mặt không được khấu trừ VAT (VND)',
 'NĐ181/2025 Điều 26: hóa đơn đầu vào thanh toán bằng tiền mặt từ 5 triệu VND trở lên KHÔNG được khấu trừ thuế VAT. Đây là quy định pháp luật → chỉ thay đổi khi có Nghị định mới.',
 '5000000 = theo NĐ181/2025 (hiện hành)',
 '5000000', 'VND'),

('vat.high_value_threshold_vnd', '20000000', 'number', 'business_rules',
 'Ngưỡng hóa đơn giá trị cao dùng cho dashboard và AI (VND)',
 'Hóa đơn > 20 triệu VND được highlight trong dashboard và được AI phân tích kỹ hơn. Không phải quy định pháp luật — có thể điều chỉnh theo nhu cầu doanh nghiệp.',
 '10000000 = 10 triệu | 20000000 = 20 triệu (mặc định) | 50000000 = 50 triệu',
 '20000000', 'VND'),

('tax.filing_deadline_day', '20', 'number', 'business_rules',
 'Ngày nộp thuế VAT hàng tháng (ngày trong tháng)',
 'TT80/2021: hạn nộp tờ khai 01/GTGT là ngày 20 tháng sau. Hệ thống sẽ gửi nhắc nhở trước ngày này.',
 '20 = theo TT80/2021 (hiện hành)',
 '20', 'day'),

('tax.remind_days_before_first', '7', 'number', 'business_rules',
 'Nhắc nhở lần 1 trước hạn nộp thuế (số ngày)',
 '7 ngày trước hạn → gửi thông báo đầu tiên để chuẩn bị hồ sơ, kiểm tra hóa đơn đầu vào còn thiếu không.',
 '7 = mặc định | 14 = nhắc sớm hơn',
 '7', 'days'),

('tax.remind_days_before_second', '2', 'number', 'business_rules',
 'Nhắc nhở lần 2 trước hạn nộp thuế (số ngày)',
 '2 ngày trước hạn → nhắc khẩn để nộp kịp thời. Kết hợp với remind_days_before_first tạo thành 2 lượt nhắc.',
 '1 = gấp | 2 = mặc định | 3 = thoải mái',
 '2', 'days'),

('license.free_tier_monthly_quota', '100', 'number', 'business_rules',
 'Số hóa đơn sync mỗi tháng cho tài khoản miễn phí',
 '100 hóa đơn/tháng đủ cho SME nhỏ để dùng thử. Khi vượt quota → hệ thống báo và không sync thêm cho đến khi upgrade hoặc sang tháng mới.',
 '50 = rất hạn chế | 100 = mặc định | 500 = thoải mái',
 '100', 'count'),

('audit.ghost_name_similarity', '0.4', 'number', 'business_rules',
 'Ngưỡng tương đồng tên công ty để cảnh báo NAME_MISMATCH (%)',
 'Nếu tên công ty trên hóa đơn khác < 40% so với tên đăng ký GDT → flag NAME_MISMATCH (nghi ngờ công ty ma). Sử dụng thuật toán Jaro-Winkler.',
 '0.3 = nhạy | 0.4 = mặc định | 0.6 = ít nhạy',
 '0.4', 'ratio'),

('audit.ghost_new_company_months', '6', 'number', 'business_rules',
 'Tuổi công ty tối đa (tháng) để cảnh báo NEW_COMPANY_BIG_INV',
 'Công ty mới thành lập dưới 6 tháng mà đã có hóa đơn lớn → dấu hiệu công ty ma (thành lập nhanh, gian lận VAT). Kiểm tra kết hợp với audit.ghost_new_company_invoice_vnd.',
 '3 = rất mới | 6 = mặc định | 12 = 1 năm',
 '6', 'months'),

('audit.ghost_new_company_invoice_vnd', '50000000', 'number', 'business_rules',
 'Ngưỡng hóa đơn của công ty mới để cảnh báo (VND)',
 'Công ty < 6 tháng tuổi mà có hóa đơn > 50 triệu VND → flag để kiểm tra. Giá trị nhỏ hơn → nhiều cảnh báo hơn.',
 '20000000 = 20 triệu | 50000000 = 50 triệu (mặc định) | 100000000 = 100 triệu',
 '50000000', 'VND'),

('audit.split_invoice_threshold', '3', 'number', 'business_rules',
 'Số hóa đơn/ngày từ cùng đối tác để cảnh báo chia nhỏ hóa đơn',
 'Giao dịch bị chia thành nhiều hóa đơn nhỏ để tránh ngưỡng 20 triệu VND (tiền mặt) → gian lận khấu trừ VAT. 3 hóa đơn/ngày từ cùng đối tác → flag.',
 '2 = nhạy | 3 = mặc định | 5 = ít nhạy',
 '3', 'count')

,

-- ─── Thêm sau migration 041: Manual rate limit per user ──────────────────────
('bot.manual_rate_limit_tokens_per_hour', '10', 'number', 'bot_safety',
 'Số lần sync thủ công tối đa mỗi giờ (gói pro)',
 'Token bucket: mỗi giờ refill N token. User spam nút Lấy hóa đơn sẽ bị block khi hết token. free=3/giờ, pro=10/giờ, enterprise=30/giờ.',
 '3 = free | 10 = pro (mặc định) | 30 = enterprise',
 '10', 'count/hour'),

('bot.manual_rate_limit_burst_max', '5', 'number', 'bot_safety',
 'Burst tối đa khi user mới bắt đầu (token bucket burst)',
 'Khi user lần đầu sync hoặc đã nghỉ lâu, cho phép burst N lần liên tiếp trước khi áp rate limit. Tránh trải nghiệm tệ khi setup lần đầu.',
 '3 = thắt chặt | 5 = mặc định | 10 = enterprise',
 '5', 'count')

ON CONFLICT (key) DO NOTHING;
