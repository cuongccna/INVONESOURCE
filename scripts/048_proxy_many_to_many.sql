-- Migration 048: Proxy Many-to-Many — 1 IP can be assigned to multiple users
--
-- Previously: static_proxies.assigned_user_id enforced one-user-per-proxy at the
-- application level (POST /assign released all previous assignments first).
--
-- New model: proxy_user_assignments_v2 junction table allows Admin to freely assign
-- any IP to any number of users. Users with assigned proxies ONLY use those proxies
-- (bot will not fall back to the unassigned pool if assignments exist).
--
-- Existing assigned_user_id data is migrated to the junction table.
-- The assigned_user_id and assigned_at columns are then dropped.

BEGIN;

-- ── 1. Create junction table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proxy_user_assignments_v2 (
  proxy_id    UUID        NOT NULL REFERENCES static_proxies(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id)          ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (proxy_id, user_id)
);

-- Index for fast "get all proxies for a user" lookups (bot hot path)
CREATE INDEX IF NOT EXISTS idx_pua_v2_user ON proxy_user_assignments_v2 (user_id);

-- ── 2. Migrate existing assignments ─────────────────────────────────────────
INSERT INTO proxy_user_assignments_v2 (proxy_id, user_id, assigned_at)
SELECT id, assigned_user_id, COALESCE(assigned_at, NOW())
FROM static_proxies
WHERE assigned_user_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── 3. Drop deprecated columns from static_proxies ──────────────────────────
ALTER TABLE static_proxies DROP COLUMN IF EXISTS assigned_user_id;
ALTER TABLE static_proxies DROP COLUMN IF EXISTS assigned_at;

COMMIT;
