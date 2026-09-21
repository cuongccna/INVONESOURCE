-- Migration 063: Sửa tên khối phụ lục giảm thuế GTGT đã lưu sai + xoá XML tờ khai cache hỏng
--
-- Bối cảnh
--   Migration 062 gieo bảng vat_reduction_policies bằng INSERT … ON CONFLICT DO NOTHING.
--   Bản 062 đầu tiên ghi xml_block_tag theo TÊN NGHỊ QUYẾT (PL_NQ43/101/110/174/204_GTGT).
--   Commit sau đó sửa file 062 về PL_NQ142_GTGT, nhưng vì các dòng đã tồn tại nên
--   ON CONFLICT DO NOTHING bỏ qua — database thật vẫn giữ tên sai.
--
--   Hệ quả: XML tờ khai 01/GTGT kỳ 7/2025–2026 xuất ra khối <PL_NQ204_GTGT>. Tên này
--   không có trong bộ chuẩn XML 2.8.3 của cơ quan thuế, nên công cụ ký số / eTax
--   không xử lý được file (màn hình ký đứng im).
--
--   PL_NQ142_GTGT là TÊN KỸ THUẬT cố định của schema, không đổi theo từng nghị quyết.
--   Đã đối chiếu 2 tờ khai thật: bản HTKK 5.7.1 và bản nộp thành công qua eTax.
--   Nghị quyết áp dụng cho từng kỳ nằm ở cột legal_basis.
--
-- Additive + idempotent.

UPDATE vat_reduction_policies
   SET xml_block_tag = 'PL_NQ142_GTGT'
 WHERE xml_block_tag <> 'PL_NQ142_GTGT';

-- Ghi chú lại lý do ngay trên cột để lần sau không ai đổi theo tên nghị quyết nữa
COMMENT ON COLUMN vat_reduction_policies.xml_block_tag IS
  'Tên khối phụ lục trong bộ chuẩn XML của cơ quan thuế — TÊN KỸ THUẬT, không phải tên '
  'nghị quyết. Bộ chuẩn 2.8.3 dùng PL_NQ142_GTGT cho mọi kỳ. Chỉ đổi khi cơ quan thuế '
  'nâng phiên bản XML. Nghị quyết áp dụng ghi ở legal_basis.';

-- ─── Xoá XML tờ khai đã cache bằng phiên bản sinh XML cũ ────────────────────
--
-- xml_content được cache trong tax_declarations; tờ khai chưa nộp mà đã cache bản hỏng
-- thì tải về vẫn ra file cũ. Xoá cache để lần tải sau sinh lại bằng mã nguồn hiện tại.
-- Tờ khai ĐÃ NỘP giữ nguyên: đó là bằng chứng đã gửi cơ quan thuế.
UPDATE tax_declarations
   SET xml_content      = NULL,
       xml_generated_at = NULL
 WHERE xml_content IS NOT NULL
   AND submission_status NOT IN ('submitted', 'accepted');
