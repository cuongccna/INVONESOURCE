-- Migration 064: Đường link tra cứu đi kèm trong file hoá đơn tải về
--
-- Bối cảnh
--   File hoá đơn gốc (XML trong gói ZIP của cổng thuế) hầu như luôn kèm đường dẫn tra cứu
--   của chính nhà cung cấp trong khối <TTKhac>, cạnh "Mã tra cứu" / "Mã số bí mật":
--
--     <TTin><TTruong>Website tra cứu</TTruong><KDLieu>string</KDLieu>
--           <DLieu>https://tracuu.example.vn</DLieu></TTin>
--
--   Trước đây hệ thống chỉ đọc MÃ, không đọc LINK, nên khi MST đơn vị cung cấp giải pháp
--   (tvandnkntt) không nằm trong danh bạ einvoice_providers thì người dùng có mã mà
--   không biết vào đâu để tra.
--
--   Migration này lưu luôn link lấy từ chính hoá đơn, và thêm cột domain cho danh bạ
--   để nhận diện nhà cung cấp NGƯỢC từ link khi không có MST T-VAN.
--
-- Additive + idempotent.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS provider_lookup_url TEXT;

COMMENT ON COLUMN invoices.provider_lookup_url IS
  'Đường dẫn cổng tra cứu đọc từ chính file hoá đơn (TTKhac). Ưu tiên hơn portal_url '
  'trong danh bạ vì đúng cổng của nhà cung cấp phát hành hoá đơn đó (kể cả cổng theo tỉnh).';

-- Nhận diện nhà cung cấp từ tên miền cổng tra cứu (khi hoá đơn không có MST T-VAN)
ALTER TABLE einvoice_providers ADD COLUMN IF NOT EXISTS portal_domain TEXT;

COMMENT ON COLUMN einvoice_providers.portal_domain IS
  'Tên miền cổng tra cứu, dùng để suy ngược ra nhà cung cấp từ link nằm trong hoá đơn.';

UPDATE einvoice_providers
   SET portal_domain = lower(substring(portal_url from '^https?://([^/:]+)'))
 WHERE portal_url IS NOT NULL
   AND portal_domain IS NULL;

CREATE INDEX IF NOT EXISTS idx_einvoice_providers_domain
  ON einvoice_providers (portal_domain);

-- ─── Backfill link tra cứu từ XML đã tải về ─────────────────────────────────
--
-- Bước 1: trường TTKhac có tên gợi ý tra cứu và giá trị là URL (2 thứ tự trường đều gặp)
UPDATE invoices SET provider_lookup_url = COALESCE(
    substring(raw_xml from
      '<TTruong>[^<]*(?:[Tt]ra c[^<]*|[Ww]ebsite|[Ll]ink)[^<]*</TTruong><KDLieu>[^<]*</KDLieu><DLieu>(https?://[^< ]+)</DLieu>'),
    substring(raw_xml from
      '<DLieu>(https?://[^< ]+)</DLieu><KDLieu>[^<]*</KDLieu><TTruong>[^<]*(?:[Tt]ra c[^<]*|[Ww]ebsite|[Ll]ink)[^<]*</TTruong>')
  )
WHERE raw_xml IS NOT NULL
  AND provider_lookup_url IS NULL;

-- Bước 2: hoá đơn còn thiếu thì lấy URL bất kỳ trong TTKhac (nhiều nhà cung cấp chỉ ghi
-- "Tra cứu tại" hoặc thậm chí không đặt tên trường, nhưng URL duy nhất chính là cổng tra cứu)
UPDATE invoices SET provider_lookup_url =
    substring(raw_xml from '<DLieu>\s*(https?://[^< ]+)\s*</DLieu>')
WHERE raw_xml IS NOT NULL
  AND provider_lookup_url IS NULL;

-- Bỏ dấu câu thừa ở cuối link (nhiều hoá đơn ghi "https://abc.vn.") và khoảng trắng
UPDATE invoices
   SET provider_lookup_url = regexp_replace(btrim(provider_lookup_url), '[.,;)]+$', '')
 WHERE provider_lookup_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_lookup_url
  ON invoices (company_id)
  WHERE provider_lookup_url IS NOT NULL AND deleted_at IS NULL;
