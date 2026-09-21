-- Migration 057: Trạng thái MST đối tác theo thời gian thực (tra cứu từ cổng Cục Thuế)
--
-- Bổ sung cho company_verification_cache (migration 024):
--   - Các trạng thái MST chi tiết theo TT105/2020 thay vì 3 mức thô
--   - Cơ quan thuế quản lý + nguyên văn trạng thái từ cổng thuế
--   - Thông tin lỗi lần tra gần nhất để worker biết retry
--
-- Additive + idempotent — an toàn chạy lại trên production.

-- ─── Cột mới ────────────────────────────────────────────────────────────────
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS tax_authority   VARCHAR(255);
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS mst_status_raw  TEXT;
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS branches        JSONB;
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS last_error      TEXT;
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS last_error_at   TIMESTAMPTZ;
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS check_ms        INTEGER;
ALTER TABLE company_verification_cache ADD COLUMN IF NOT EXISTS attempts        SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN company_verification_cache.tax_authority  IS 'Cơ quan thuế quản lý — cột 5 bảng kết quả tracuunnt';
COMMENT ON COLUMN company_verification_cache.mst_status_raw IS 'Nguyên văn "Trạng thái MST" từ cổng thuế, giữ lại để đối chiếu';
COMMENT ON COLUMN company_verification_cache.branches       IS 'Các MST chi nhánh (dạng 0106870211-001) trả về cùng lần tra';

-- ─── Mở rộng tập trạng thái hợp lệ ──────────────────────────────────────────
-- Trạng thái theo Điều 4 TT105/2020:
--   active              — NNT đang hoạt động
--   suspended           — Tạm nghỉ kinh doanh có thời hạn
--   inactive_at_address — Không hoạt động tại địa chỉ đã đăng ký (rủi ro khấu trừ cao nhất)
--   pending_dissolution — Đang làm thủ tục chấm dứt hiệu lực MST
--   dissolved           — Đã chấm dứt hiệu lực MST / giải thể / phá sản
--   moved               — Chuyển địa điểm / chuyển cơ quan thuế quản lý
ALTER TABLE company_verification_cache DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE company_verification_cache ADD CONSTRAINT valid_status CHECK (
  mst_status IN (
    'active','suspended','inactive_at_address','pending_dissolution',
    'dissolved','moved','not_found','error','pending'
  )
);

-- ─── Dọn cache độc do bản cũ ghi vào ────────────────────────────────────────
-- Bản cũ cache cả 'pending' và 'error' với TTL 30 ngày → không bao giờ tra lại.
-- Cho hết hạn ngay để worker mới tra lại từ đầu.
UPDATE company_verification_cache
   SET expires_at = NOW() - INTERVAL '1 second'
 WHERE mst_status IN ('pending','error')
   AND expires_at > NOW();

-- ─── Index phục vụ join ở danh sách hoá đơn + worker chọn việc ──────────────
CREATE INDEX IF NOT EXISTS idx_company_verify_stale
  ON company_verification_cache (expires_at)
  WHERE mst_status NOT IN ('active');

CREATE INDEX IF NOT EXISTS idx_verification_queue_status
  ON verification_queue (status, updated_at);
