-- 024_crawl_cache.sql
-- Add invoices_skipped counter to gdt_bot_runs

ALTER TABLE gdt_bot_runs
  ADD COLUMN IF NOT EXISTS invoices_skipped INT DEFAULT 0;
