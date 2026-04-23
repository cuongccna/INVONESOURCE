-- BOT-REFACTOR-04: Phase 2 coordination table.
-- Phase 1 (sync worker) → INSERT after each invoice upsert.
-- Phase 2 (detail worker) → poll, claim, process, mark done.
-- UNIQUE(invoice_id) ensures detail is never fetched twice for the same invoice.
--
-- ALL serial types (C and K) are enqueued — both have /detail JSON API (HTTP 200):
--   C-series (ttxly=5): /detail returns full data + XML available
--   K-series (ttxly=6/8): /detail returns full JSON data, no XML file
-- is_sco routes to the correct GDT endpoint in Phase 2:
--   true  → /sco-query/invoices/detail (HĐ máy tính tiền MTTTT)
--   false → /query/invoices/detail     (HĐ điện tử + K-series)

CREATE TABLE IF NOT EXISTS invoice_detail_queue (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  company_id        UUID        NOT NULL,

  -- GDT API params — copied from invoices at enqueue time, immutable
  nbmst             TEXT        NOT NULL,   -- seller_tax_code (MST người bán)
  khhdon            TEXT        NOT NULL,   -- serial_number   (C26TAS, K26TAX, C26MTK...)
  shdon             TEXT        NOT NULL,   -- invoice_number  (số hóa đơn)
  is_sco            BOOLEAN     NOT NULL DEFAULT false,

  -- State machine: pending → processing → done / failed / skipped
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed','skipped')),

  priority          SMALLINT    NOT NULL DEFAULT 5,
  -- 1 = manual trigger (user đang chờ), 5 = auto background, 10 = backfill

  -- Retry tracking
  attempts          SMALLINT    NOT NULL DEFAULT 0,
  max_attempts      SMALLINT    NOT NULL DEFAULT 5,
  last_error        TEXT,
  last_attempted_at TIMESTAMPTZ,

  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at           TIMESTAMPTZ,

  UNIQUE (invoice_id)   -- absolute anti-duplicate guarantee
);

-- Worker polling: pending + failed ordered by priority then age
CREATE INDEX IF NOT EXISTS idx_idq_work
  ON invoice_detail_queue (company_id, priority ASC, enqueued_at ASC)
  WHERE status IN ('pending','failed');

-- Cleanup old done/skipped rows
CREATE INDEX IF NOT EXISTS idx_idq_done_at
  ON invoice_detail_queue (done_at)
  WHERE status IN ('done','skipped');

-- Fast lookup by company + status for progress API
CREATE INDEX IF NOT EXISTS idx_idq_company_status
  ON invoice_detail_queue (company_id, status);

COMMENT ON TABLE invoice_detail_queue IS
  'Coordination between Phase 1 (list sync) and Phase 2 (detail fetch). '
  'Phase 1 inserts a row per invoice after upsert; Phase 2 claims and processes them. '
  'ALL serial types (C and K) are enqueued — both have /detail JSON API. '
  'is_sco=true routes to /sco-query/invoices/detail (MTTTT), false to /query/invoices/detail.';
