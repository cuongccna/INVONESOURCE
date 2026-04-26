-- Migration 042: Add adjusted_original to invoice_status enum
-- Purpose: Support filtering invoices that were the original invoice
--          before being adjusted by a tc_hdon=2 adjustment invoice.
--
-- adjusted_original = original invoice superseded by an adjustment (điều chỉnh)
-- (analogous to replaced_original which was added in migration 041)
--
-- This was referenced in routes/invoices.ts and import.ts but was missing
-- from the DB enum, causing 500 errors when filtering by status=adjusted_original.

DO $$ BEGIN
  ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'adjusted_original';
EXCEPTION WHEN others THEN NULL;
END $$;

COMMENT ON TYPE invoice_status IS
  'valid | cancelled | replaced | replaced_original | adjusted | adjusted_original | invalid';

-- Backfill: any invoice that has an active tc_hdon=2 adjustment invoice
-- referencing it (via khhd_cl_quan + so_hd_cl_quan) should be marked adjusted_original.
-- Only update if current status is not already a terminal/explicit status.
UPDATE invoices orig
SET status = 'adjusted_original'
FROM invoices adj
WHERE adj.tc_hdon = 2
  AND adj.company_id = orig.company_id
  AND adj.khhd_cl_quan IS NOT NULL AND adj.khhd_cl_quan != ''
  AND adj.so_hd_cl_quan IS NOT NULL AND adj.so_hd_cl_quan != ''
  AND adj.khhd_cl_quan = orig.serial_number
  AND adj.so_hd_cl_quan = orig.invoice_number
  AND orig.status NOT IN ('cancelled', 'replaced_original', 'adjusted_original', 'replaced')
  AND adj.deleted_at IS NULL
  AND orig.deleted_at IS NULL;
