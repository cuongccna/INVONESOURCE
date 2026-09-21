-- Migration 065: Mở rộng nhận diện mã / link tra cứu + sửa danh bạ nhà cung cấp
--
-- Bối cảnh: sau khi chạy 064 trên dữ liệu thật, thống kê tên trường trong <TTKhac>
-- cho thấy mỗi nhà cung cấp đặt tên một kiểu, và bộ nhận diện cũ bỏ sót phần lớn:
--
--   "Mã tra cứu"    — M-Invoice, Win Tech Solution   (đã nhận được)
--   "Mã số bí mật"  — Viettel S-Invoice              (đã nhận được)
--   "MaTraCuu"      — CyberLotus                     (BỎ SÓT: viết liền, không dấu)
--   "Fkey"          — SoftDreams / EasyInvoice       (BỎ SÓT)
--   "PortalLink"    — SoftDreams / EasyInvoice       (link tra cứu, cổng riêng theo
--                                                     từng người bán: <MST>hd.easyinvoice.com.vn)
--
-- Additive + idempotent.

-- ─── 1. Sửa danh bạ ─────────────────────────────────────────────────────────
--
-- MST 0106026495 trong migration 060 bị gán nhầm là "NCCA" kèm cổng nc-ca.com.vn.
-- Tra cổng thuế: MST này là CÔNG TY TNHH HÓA ĐƠN ĐIỆN TỬ M-INVOICE — khác đơn vị.
-- Trả lại tên đúng và bỏ cổng tra cứu sai (thà không có link còn hơn chỉ sai chỗ).
UPDATE einvoice_providers
   SET name          = 'CÔNG TY TNHH HÓA ĐƠN ĐIỆN TỬ M-INVOICE',
       short_name    = 'M-Invoice',
       portal_url    = NULL,
       portal_domain = NULL,
       note          = 'Cổng tra cứu chưa xác minh — dùng link in trong chính hoá đơn nếu có',
       updated_at    = NOW()
 WHERE tax_code = '0106026495'
   AND short_name IS DISTINCT FROM 'M-Invoice';

-- Bổ sung các nhà cung cấp đã gặp trong dữ liệu hoá đơn thật nhưng chưa có trong danh bạ.
-- Tên lấy từ cổng tra cứu MST của cơ quan thuế. KHÔNG điền portal_url khi chưa xác minh
-- được cổng tra cứu chính thức — giao diện sẽ dùng link in trong hoá đơn thay thế.
INSERT INTO einvoice_providers (tax_code, name, short_name, portal_url, code_label, note) VALUES
  ('0105987432', 'CÔNG TY CỔ PHẦN ĐẦU TƯ CÔNG NGHỆ VÀ THƯƠNG MẠI SOFTDREAMS', 'EasyInvoice',
   NULL, 'Mã tra cứu',
   'Cổng tra cứu riêng theo từng người bán — link nằm ở trường PortalLink trong hoá đơn'),
  ('0105232093', 'CÔNG TY CỔ PHẦN CYBERLOTUS', 'CyberLotus', NULL, 'Mã tra cứu', NULL),
  ('0312303803', 'CÔNG TY TNHH WIN TECH SOLUTION', 'Win Tech', NULL, 'Mã tra cứu', NULL),
  ('0106713804', 'CÔNG TY CỔ PHẦN DỊCH VỤ T-VAN HILO', 'HILO', NULL, 'Mã tra cứu', NULL)
ON CONFLICT (tax_code) DO NOTHING;

-- ─── 2. Bổ sung MÃ tra cứu còn thiếu ────────────────────────────────────────
UPDATE invoices SET
  provider_lookup_label = COALESCE(
    substring(raw_xml from
      '<TTruong>(Mã tra cứu|MaTraCuu|Mã số bí mật|Mã số bảo mật|Mã bảo mật|Fkey)</TTruong><KDLieu>[^<]*</KDLieu><DLieu>[^<]+</DLieu>'),
    substring(raw_xml from
      '<DLieu>[^<]+</DLieu><KDLieu>[^<]*</KDLieu><TTruong>(Mã tra cứu|MaTraCuu|Mã số bí mật|Mã số bảo mật|Mã bảo mật|Fkey)</TTruong>')
  ),
  provider_lookup_code = COALESCE(
    substring(raw_xml from
      '<TTruong>(?:Mã tra cứu|MaTraCuu|Mã số bí mật|Mã số bảo mật|Mã bảo mật|Fkey)</TTruong><KDLieu>[^<]*</KDLieu><DLieu>([^<]+)</DLieu>'),
    substring(raw_xml from
      '<DLieu>([^<]+)</DLieu><KDLieu>[^<]*</KDLieu><TTruong>(?:Mã tra cứu|MaTraCuu|Mã số bí mật|Mã số bảo mật|Mã bảo mật|Fkey)</TTruong>')
  )
WHERE raw_xml IS NOT NULL
  AND provider_lookup_code IS NULL;

-- "MaTraCuu" viết liền thì nhãn hiển thị cho người dùng nên là "Mã tra cứu"
UPDATE invoices SET provider_lookup_label = 'Mã tra cứu'
 WHERE provider_lookup_label IN ('MaTraCuu', 'Fkey');

-- ─── 3. Bổ sung LINK tra cứu còn thiếu ──────────────────────────────────────
UPDATE invoices SET provider_lookup_url = COALESCE(
    substring(raw_xml from
      '<TTruong>(?:PortalLink|PortalURL|Link tra cứu|Link tra cứu người bán|Website tra cứu|Địa chỉ tra cứu)</TTruong><KDLieu>[^<]*</KDLieu><DLieu>([^<]+)</DLieu>'),
    substring(raw_xml from
      '<DLieu>([^<]+)</DLieu><KDLieu>[^<]*</KDLieu><TTruong>(?:PortalLink|PortalURL|Link tra cứu|Link tra cứu người bán|Website tra cứu|Địa chỉ tra cứu)</TTruong>'),
    substring(raw_xml from '<DLieu>\s*(https?://[^< ]+)\s*</DLieu>')
  )
WHERE raw_xml IS NOT NULL
  AND provider_lookup_url IS NULL;

-- Chuẩn hoá: bỏ dấu câu thừa, thêm scheme khi hoá đơn chỉ ghi tên miền
UPDATE invoices
   SET provider_lookup_url = regexp_replace(btrim(provider_lookup_url), '[.,;)]+$', '')
 WHERE provider_lookup_url IS NOT NULL;

UPDATE invoices
   SET provider_lookup_url = 'https://' || provider_lookup_url
 WHERE provider_lookup_url IS NOT NULL
   AND provider_lookup_url !~* '^https?://';

-- Giá trị rỗng / rác thì bỏ hẳn cho sạch (một số hoá đơn ghi <DLieu/> trống)
UPDATE invoices
   SET provider_lookup_url = NULL
 WHERE provider_lookup_url IS NOT NULL
   AND provider_lookup_url !~* '^https?://[a-z0-9-]+(\.[a-z0-9-]+)+';
