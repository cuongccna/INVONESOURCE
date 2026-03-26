-- ============================================================
-- 009_gdt_viettel_validated.sql
-- Viettel hóa đơn ký hiệu bắt đầu bằng "C" là hóa đơn không có
-- mã của cơ quan thuế (không có CQT) — không thể validate qua
-- cổng GDT hoadondientu.gdt.gov.vn một cách đơn lẻ.
-- Viettel là nhà cung cấp HĐĐT được cấp phép → tự bảo đảm tính
-- hợp lệ. Mark all existing Viettel invoices as gdt_validated=true.
-- ============================================================
UPDATE invoices
SET gdt_validated    = true,
    gdt_validated_at = NOW(),
    updated_at       = NOW()
WHERE provider = 'viettel'
  AND gdt_validated = false;
