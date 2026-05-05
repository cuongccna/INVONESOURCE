-- Migration 056: Add trigger_source to gdt_bot_runs
-- Distinguishes manual (user-clicked) vs scheduled (auto-sync) bot runs in the UI.

ALTER TABLE gdt_bot_runs
  ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(30)
    CHECK (trigger_source IN ('user_manual', 'user_quick_sync', 'scheduled_auto', 'admin_retry'));
