-- Migration 025: Fix invoice unique key + timezone-corrected date support
-- 
-- Problem: The old unique index included invoice_date, so upserts could not
--   correct dates on existing rows. Also, GDT's tdlap field is UTC, and
--   parseInvoiceDate was storing UTC date instead of Vietnam date (UTC+7),
--   causing invoices to appear 1 day early in the UI.
--
-- Changes:
--   1. Delete duplicate rows (same company/provider/invoice_number/seller/serial),
--      keeping the most recently updated copy.
--   2. Drop the old invoices_upsert_key (which included invoice_date).
--   3. Create a new invoices_upsert_key WITHOUT invoice_date, WITH serial_number.
--      Key: (company_id, provider, invoice_number, COALESCE(seller_tax_code,''), COALESCE(serial_number,''))
--   4. Update gdt_bot invoices that were stored with wrong UTC date by adding 7h
--      where the stored invoice_date is 1 day before what GDT portal shows.
--      We identify these as gdt_bot invoices where invoice_date is likely UTC midnight
--      (i.e., extracted from a timestamp like "2026-04-03T17:00:00Z").
--      Since we don't have the original timestamp stored, we conservatively update
--      only cases where we KNOW the GDT API uses midnight VN time for the given invoice.
--      The safer approach: let the bot re-sync correct the dates via ON CONFLICT UPDATE.

BEGIN;

-- Step 1: Remove duplicate rows — keep the most recently updated per new key.
-- This prevents the CREATE UNIQUE INDEX from failing due to pre-existing duplicates.
DELETE FROM invoices
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY company_id, provider, invoice_number,
                          COALESCE(seller_tax_code, ''), COALESCE(serial_number, '')
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           ) AS rn
    FROM invoices
    WHERE deleted_at IS NULL
  ) x WHERE rn > 1
);

-- Also handle soft-deleted duplicates — keep newest per key across all rows.
DELETE FROM invoices
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY company_id, provider, invoice_number,
                          COALESCE(seller_tax_code, ''), COALESCE(serial_number, '')
             ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
           ) AS rn
    FROM invoices
  ) x WHERE rn > 1
);

-- Step 2: Drop the old unique index that included invoice_date.
DROP INDEX IF EXISTS invoices_upsert_key;

-- Step 3: Create the new unique index without invoice_date.
-- Uses COALESCE so NULL seller_tax_code and NULL serial_number are always treated as ''.
CREATE UNIQUE INDEX invoices_upsert_key
  ON invoices (company_id, provider, invoice_number,
               COALESCE(seller_tax_code, ''), COALESCE(serial_number, ''));

COMMIT;
