-- Migration 031: Backfill status='replaced'/'adjusted' for invoices that have
--   a newer replacement/adjustment invoice referencing them via tc_hdon + khhd_cl_quan + so_hd_cl_quan.
--
-- When to run: one-time, after deploying the tc_hdon fix (v2026-04).
-- Safe to re-run: the WHERE clause guards against double-updating.

-- Step 1: Mark originals as 'replaced' where a tc_hdon=1 invoice references them
UPDATE invoices AS orig
SET status     = 'replaced',
    updated_at = NOW()
FROM invoices AS rep
WHERE rep.tc_hdon          = 1
  AND rep.deleted_at        IS NULL
  AND rep.khhd_cl_quan      IS NOT NULL
  AND rep.so_hd_cl_quan     IS NOT NULL
  AND rep.company_id        = orig.company_id
  AND orig.serial_number    = rep.khhd_cl_quan
  AND orig.invoice_number   = rep.so_hd_cl_quan
  AND orig.status NOT IN ('cancelled', 'replaced', 'adjusted')
  AND orig.deleted_at IS NULL;

-- Step 2: Mark originals as 'adjusted' where a tc_hdon=2 invoice references them
UPDATE invoices AS orig
SET status     = 'adjusted',
    updated_at = NOW()
FROM invoices AS rep
WHERE rep.tc_hdon          = 2
  AND rep.deleted_at        IS NULL
  AND rep.khhd_cl_quan      IS NOT NULL
  AND rep.so_hd_cl_quan     IS NOT NULL
  AND rep.company_id        = orig.company_id
  AND orig.serial_number    = rep.khhd_cl_quan
  AND orig.invoice_number   = rep.so_hd_cl_quan
  AND orig.status NOT IN ('cancelled', 'replaced', 'adjusted')
  AND orig.deleted_at IS NULL;

-- Summary
SELECT
  COUNT(*) FILTER (WHERE status = 'replaced') AS replaced_count,
  COUNT(*) FILTER (WHERE status = 'adjusted') AS adjusted_count,
  COUNT(*) FILTER (WHERE status = 'valid')    AS still_valid_count
FROM invoices
WHERE deleted_at IS NULL;
