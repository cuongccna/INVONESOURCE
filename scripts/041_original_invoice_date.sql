-- Migration 041: Add replaced_original status + original_invoice_date column
-- Purpose: Support cross-period [37]/[38] detection and proper invoice type classification

-- 1. Add replaced_original to invoice_status enum
--    replaced_original = original invoice that was superseded by a replacement invoice
DO $$ BEGIN
  ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'replaced_original';
EXCEPTION WHEN others THEN NULL;
END $$;

-- 2. Add original_invoice_date column
--    Populated from tdlhdgoc field in GDT API response.
--    Used to detect cross-period adjustments: original in Q(n-1), adjustment in Q(n).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS original_invoice_date DATE DEFAULT NULL;

COMMENT ON COLUMN invoices.original_invoice_date IS
  'Ngày lập hóa đơn gốc (tdlhdgoc từ GDT). '
  'Dùng phát hiện điều chỉnh cross-period cho [37]/[38] tờ khai 01/GTGT. '
  'NULL = không phải hóa đơn điều chỉnh hoặc chưa đồng bộ.';

-- 3. Index for cross-period query (partial index — most invoices have NULL)
CREATE INDEX IF NOT EXISTS idx_invoices_original_date
  ON invoices (original_invoice_date)
  WHERE original_invoice_date IS NOT NULL;

-- 4. Backfill: mark any invoice that has an active replacement as replaced_original
--    (handles legacy records synced before replaced_original status was added)
UPDATE invoices orig
SET status = 'replaced_original'
WHERE orig.status = 'cancelled'
  AND orig.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM invoices repl
    WHERE repl.company_id = orig.company_id
      AND repl.tc_hdon = 1
      AND repl.deleted_at IS NULL
      AND TRIM(COALESCE(repl.khhd_cl_quan, '')) = TRIM(COALESCE(orig.serial_number, ''))
      AND TRIM(COALESCE(repl.so_hd_cl_quan, '')) = TRIM(COALESCE(orig.invoice_number, ''))
      AND COALESCE(repl.seller_tax_code, '') = COALESCE(orig.seller_tax_code, '')
  );
