-- Migration 066: Bổ sung cổng tra cứu đã xác minh cho M-Invoice và CyberLotus
--
-- Sau 065, hai nhà cung cấp này có mã tra cứu trong hoá đơn nhưng danh bạ chưa có cổng,
-- nên giao diện chỉ hiện được mã mà không chỉ được chỗ tra. Cổng dưới đây đã kiểm chứng
-- bằng cách truy cập trực tiếp (tháng 8/2026).
--
-- Win Tech Solution (0312303803) và HILO (0106713804) vẫn để trống: chưa xác minh được
-- cổng tra cứu chính thức dành cho người mua. Thà không có link còn hơn chỉ sai chỗ.
--
-- Additive + idempotent.

UPDATE einvoice_providers
   SET portal_url    = 'https://tracuuhoadon.minvoice.com.vn/',
       portal_domain = 'tracuuhoadon.minvoice.com.vn',
       note          = 'Nhập MST người bán + mã tra cứu in trên hoá đơn',
       updated_at    = NOW()
 WHERE tax_code = '0106026495'
   AND portal_url IS NULL;

UPDATE einvoice_providers
   SET portal_url    = 'https://tracuu.cyberbill.vn/',
       portal_domain = 'tracuu.cyberbill.vn',
       note          = 'Cổng CyberBill; hiện chuyển hướng sang tracuuhoadon1.xcyber.vn',
       updated_at    = NOW()
 WHERE tax_code = '0105232093'
   AND portal_url IS NULL;
