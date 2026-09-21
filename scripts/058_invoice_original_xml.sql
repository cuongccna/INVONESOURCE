-- Migration 058: Tải hoá đơn gốc (XML có chữ ký số) từ cổng hoá đơn điện tử GDT
--
-- Bối cảnh:
--   Bot hiện chỉ lưu raw_detail (JSON) — KHÔNG phải hoá đơn gốc. Bản gốc hợp pháp
--   là file XML có chữ ký số người bán + chữ ký cấp mã CQT, lấy qua
--   GET /query/invoices/export-xml (trả ZIP chứa invoice.xml).
--
--   Chỉ hoá đơn ttxly = 5 (đã cấp mã CQT) mới có XML trên hệ thống GDT.
--   ttxly = 6 (không mã) và 8 (uỷ nhiệm/MTT) → GDT trả HTTP 500, không có file gốc.
--
-- Additive + idempotent.

-- ─── Trạng thái XML gốc trên bảng hoá đơn ───────────────────────────────────
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS raw_xml_at    TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS raw_xml_size  INTEGER;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS xml_status    VARCHAR(20) NOT NULL DEFAULT 'unknown';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS xml_error     TEXT;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoice_xml_status;
ALTER TABLE invoices ADD CONSTRAINT chk_invoice_xml_status CHECK (
  xml_status IN ('unknown','queued','available','unavailable','failed')
);

COMMENT ON COLUMN invoices.xml_status IS
  'unknown = chưa xét | queued = đang chờ tải | available = đã có raw_xml | '
  'unavailable = GDT không lưu XML (ttxly 6/8) | failed = tải lỗi sau nhiều lần thử';

-- Đánh dấu sẵn các hoá đơn chắc chắn không có XML gốc để UI không mời tải vô ích
UPDATE invoices
   SET xml_status = 'unavailable'
 WHERE xml_status = 'unknown'
   AND gdt_ttxly IN (6, 8);

UPDATE invoices
   SET xml_status = 'available',
       raw_xml_size = COALESCE(raw_xml_size, LENGTH(raw_xml))
 WHERE raw_xml IS NOT NULL
   AND xml_status <> 'available';

CREATE INDEX IF NOT EXISTS idx_invoices_xml_status
  ON invoices (company_id, xml_status)
  WHERE deleted_at IS NULL;

-- ─── Hàng đợi tải XML gốc (Phase 3, tách khỏi invoice_detail_queue) ─────────
CREATE TABLE IF NOT EXISTS invoice_xml_queue (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id        UUID        NOT NULL,

  -- Tham số gọi GDT — sao chép lúc enqueue để không phụ thuộc thay đổi sau này
  nbmst             TEXT        NOT NULL,   -- MST người bán
  khhdon            TEXT        NOT NULL,   -- ký hiệu hoá đơn
  shdon             TEXT        NOT NULL,   -- số hoá đơn
  khmshdon          SMALLINT    NOT NULL DEFAULT 1,

  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed','skipped')),
  -- 1 = user bấm tải (đang chờ), 5 = tự động nền, 10 = backfill hàng loạt
  priority          SMALLINT    NOT NULL DEFAULT 5,

  attempts          SMALLINT    NOT NULL DEFAULT 0,
  max_attempts      SMALLINT    NOT NULL DEFAULT 3,
  last_error        TEXT,
  last_attempted_at TIMESTAMPTZ,
  requested_by      UUID        REFERENCES users(id) ON DELETE SET NULL,

  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at           TIMESTAMPTZ,

  UNIQUE (invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_ixq_work
  ON invoice_xml_queue (company_id, priority ASC, enqueued_at ASC)
  WHERE status IN ('pending','failed');

CREATE INDEX IF NOT EXISTS idx_ixq_company_status
  ON invoice_xml_queue (company_id, status);

CREATE INDEX IF NOT EXISTS idx_ixq_done_at
  ON invoice_xml_queue (done_at)
  WHERE status IN ('done','skipped');

COMMENT ON TABLE invoice_xml_queue IS
  'Hàng đợi tải hoá đơn gốc (XML ký số) từ /query/invoices/export-xml. '
  'Backend enqueue khi user bấm tải; bot (invone-xml-worker) xử lý qua proxy.';
