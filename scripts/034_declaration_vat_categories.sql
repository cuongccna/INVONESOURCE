-- Migration 034: VAT categories for declarations
-- Adds tax_category + non_deductible to invoices
-- Adds new 01/GTGT indicator columns to tax_declarations
-- Safe: all ALTER TABLE ... ADD COLUMN IF NOT EXISTS

-- ── invoices ──────────────────────────────────────────────────────────────────
-- tax_category: canonical tsuat string parsed from source XML
--   Values: 'KCT' (không chịu thuế), 'KKKNT' (không kê khai nộp thuế),
--           '0', '5', '8', '10' (numeric VAT %)
--   NULL = not yet classified (old data; backfill via scripts/backfill_tax_category.ts)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_category VARCHAR(20) NULL;

-- non_deductible: kế toán đánh dấu hóa đơn không đủ điều kiện khấu trừ [25]
-- Ví dụ: xe ô tô > 1.6 tỷ, hóa đơn phục vụ hoạt động không chịu thuế
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS non_deductible BOOLEAN NOT NULL DEFAULT false;

-- Index để query nhanh các hóa đơn đã phân loại
CREATE INDEX IF NOT EXISTS idx_invoices_tax_category ON invoices(tax_category)
  WHERE tax_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_non_deductible ON invoices(company_id, non_deductible)
  WHERE non_deductible = true;

-- ── tax_declarations ──────────────────────────────────────────────────────────

-- [21] Không phát sinh hoạt động mua, bán trong kỳ (checkbox)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct21_no_activity BOOLEAN NOT NULL DEFAULT false;

-- [26] Hàng hóa dịch vụ bán ra KHÔNG chịu thuế GTGT (KCT)
--       Tách khỏi ct30_exempt_revenue (giữ lại ct30 để backward compat)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct26_kct_revenue NUMERIC(18,0) NOT NULL DEFAULT 0;

-- [29] Doanh thu bán ra chịu thuế suất 0% (xuất khẩu)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct29_0pct_revenue NUMERIC(18,0) NOT NULL DEFAULT 0;

-- [32a] Hàng hóa dịch vụ không phải kê khai tính nộp (KKKNT)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct32a_kkknt_revenue NUMERIC(18,0) NOT NULL DEFAULT 0;

-- [37] Điều chỉnh GIẢM thuế GTGT còn được khấu trừ của các kỳ trước
--       (nhập tay — khai bổ sung kỳ trước có số giảm)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct37_adjustment_decrease NUMERIC(18,0) NOT NULL DEFAULT 0;

-- [38] Điều chỉnh TĂNG thuế GTGT còn được khấu trừ của các kỳ trước
--       (nhập tay — khai bổ sung kỳ trước có số tăng)
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct38_adjustment_increase NUMERIC(18,0) NOT NULL DEFAULT 0;

-- [40b] Thuế GTGT mua vào của dự án đầu tư bù trừ với thuế GTGT còn phải nộp
ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS ct40b_investment_vat NUMERIC(18,0) NOT NULL DEFAULT 0;

-- ── Backfill ct26_kct_revenue từ ct30_exempt_revenue cũ ───────────────────────
-- ct30_exempt_revenue đã lưu doanh thu không chịu thuế → copy sang ct26 canonical
UPDATE tax_declarations
SET ct26_kct_revenue = ct30_exempt_revenue
WHERE ct26_kct_revenue = 0
  AND ct30_exempt_revenue > 0;

-- ── Comment on columns ────────────────────────────────────────────────────────
COMMENT ON COLUMN invoices.tax_category IS
  'Canonical VAT category from source XML tsuat: KCT | KKKNT | 0 | 5 | 8 | 10. NULL = not yet classified.';
COMMENT ON COLUMN invoices.non_deductible IS
  'Kế toán đánh dấu hóa đơn không đủ điều kiện khấu trừ VAT (xe > 1.6 tỷ, dùng cho HĐ không chịu thuế...). Loại khỏi chỉ tiêu [25].';
COMMENT ON COLUMN tax_declarations.ct26_kct_revenue IS
  'Form [26]: Doanh thu HHDV bán ra không chịu thuế GTGT (tax_category=KCT).';
COMMENT ON COLUMN tax_declarations.ct29_0pct_revenue IS
  'Form [29]: Doanh thu HHDV bán ra chịu thuế suất 0% (xuất khẩu, tax_category=0).';
COMMENT ON COLUMN tax_declarations.ct32a_kkknt_revenue IS
  'Form [32a]: Doanh thu HHDV không phải kê khai tính nộp (tax_category=KKKNT).';
COMMENT ON COLUMN tax_declarations.ct37_adjustment_decrease IS
  'Form [37]: Điều chỉnh GIẢM thuế GTGT còn được khấu trừ kỳ trước (nhập tay).';
COMMENT ON COLUMN tax_declarations.ct38_adjustment_increase IS
  'Form [38]: Điều chỉnh TĂNG thuế GTGT còn được khấu trừ kỳ trước (nhập tay).';
COMMENT ON COLUMN tax_declarations.ct40b_investment_vat IS
  'Form [40b]: Thuế GTGT mua vào dự án đầu tư bù trừ (nhập tay).';
