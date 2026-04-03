-- Migration 026: Group 51 — Bot Enterprise Scale Tables + Columns
-- Tables: raw_invoice_data, bot_failed_jobs
-- Columns: gdt_bot_configs extensions for jitter & working_hours

-- ─── Raw Data Lake: save raw XML/HTML before parsing ─────────────────────────
CREATE TABLE IF NOT EXISTS raw_invoice_data (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_number  VARCHAR(100) NOT NULL,
  serial_number   VARCHAR(50),
  direction       VARCHAR(10) DEFAULT 'output' CHECK (direction IN ('input','output')),
  data_type       VARCHAR(10) NOT NULL DEFAULT 'xml' CHECK (data_type IN ('xml','html','json')),
  raw_content     TEXT        NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parsed_at       TIMESTAMPTZ,
  parse_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (parse_status IN ('pending','success','failed')),
  parse_error     TEXT,
  UNIQUE(company_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_raw_invoices_parse_pending
  ON raw_invoice_data(company_id)
  WHERE parse_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_raw_invoices_parse_failed
  ON raw_invoice_data(company_id)
  WHERE parse_status = 'failed';
CREATE INDEX IF NOT EXISTS idx_raw_invoices_fetched
  ON raw_invoice_data(company_id, fetched_at DESC);

-- ─── Dead Letter Queue: persist permanently failed bot jobs ──────────────────
CREATE TABLE IF NOT EXISTS bot_failed_jobs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_job_id  VARCHAR(100),
  company_id       UUID        REFERENCES companies(id),
  queue_name       VARCHAR(50),
  job_data         JSONB,
  error_message    TEXT,
  error_type       VARCHAR(50),
  -- 'GdtStructuralError'|'UnrecoverableError'|'Error'
  attempts         SMALLINT    NOT NULL DEFAULT 0,
  failed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_reviewed   BOOLEAN     NOT NULL DEFAULT false,
  retry_count      SMALLINT    NOT NULL DEFAULT 0,
  resolution       VARCHAR(50),
  -- 'retried'|'dismissed'|'credential_issue'|'gdt_change'
  resolved_at      TIMESTAMPTZ,
  resolved_by      UUID        REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_bot_failed_unreviewed
  ON bot_failed_jobs(failed_at DESC)
  WHERE admin_reviewed = false;
CREATE INDEX IF NOT EXISTS idx_bot_failed_company
  ON bot_failed_jobs(company_id, failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_failed_type
  ON bot_failed_jobs(error_type, failed_at DESC);

-- ─── gdt_bot_configs: jitter + working hours columns ─────────────────────────
ALTER TABLE gdt_bot_configs
  ADD COLUMN IF NOT EXISTS next_auto_sync_at          TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS preferred_sync_hour_start  SMALLINT    DEFAULT 8,
  ADD COLUMN IF NOT EXISTS preferred_sync_hour_end    SMALLINT    DEFAULT 18;
-- preferred_sync_hour_start/end: VN local time (UTC+7)

-- Backfill: schedule existing active configs to run soon
UPDATE gdt_bot_configs
  SET next_auto_sync_at = NOW() + INTERVAL '30 minutes'
  WHERE is_active = true AND next_auto_sync_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bot_configs_next_sync
  ON gdt_bot_configs(next_auto_sync_at, is_active, blocked_until)
  WHERE is_active = true;
