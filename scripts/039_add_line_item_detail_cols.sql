-- BOT-DETAIL-03: Add missing columns to invoice_line_items for XML export reconstruction.
-- All additive — safe to re-run. No existing columns modified.

ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(18,2) DEFAULT NULL, -- stckhau (chiết khấu dòng)
  ADD COLUMN IF NOT EXISTS discount_rate    NUMERIC(10,4) DEFAULT NULL, -- tlckhau (tỷ lệ chiết khấu: 0.05 = 5%)
  ADD COLUMN IF NOT EXISTS line_type        SMALLINT      DEFAULT NULL, -- tchat (1=hàng hóa, 2=dịch vụ)
  ADD COLUMN IF NOT EXISTS vat_rate_label   TEXT          DEFAULT NULL, -- ltsuat (chuỗi thuế suất GDT gốc: "KCT", "8%")
  ADD COLUMN IF NOT EXISTS gdt_line_id      TEXT          DEFAULT NULL, -- id (UUID dòng từ GDT)
  ADD COLUMN IF NOT EXISTS gdt_invoice_id   TEXT          DEFAULT NULL; -- idhdon (UUID hóa đơn từ GDT)

COMMENT ON COLUMN invoice_line_items.discount_amount IS 'stckhau — chiết khấu dòng (giá trị tuyệt đối)';
COMMENT ON COLUMN invoice_line_items.discount_rate   IS 'tlckhau — tỷ lệ chiết khấu dòng (0.05 = 5%)';
COMMENT ON COLUMN invoice_line_items.vat_rate_label  IS 'ltsuat — chuỗi thuế suất GDT gốc (KCT, 8%, ...)';
COMMENT ON COLUMN invoice_line_items.gdt_line_id     IS 'id — UUID dòng hàng hóa từ GDT (để đối soát)';
COMMENT ON COLUMN invoice_line_items.gdt_invoice_id  IS 'idhdon — UUID hóa đơn từ GDT (foreign key phía GDT)';
