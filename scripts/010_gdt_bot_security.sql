-- Migration 010: GDT Bot + Manual Import Schema
-- Run after 009_gdt_viettel_validated.sql

-- ── 1. New connector provider values ──────────────────────────────────────
ALTER TYPE invoice_provider ADD VALUE IF NOT EXISTS 'gdt_bot';
ALTER TYPE invoice_provider ADD VALUE IF NOT EXISTS 'manual_import';

-- Disable existing provider connectors (soft-disable, not delete)
UPDATE company_connectors
SET enabled = false,
    notes = 'Disabled: provider only stores outgoing invoices. Use GDT Bot instead.'
WHERE provider IN ('misa', 'viettel', 'bkav')
  AND (notes IS NULL OR notes NOT LIKE '%Disabled%');

-- ── 2. GDT Bot configs table (one per company) ────────────────────────────
CREATE TABLE IF NOT EXISTS gdt_bot_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_code              VARCHAR(20)  NOT NULL,
  encrypted_credentials  TEXT         NOT NULL,   -- AES-256-GCM format matching backend encryption.ts
  has_otp               BOOLEAN      DEFAULT false,
  otp_method            VARCHAR(20),             -- 'sms' | 'email' | 'app'
  proxy_url             TEXT,                    -- optional per-tenant proxy
  is_active             BOOLEAN      DEFAULT true,
  sync_frequency_hours  SMALLINT     DEFAULT 6,
  last_run_at           TIMESTAMPTZ,
  last_run_status        VARCHAR(20),             -- 'success'|'error'|'otp_required'|'blocked'|'pending'
  last_run_output_count  INT          DEFAULT 0,
  last_run_input_count   INT          DEFAULT 0,
  last_error             TEXT,
  consecutive_failures   SMALLINT     DEFAULT 0,
  blocked_until          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(company_id)
);

-- ── 3. Bot run logs (audit trail) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdt_bot_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL,
  status       VARCHAR(20),
  output_count INT   DEFAULT 0,
  input_count  INT   DEFAULT 0,
  duration_ms  INT,
  error_detail TEXT,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

-- ── 4. Row-Level Security on gdt_bot_configs ──────────────────────────────
ALTER TABLE gdt_bot_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gdt_bot_configs_isolation ON gdt_bot_configs;
CREATE POLICY gdt_bot_configs_isolation ON gdt_bot_configs
  USING (
    company_id IN (
      SELECT company_id FROM user_companies
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- ── 5. Manual import sessions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID REFERENCES companies(id) ON DELETE CASCADE,
  imported_by      UUID REFERENCES users(id),
  filename         VARCHAR(500),
  format           VARCHAR(30),   -- 'gdt_xml'|'gdt_excel'|'csv'|'custom_excel'
  direction        VARCHAR(10),   -- 'input'|'output'
  total_rows       INT,
  success_count    INT DEFAULT 0,
  error_count      INT DEFAULT 0,
  duplicate_count  INT DEFAULT 0,
  error_details    JSONB,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Column mapping templates for custom Excel imports
CREATE TABLE IF NOT EXISTS import_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  name            VARCHAR(200) NOT NULL,
  column_mapping  JSONB NOT NULL,  -- { invoice_number: 'A', invoice_date: 'B', ... }
  date_format     VARCHAR(20)  DEFAULT 'dd/MM/yyyy',
  decimal_sep     VARCHAR(5)   DEFAULT '.',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5b. Temporary file buffer table (cleaned up after /execute) ──────────
CREATE TABLE IF NOT EXISTS import_temp_files (
  id          UUID PRIMARY KEY,
  company_id  UUID NOT NULL,
  filename    VARCHAR(500),
  buffer      BYTEA NOT NULL,
  format      VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_temp_files_created ON import_temp_files(created_at);

-- ── 6. Link invoices to import session ────────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS import_session_id UUID REFERENCES import_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'connector';
-- source values: 'gdt_bot' | 'manual_import' | 'connector' | 'gdt_intermediary'

-- ── 7. Performance indexes ────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_import_session
  ON invoices(import_session_id) WHERE import_session_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_source
  ON invoices(company_id, source);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_dashboard
  ON invoices(company_id, invoice_date DESC, direction, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gdt_bot_runs_company
  ON gdt_bot_runs(company_id, started_at DESC);
