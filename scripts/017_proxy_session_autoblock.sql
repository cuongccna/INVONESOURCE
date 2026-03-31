-- Migration 017: Proxy session autoblock for GDT bot
-- Replaces JS version — pure SQL, idempotent

ALTER TABLE gdt_bot_configs
  ADD COLUMN IF NOT EXISTS proxy_session_id     VARCHAR(32)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0;
