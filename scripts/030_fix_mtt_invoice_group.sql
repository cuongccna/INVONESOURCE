-- Migration 030: Fix invoice_group + is_sco for MTT invoices with C-prefix (C26MED style)
--
-- BUG: parseInvoiceSerial and _classifySerial both checked hasCqtCode (C/K prefix) FIRST,
-- causing C26MED (C=có mã, 26=year, M=máy tính tiền) to be classified as invoiceGroup=5
-- instead of the correct invoiceGroup=8.
--
-- TT78/2021 rule: position 4 of ký hiệu (index 3) determines invoice type.
-- 'M' at position 4 = HĐ máy tính tiền → group 8 + is_sco = true,
-- regardless of whether the first character is 'C' (có mã) or 'K' (không mã).
--
-- Examples affected:
--   C26MED → was group 5,  now group 8,  is_sco=true
--   C26MAC → was group 5,  now group 8,  is_sco=true
--   K26MED → was group 8 ✓ (already correct via K-branch check)

BEGIN;

UPDATE invoices
SET
  invoice_group = 8,
  is_sco        = true
WHERE
  deleted_at IS NULL
  -- Position 4 (1-based) = index 3 = invoice type character
  AND UPPER(SUBSTRING(serial_number FROM 4 FOR 1)) = 'M'
  -- Only fix rows that are currently wrong
  AND (invoice_group IS DISTINCT FROM 8 OR is_sco IS DISTINCT FROM true);

-- Report how many rows were fixed
DO $$
DECLARE
  fixed_count integer;
BEGIN
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Fixed % invoice(s): invoice_group set to 8, is_sco set to true for C/K*M* ký hiệu', fixed_count;
END $$;

COMMIT;
