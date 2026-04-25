-- Migration: 045_ct37_ct38_auto_columns.sql
-- Adds auto-computed columns for cross-period adjustment VAT (ct37/ct38).
-- ct37_auto_decrease: auto-computed from OUTPUT cross-period adjustment invoices that INCREASE output VAT (prior underpayment).
-- ct38_auto_increase: auto-computed from OUTPUT cross-period adjustment invoices that DECREASE output VAT (prior overpayment).
-- The existing ct37_adjustment_decrease and ct38_adjustment_increase remain as manual-only override fields.
-- Final values: xml_ct37 = auto + manual, xml_ct38 = NQ142_reduction + auto + manual.

ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct37_auto_decrease NUMERIC(18,0) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ct38_auto_increase NUMERIC(18,0) DEFAULT 0;

COMMENT ON COLUMN tax_declarations.ct37_auto_decrease IS 'Auto-computed từ hóa đơn đầu ra điều chỉnh cross-period có vat_amount > 0 (bổ sung khai thiếu kỳ trước)';
COMMENT ON COLUMN tax_declarations.ct38_auto_increase IS 'Auto-computed từ hóa đơn đầu ra điều chỉnh cross-period có vat_amount < 0 (điều chỉnh giảm kỳ trước)';
