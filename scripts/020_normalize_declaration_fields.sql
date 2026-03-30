-- Migration 020: Add ct23_input_subtotal and ct36_nq_vat_reduction to tax_declarations
-- ct23_input_subtotal: giá trị HHDV mua vào đủ điều kiện khấu trừ (chưa VAT) → XML <ct23>
-- ct36_nq_vat_reduction: giảm thuế GTGT theo NQ142/NQ204 = 2% × DT đầu ra 8% → XML <ct36>

ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct23_input_subtotal   NUMERIC(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ct36_nq_vat_reduction NUMERIC(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN tax_declarations.ct23_input_subtotal   IS 'Giá trị HHDV mua vào đủ điều kiện khấu trừ (chưa VAT) – HTKK XML ct23';
COMMENT ON COLUMN tax_declarations.ct36_nq_vat_reduction IS 'Giảm thuế GTGT theo NQ142/NQ204 = 2% × DT bán ra 8% – HTKK XML ct36';
