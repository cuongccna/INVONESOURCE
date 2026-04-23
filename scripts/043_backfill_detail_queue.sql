-- BOT-REFACTOR-04: Backfill invoice_detail_queue for existing invoices missing raw_detail.
--
-- Enqueues ALL serial types (C and K) — K-series have /detail JSON API too.
-- Priority 10 = lowest (backfill), so new real-time syncs always take precedence.
-- ON CONFLICT DO NOTHING = idempotent, safe to run multiple times.
--
-- Run during off-peak hours (e.g. 2 AM). Use LIMIT if table is very large:
--   INSERT INTO invoice_detail_queue ... SELECT ... LIMIT 50000;

INSERT INTO invoice_detail_queue
  (invoice_id, company_id, nbmst, khhdon, shdon, is_sco, status, priority, enqueued_at)
SELECT
  i.id,
  i.company_id,
  i.seller_tax_code,
  i.serial_number,
  i.invoice_number,
  COALESCE(i.is_sco, false),
  'pending',
  10,    -- priority 10 = backfill (lowest — real-time syncs use 1 or 5)
  NOW()
FROM invoices i
WHERE i.raw_detail        IS NULL
  AND i.deleted_at        IS NULL
  AND i.status            NOT IN ('cancelled')
  AND i.seller_tax_code   IS NOT NULL AND i.seller_tax_code <> ''
  AND i.serial_number     IS NOT NULL AND i.serial_number   <> ''
  AND i.invoice_number    IS NOT NULL AND i.invoice_number  <> ''
  -- NO serial filter: K-series (K26TAX, K26MTK...) also have /detail JSON API
ON CONFLICT (invoice_id) DO NOTHING;

-- Verification
SELECT
  status,
  COUNT(*) AS count
FROM invoice_detail_queue
GROUP BY status
ORDER BY status;
