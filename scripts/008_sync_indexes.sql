-- ============================================================
-- 008_sync_indexes.sql — Sync Engine Performance Indexes
-- Run after 001_init.sql is applied.
-- All indexes are CONCURRENTLY so they never lock the table.
-- ============================================================

-- Invoice upsert / sync lookup: find most recently synced invoices per company+provider
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_sync
  ON invoices(company_id, provider, sync_at DESC);

-- Primary analytical query: company + date range + direction + status
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_period
  ON invoices(company_id, invoice_date, direction, status)
  WHERE deleted_at IS NULL;

-- VAT reconciliation: sum by seller (output) / buyer (input)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_seller
  ON invoices(company_id, seller_tax_code)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_buyer
  ON invoices(company_id, buyer_tax_code)
  WHERE deleted_at IS NULL;

-- GDT validation queue: find un-validated input invoices fast
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_gdt_pending
  ON invoices(company_id, direction, gdt_validated)
  WHERE gdt_validated = false AND deleted_at IS NULL;

-- Sync logs: latest N logs per company (dashboard widget)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_logs_company
  ON sync_logs(company_id, started_at DESC);

-- Company connectors: active connectors with circuit breaker state
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_connectors_enabled
  ON company_connectors(company_id, enabled, circuit_state)
  WHERE enabled = true;

-- Upsert deduplication: the unique constraint already handles this,
-- but a covering index speeds up the ON CONFLICT lookup significantly.
-- Note: this replicates the unique constraint in a form that the planner prefers.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inv_upsert_key
  ON invoices(company_id, provider, invoice_number, seller_tax_code, invoice_date)
  WHERE deleted_at IS NULL;
