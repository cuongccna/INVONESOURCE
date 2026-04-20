-- 037: Backfill has_line_items for invoices that already have line items in DB
-- but were incorrectly marked has_line_items = false (K-prefix serial bug)

UPDATE invoices
SET has_line_items = true
WHERE has_line_items = false
  AND id IN (SELECT DISTINCT invoice_id FROM invoice_line_items);
