-- 024_is_sco.sql
-- Add is_sco column to invoices to track whether an invoice was fetched
-- from /sco-query (HĐ có mã khởi tạo từ máy tính tiền — MTTTT)
-- vs /query (HĐ điện tử thông thường).

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_sco BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN invoices.is_sco IS
  'true = fetched from /sco-query (máy tính tiền / MTTTT), false = fetched from /query (HĐ điện tử)';

-- Index to support the new UI filter
-- Note: no CONCURRENTLY here so this can run inside the migration transaction
CREATE INDEX IF NOT EXISTS idx_invoices_is_sco
  ON invoices (company_id, is_sco) WHERE deleted_at IS NULL;
