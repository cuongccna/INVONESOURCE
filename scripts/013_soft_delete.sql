-- Migration 013: Group 42 — Soft Delete & Data Management
-- Adds controlled deletion, permanent-ignore, and active_invoices view

-- ─── invoices: thêm các cột soft-delete còn thiếu ───────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS deleted_by             UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS delete_reason          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS is_permanently_ignored BOOLEAN NOT NULL DEFAULT false;
-- Ghi chú: deleted_at TIMESTAMPTZ đã có từ migration 001

-- Index nhanh cho "bot không tải lại" (tra cứu khi import)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_ignored
  ON invoices(company_id, invoice_number, direction)
  WHERE is_permanently_ignored = true;

-- Index tổng hợp cho trash bin (danh sách đã xóa)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_trash
  ON invoices(company_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- ─── invoice_line_items: soft-delete ────────────────────────────────────────
ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- ─── inventory_movements: soft-delete ───────────────────────────────────────
ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- ─── VIEW: active_invoices — luôn loại trừ đã xóa mềm & bỏ qua vĩnh viễn ──
CREATE OR REPLACE VIEW active_invoices AS
  SELECT * FROM invoices
  WHERE deleted_at IS NULL
    AND is_permanently_ignored = false;

-- ─── audit_logs: đảm bảo bảng tồn tại (dùng cho P42.3) ─────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID REFERENCES companies(id),
  user_id      UUID REFERENCES users(id),
  action       VARCHAR(50)  NOT NULL,  -- 'delete'|'restore'|'permanent_ignore'|'bulk_delete'|'bulk_restore'
  entity_type  VARCHAR(50)  NOT NULL DEFAULT 'invoice',
  entity_id    UUID,
  metadata     JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company ON audit_logs(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity  ON audit_logs(entity_type, entity_id);
