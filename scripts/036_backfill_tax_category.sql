-- Migration 036: Backfill tax_category from vat_rate
-- Chạy 1 lần sau khi deploy. Idempotent (chỉ cập nhật WHERE tax_category IS NULL).
--
-- Logic:
--   vat_rate = 5  → '5'
--   vat_rate = 8  → '8'   (NQ142 interim rate)
--   vat_rate = 10 → '10'
--   vat_rate = 0, direction='output', vat_amount=0 → 'KCT' (tentative: 0-rate domestic)
--   vat_rate = 0, direction='input'                → '0'   (import/export purchase)
--   vat_rate = 0, direction='output', vat_amount>0 → '0'   (export with VAT adj = rare edge)
--   vat_rate = NULL                                → leave NULL (cannot determine)

-- Step 1: Clear-cut numeric rates (5, 8, 10)
UPDATE invoices
SET tax_category = CASE
  WHEN ROUND(vat_rate::numeric, 2) = 5.00  THEN '5'
  WHEN ROUND(vat_rate::numeric, 2) = 8.00  THEN '8'
  WHEN ROUND(vat_rate::numeric, 2) = 10.00 THEN '10'
END
WHERE tax_category IS NULL
  AND vat_rate IS NOT NULL
  AND ROUND(vat_rate::numeric, 2) IN (5.00, 8.00, 10.00);

-- Step 2: vat_rate = 0, output invoice, vat_amount = 0 → KCT (không chịu thuế)
-- Rationale: Domestic Vietnamese B2B at 0-rate with no VAT amount is almost always KCT
UPDATE invoices
SET tax_category = 'KCT'
WHERE tax_category IS NULL
  AND vat_rate IS NOT NULL
  AND ROUND(vat_rate::numeric, 2) = 0.00
  AND direction = 'output'
  AND (vat_amount IS NULL OR vat_amount = 0);

-- Step 3: vat_rate = 0, input invoice → '0' (purchase at 0%, e.g. from exporter)
UPDATE invoices
SET tax_category = '0'
WHERE tax_category IS NULL
  AND vat_rate IS NOT NULL
  AND ROUND(vat_rate::numeric, 2) = 0.00
  AND direction = 'input';

-- Step 4: vat_rate = 0, output invoice, vat_amount > 0 → '0' (output taxed at 0%)
UPDATE invoices
SET tax_category = '0'
WHERE tax_category IS NULL
  AND vat_rate IS NOT NULL
  AND ROUND(vat_rate::numeric, 2) = 0.00
  AND direction = 'output'
  AND vat_amount > 0;

-- Summary
SELECT tax_category, direction, COUNT(*) AS cnt
FROM invoices
GROUP BY tax_category, direction
ORDER BY tax_category NULLS LAST, direction;
