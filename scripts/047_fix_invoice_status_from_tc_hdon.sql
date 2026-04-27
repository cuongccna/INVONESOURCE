-- Migration 047: Fix invoice statuses using tc_hdon as the source of truth
--
-- Root cause: sync.worker.ts was using GDT's tthai field to derive status.
-- GDT list API returns tthai=1 (valid) for replacement invoices (tc_hdon=1)
-- and adjustment invoices (tc_hdon=2), so they were all stored as 'valid'.
-- Also, the mark-original logic was setting 'adjusted' instead of 'adjusted_original'
-- for invoices referenced by tc_hdon=2 adjustment invoices.
--
-- Code bugs fixed in: sync.worker.ts, _upsertInvoice, GdtXmlParser.ts, gdt-direct-api.service.ts
-- This migration re-applies the correct statuses to existing data.
--
-- Safe to re-run: all UPDATEs are guarded by status conditions.

BEGIN;

-- ── Show counts before fix ───────────────────────────────────────────────────
SELECT
  'Before fix' AS phase,
  COUNT(*) FILTER (WHERE tc_hdon = 1 AND status = 'valid')            AS replacement_still_valid,
  COUNT(*) FILTER (WHERE tc_hdon = 2 AND status = 'valid')            AS adjustment_still_valid,
  COUNT(*) FILTER (WHERE tc_hdon = 2 AND status = 'adjusted')         AS adjustment_wrong_adjusted,
  COUNT(*) FILTER (WHERE status = 'replaced')                          AS replaced_count,
  COUNT(*) FILTER (WHERE status = 'replaced_original')                 AS replaced_original_count,
  COUNT(*) FILTER (WHERE status = 'adjusted')                          AS adjusted_count,
  COUNT(*) FILTER (WHERE status = 'adjusted_original')                 AS adjusted_original_count
FROM invoices
WHERE deleted_at IS NULL;

-- ── FIX 1: Replacement invoices (tc_hdon=1) → status='replaced' ─────────────
UPDATE invoices
SET    status     = 'replaced',
       updated_at = NOW()
WHERE  tc_hdon    = 1
  AND  status NOT IN ('cancelled', 'replaced', 'replaced_original')
  AND  deleted_at IS NULL;

-- ── FIX 2: Adjustment invoices (tc_hdon=2) → status='adjusted' ──────────────
UPDATE invoices
SET    status     = 'adjusted',
       updated_at = NOW()
WHERE  tc_hdon    = 2
  AND  status NOT IN ('cancelled', 'adjusted', 'adjusted_original')
  AND  deleted_at IS NULL;

-- ── FIX 3: Originals referenced by tc_hdon=1 → 'replaced_original' ──────────
-- Re-run in case FIX 1 above moved some 'valid' originals that were already
-- correctly 'replaced_original' (guard prevents overwrite).
UPDATE invoices orig
SET    status     = 'replaced_original',
       updated_at = NOW()
FROM   invoices rep
WHERE  rep.tc_hdon           = 1
  AND  rep.deleted_at        IS NULL
  AND  rep.khhd_cl_quan      IS NOT NULL AND rep.khhd_cl_quan != ''
  AND  rep.so_hd_cl_quan     IS NOT NULL AND rep.so_hd_cl_quan != ''
  AND  rep.company_id        = orig.company_id
  AND  orig.serial_number    = rep.khhd_cl_quan
  AND  orig.invoice_number   = rep.so_hd_cl_quan
  AND  orig.status NOT IN ('cancelled', 'replaced_original', 'adjusted_original')
  AND  orig.deleted_at       IS NULL;

-- ── FIX 4: Originals referenced by tc_hdon=2 → 'adjusted_original' ──────────
-- Previously these were incorrectly set to 'adjusted' (code bug in mark-original).
UPDATE invoices orig
SET    status     = 'adjusted_original',
       updated_at = NOW()
FROM   invoices adj
WHERE  adj.tc_hdon           = 2
  AND  adj.deleted_at        IS NULL
  AND  adj.khhd_cl_quan      IS NOT NULL AND adj.khhd_cl_quan != ''
  AND  adj.so_hd_cl_quan     IS NOT NULL AND adj.so_hd_cl_quan != ''
  AND  adj.company_id        = orig.company_id
  AND  orig.serial_number    = adj.khhd_cl_quan
  AND  orig.invoice_number   = adj.so_hd_cl_quan
  AND  orig.status NOT IN ('cancelled', 'replaced_original', 'adjusted_original')
  AND  orig.deleted_at       IS NULL;

-- ── Show counts after fix ────────────────────────────────────────────────────
SELECT
  'After fix' AS phase,
  COUNT(*) FILTER (WHERE tc_hdon = 1 AND status = 'valid')            AS replacement_still_valid,
  COUNT(*) FILTER (WHERE tc_hdon = 2 AND status = 'valid')            AS adjustment_still_valid,
  COUNT(*) FILTER (WHERE tc_hdon = 2 AND status = 'adjusted')         AS adjustment_still_wrong,
  COUNT(*) FILTER (WHERE status = 'replaced')                          AS replaced_count,
  COUNT(*) FILTER (WHERE status = 'replaced_original')                 AS replaced_original_count,
  COUNT(*) FILTER (WHERE status = 'adjusted')                          AS adjusted_count,
  COUNT(*) FILTER (WHERE status = 'adjusted_original')                 AS adjusted_original_count
FROM invoices
WHERE deleted_at IS NULL;

COMMIT;
