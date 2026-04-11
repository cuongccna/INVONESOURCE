-- ============================================================
-- Migration 020 — GDT Raw Cache Layer (Prompt 42)
-- Run: psql -U <user> -d invone_db -f scripts/020_gdt_raw_cache.sql
--
-- Adds two new tables:
--   gdt_raw_cache        — GDT Local Mirror: parsed invoice JSON + MD5 hash
--   gdt_sync_queue_log   — Dedup guard + audit log for sync jobs
--
-- Does NOT modify invoices, invoice_items, or any existing table.
-- ============================================================

-- ── 1. GDT Raw Cache ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdt_raw_cache (
  id                BIGSERIAL     PRIMARY KEY,

  -- Identity
  mst               VARCHAR(20)   NOT NULL,
  invoice_type      VARCHAR(10)   NOT NULL CHECK (invoice_type IN ('purchase', 'sale')),

  -- GDT invoice identifiers (from XML fields)
  ma_hoa_don        VARCHAR(100),           -- MCCQT from GDT (mã cơ quan thuế — unique GDT ID)
  so_hoa_don        VARCHAR(50),            -- SHDon
  ky_hieu_mau       VARCHAR(20),            -- KHMSHDon
  ky_hieu_hoa_don   VARCHAR(20),            -- KHHDon
  ngay_lap          DATE,                   -- NLap

  -- MST seller/buyer for quick lookup
  mst_nguoi_ban     VARCHAR(20),            -- NBan.MST
  mst_nguoi_mua     VARCHAR(20),            -- NMua.MST

  -- Period for batch queries
  period_year       SMALLINT      NOT NULL,
  period_month      SMALLINT,               -- NULL if quarterly/yearly query

  -- The full parsed JSON (from GDT XML, all fields preserved)
  raw_json          JSONB         NOT NULL,

  -- Change detection: MD5 hash of raw XML string before parsing
  -- If hash unchanged on re-fetch → skip update, no proxy wasted
  content_hash      VARCHAR(32)   NOT NULL,

  -- Sync metadata
  fetched_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  source_xml_size   INT,                    -- bytes of original XML (monitoring)
  gdt_tthai         SMALLINT,              -- trạng thái hóa đơn từ GDT list (1=hợp lệ, 2=thay thế…)
  gdt_ttxly         SMALLINT,              -- trạng thái xử lý

  -- Soft delete flag for business logic
  is_deleted        BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Timestamps
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_gdt_raw_cache
    UNIQUE (mst, invoice_type, ma_hoa_don)
);

-- Primary lookup: business logic reads by mst + type + period
CREATE INDEX IF NOT EXISTS idx_raw_cache_period
  ON gdt_raw_cache (mst, invoice_type, period_year, period_month);

-- Change detection lookup
CREATE INDEX IF NOT EXISTS idx_raw_cache_hash
  ON gdt_raw_cache (mst, invoice_type, content_hash);

-- Freshness check
CREATE INDEX IF NOT EXISTS idx_raw_cache_fetched
  ON gdt_raw_cache (fetched_at DESC);

-- JSONB GIN index for flexible querying on raw_json
CREATE INDEX IF NOT EXISTS idx_raw_cache_json
  ON gdt_raw_cache USING GIN (raw_json);

-- ngay_lap extracted field index for date-range queries
CREATE INDEX IF NOT EXISTS idx_raw_cache_ngay_lap
  ON gdt_raw_cache (ngay_lap);

-- Soft-delete filter (most queries exclude deleted entries)
CREATE INDEX IF NOT EXISTS idx_raw_cache_not_deleted
  ON gdt_raw_cache (mst, invoice_type, period_year)
  WHERE is_deleted = FALSE;

-- ── 2. Sync Queue Dedup Log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gdt_sync_queue_log (
  id               BIGSERIAL     PRIMARY KEY,
  mst              VARCHAR(20)   NOT NULL,
  invoice_type     VARCHAR(10)   NOT NULL,
  period_year      SMALLINT      NOT NULL,
  period_month     SMALLINT,
  job_id           VARCHAR(100),            -- BullMQ job ID
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending',
    -- pending | running | done | failed | skipped
  triggered_by     VARCHAR(20)   NOT NULL DEFAULT 'scheduler',
    -- scheduler | user | retry
  enqueued_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  invoices_found   INT,
  invoices_updated INT,
  invoices_skipped INT,           -- hash unchanged, skipped (proxy saved)
  error_message    TEXT,

  CONSTRAINT uq_sync_queue_active
    UNIQUE (mst, invoice_type, period_year, period_month, status)
    DEFERRABLE INITIALLY DEFERRED
    -- Note: partial unique on status IN ('pending','running') not supported by all PG versions,
    -- so we use application-level guard + full unique with deferred constraint.
    -- syncQueueGuard.ts checks existing active jobs before INSERT.
);

-- Lookup by mst for UI status polling
CREATE INDEX IF NOT EXISTS idx_sync_queue_mst
  ON gdt_sync_queue_log (mst, status, enqueued_at DESC);

-- Active jobs lookup (dedup guard)
CREATE INDEX IF NOT EXISTS idx_sync_queue_active
  ON gdt_sync_queue_log (mst, invoice_type, period_year, period_month, status)
  WHERE status IN ('pending', 'running');
