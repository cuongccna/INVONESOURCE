-- Migration 072: Kết quả chẩn đoán kết nối GDT gần nhất của từng công ty
--
--   Bot (bot/src/gdt-diagnose.worker.ts) ghi vào đây sau mỗi lần chẩn đoán — lần chạy
--   tự động hằng ngày trong giờ hành chính và lần admin bấm tay ở /admin/gdt-diagnose.
--   Dashboard đọc bảng này để báo cho người dùng khi kết nối tới GDT có vấn đề.
--   Chỉ giữ kết quả mới nhất (khoá chính = company_id).

CREATE TABLE IF NOT EXISTS gdt_connection_checks (
  company_id     UUID        PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok             BOOLEAN     NOT NULL,
  verdict_code   TEXT        NOT NULL,
  verdict_title  TEXT,
  verdict_detail TEXT,
  failed_step    TEXT,
  source         TEXT        NOT NULL DEFAULT 'daily',   -- daily | admin
  steps          JSONB
);

CREATE INDEX IF NOT EXISTS idx_gdt_connection_checks_failed
  ON gdt_connection_checks (checked_at DESC) WHERE ok = false;
