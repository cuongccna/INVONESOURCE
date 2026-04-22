-- BOT-DETAIL-01: Add raw_detail JSONB + missing header columns to invoices table.
-- All changes are additive (ADD COLUMN IF NOT EXISTS) — safe to re-run on production.
-- Zero downtime: no existing columns are modified.

-- Raw GDT detail response (full JSON for XML reconstruction)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS raw_detail          JSONB         DEFAULT NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS raw_detail_at       TIMESTAMPTZ   DEFAULT NULL;

-- GDT invoice identifiers
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_invoice_id      TEXT          DEFAULT NULL; -- id (UUID từ GDT)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_mhdon            TEXT          DEFAULT NULL; -- mhdon (mã hóa đơn)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_mtdtchieu        TEXT          DEFAULT NULL; -- mtdtchieu (mã tra cứu điện tử)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_khmshdon         SMALLINT      DEFAULT NULL; -- khmshdon (ký hiệu mẫu số: 1)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_hdon             TEXT          DEFAULT NULL; -- hdon (loại HĐ: "01")
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_hthdon           SMALLINT      DEFAULT NULL; -- hthdon (hình thức HĐ: 1=điện tử)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_htttoan          SMALLINT      DEFAULT NULL; -- htttoan (mã hình thức thanh toán)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_dvtte             TEXT          DEFAULT NULL; -- dvtte (đơn vị tiền tệ: "VND")
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_tgia             NUMERIC(18,6) DEFAULT NULL; -- tgia (tỷ giá)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_nky              TIMESTAMPTZ   DEFAULT NULL; -- nky (ngày ký)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_ttxly            SMALLINT      DEFAULT NULL; -- ttxly (trạng thái xử lý GDT)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_cqt              TEXT          DEFAULT NULL; -- cqt (mã cơ quan thuế)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_tvandnkntt       TEXT          DEFAULT NULL; -- tvandnkntt (MST T-VAN)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_pban             TEXT          DEFAULT NULL; -- pban (phiên bản XML: "2.1.0")
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_thlap            INTEGER       DEFAULT NULL; -- thlap (tháng lập: 202604)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_thdon            TEXT          DEFAULT NULL; -- thdon (tên loại HĐ)

-- Seller extended info
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_address       TEXT          DEFAULT NULL; -- nbdchi
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_bank_account  TEXT          DEFAULT NULL; -- nbstkhoan
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_bank_name     TEXT          DEFAULT NULL; -- nbtnhang
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_email         TEXT          DEFAULT NULL; -- nbdctdtu
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_phone         TEXT          DEFAULT NULL; -- nbsdthoai

-- Buyer extended info
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_address        TEXT          DEFAULT NULL; -- nmdchi
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_bank_account   TEXT          DEFAULT NULL; -- nmstkhoan

-- Tax & financial summary
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_ttcktmai         NUMERIC(18,2) DEFAULT NULL; -- ttcktmai (chiết khấu thương mại)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_tgtphi           NUMERIC(18,2) DEFAULT NULL; -- tgtphi (tổng tiền phí)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_qrcode           TEXT          DEFAULT NULL; -- qrcode (chuỗi QR)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_gchu             TEXT          DEFAULT NULL; -- gchu (ghi chú)

-- Digital signatures (JSON strings from GDT)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_nbcks            TEXT          DEFAULT NULL; -- nbcks (chữ ký người bán JSON)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gdt_cqtcks           TEXT          DEFAULT NULL; -- cqtcks (chữ ký CQT JSON)

-- Partial indexes for fast lookup on nullable columns
CREATE INDEX IF NOT EXISTS idx_invoices_gdt_invoice_id
  ON invoices (gdt_invoice_id) WHERE gdt_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_raw_detail_not_null
  ON invoices (id) WHERE raw_detail IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_gdt_mhdon
  ON invoices (gdt_mhdon) WHERE gdt_mhdon IS NOT NULL;

COMMENT ON COLUMN invoices.raw_detail IS
  'Full GDT /query/invoices/detail JSON response. Used for XML export reconstruction. '
  'Populated by _maybeInsertLineItems after detail API call. NULL until first detail fetch.';
