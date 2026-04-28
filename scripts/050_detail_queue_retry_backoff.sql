-- BOT-REFACTOR-04: Add next_retry_at for exponential backoff in detail.worker.
-- Without this, failed rows (e.g. HTTP 500) are re-claimed every poll cycle (~40s),
-- hammering GDT with the same broken invoices. Backoff: 5m → 15m → 45m → 2.25h → 3h.

ALTER TABLE invoice_detail_queue
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Replace the partial index used by claimBatch: add next_retry_at awareness
-- so failed rows are not re-indexed until their backoff window has passed.
DROP INDEX IF EXISTS idx_idq_work;
CREATE INDEX idx_idq_work
  ON invoice_detail_queue (company_id, priority ASC, enqueued_at ASC)
  WHERE status IN ('pending','failed');

COMMENT ON COLUMN invoice_detail_queue.next_retry_at IS
  'Earliest time this failed row may be re-claimed. NULL = claimable immediately (first attempt or pending). '
  'Computed as NOW() + backoff(attempts): 5m, 15m, 45m, 135m, 180m.';
