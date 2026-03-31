-- 021_invoice_type_columns.sql
-- GROUP 47: Invoice type handling — add columns for serial number classification
-- Per TT78/2021: Group 5 (có mã CQT), Group 6 (không mã, HĐ thường), Group 8 (không mã, máy tính tiền)

-- 1. Add classification columns
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_group SMALLINT,          -- 5 | 6 | 8
  ADD COLUMN IF NOT EXISTS serial_has_cqt BOOLEAN,          -- C-prefix = true, K-prefix = false
  ADD COLUMN IF NOT EXISTS has_line_items BOOLEAN DEFAULT false;

-- 2. Index for VAT queries filtering by invoice_group
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_invoice_group
  ON invoices (invoice_group) WHERE deleted_at IS NULL;

-- 3. Backfill existing invoices based on serial_number first character
UPDATE invoices
SET
  serial_has_cqt = CASE
    WHEN UPPER(LEFT(serial_number, 1)) = 'C' THEN true
    WHEN UPPER(LEFT(serial_number, 1)) = 'K' THEN false
    ELSE NULL
  END,
  invoice_group = CASE
    WHEN UPPER(LEFT(serial_number, 1)) = 'C' THEN 5
    WHEN UPPER(LEFT(serial_number, 1)) = 'K' AND UPPER(SUBSTRING(serial_number FROM 4 FOR 1)) = 'M' THEN 8
    WHEN UPPER(LEFT(serial_number, 1)) = 'K' THEN 6
    ELSE NULL
  END,
  has_line_items = CASE
    WHEN UPPER(LEFT(serial_number, 1)) = 'C' THEN true
    ELSE false
  END
WHERE serial_number IS NOT NULL AND serial_number != '' AND invoice_group IS NULL;

-- 4. Check constraint to validate invoice_group values
ALTER TABLE invoices
  ADD CONSTRAINT chk_invoice_group CHECK (invoice_group IS NULL OR invoice_group IN (5, 6, 8));
