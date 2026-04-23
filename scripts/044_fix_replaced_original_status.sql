-- Migration 044: Fix invoice statuses for replacement/adjustment invoices
--
-- Two bugs in sync.worker.ts:
-- BUG 1: Original superseded invoices were marked status='replaced' instead of 'replaced_original'
-- BUG 2: Replacement invoices (tc_hdon=1) kept status='valid' instead of 'replaced'
--        because GDT list API returns tthai=1 for them; tc_hdon field was ignored.
--
-- Fix both issues so filters "↺ HĐ thay thế" and "🔄 Bị thay thế" work correctly.

BEGIN;

-- Show counts before fix
SELECT
  'Before fix' AS phase,
  COUNT(*) FILTER (WHERE status = 'valid'            AND tc_hdon = 1) AS replacement_invoices_still_valid,
  COUNT(*) FILTER (WHERE status = 'valid'            AND tc_hdon = 2) AS adjustment_invoices_still_valid,
  COUNT(*) FILTER (WHERE status = 'replaced')                         AS replaced_count,
  COUNT(*) FILTER (WHERE status = 'replaced_original')                AS replaced_original_count
FROM invoices;

-- FIX 1: Mark replacement invoices (tc_hdon=1) as status='replaced'
UPDATE invoices
SET status     = 'replaced',
    updated_at = NOW()
WHERE tc_hdon = 1
  AND status NOT IN ('cancelled', 'replaced_original', 'replaced');

-- FIX 2: Mark adjustment invoices (tc_hdon=2) as status='adjusted'
UPDATE invoices
SET status     = 'adjusted',
    updated_at = NOW()
WHERE tc_hdon = 2
  AND status NOT IN ('cancelled', 'adjusted');

-- FIX 3: Mark original superseded invoices correctly as 'replaced_original'
-- (previously wrongly marked as 'replaced' because BUG 1 used wrong status string)
UPDATE invoices orig
SET
  status     = 'replaced_original',
  updated_at = NOW()
WHERE
  orig.status = 'replaced'
  -- The invoice itself is NOT a replacement type (it's the original)
  AND (orig.tc_hdon IS NULL OR orig.tc_hdon NOT IN (1, 2))
  -- At least one replacement invoice references this as the original
  AND EXISTS (
    SELECT 1
    FROM invoices ref
    WHERE ref.company_id    = orig.company_id
      AND ref.so_hd_cl_quan = orig.invoice_number
      AND ref.khhd_cl_quan  = orig.serial_number
      AND ref.tc_hdon       = 1
  );

-- Show counts after fix
SELECT
  'After fix' AS phase,
  COUNT(*) FILTER (WHERE status = 'valid'            AND tc_hdon = 1) AS replacement_invoices_still_valid,
  COUNT(*) FILTER (WHERE status = 'valid'            AND tc_hdon = 2) AS adjustment_invoices_still_valid,
  COUNT(*) FILTER (WHERE status = 'replaced')                         AS replaced_count,
  COUNT(*) FILTER (WHERE status = 'replaced_original')                AS replaced_original_count
FROM invoices;

COMMIT;
