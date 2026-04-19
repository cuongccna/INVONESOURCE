-- Migration 033: Static Proxy Pool for manual sync
-- Manages a pool of static residential proxies assigned to users/companies

-- ── static_proxies ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS static_proxies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host            VARCHAR(255)  NOT NULL,
  port            INT           NOT NULL,
  protocol        VARCHAR(10)   NOT NULL DEFAULT 'http',   -- http | https | socks5
  username        VARCHAR(255),
  password        VARCHAR(255),
  label           VARCHAR(100),                             -- e.g. "VN Residential #1"
  country         VARCHAR(10)   DEFAULT 'VN',
  status          VARCHAR(20)   NOT NULL DEFAULT 'active',  -- active | blocked | quarantine
  assigned_user_id UUID          REFERENCES users(id) ON DELETE SET NULL,
  assigned_at     TIMESTAMPTZ,
  blocked_reason  TEXT,
  blocked_at      TIMESTAMPTZ,
  last_health_check    TIMESTAMPTZ,
  last_health_status   BOOLEAN,                             -- true = healthy, false = failed
  expires_at      TIMESTAMPTZ,                              -- proxy expiry date
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_proxy_status CHECK (status IN ('active', 'blocked', 'quarantine'))
);

-- Index for finding available proxies quickly
CREATE INDEX IF NOT EXISTS idx_static_proxies_status ON static_proxies(status)
  WHERE status = 'active' AND assigned_user_id IS NULL;

-- Index for looking up user's assigned proxy
CREATE INDEX IF NOT EXISTS idx_static_proxies_user ON static_proxies(assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

-- ── proxy_assignments (audit log) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proxy_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proxy_id    UUID          NOT NULL REFERENCES static_proxies(id) ON DELETE CASCADE,
  user_id     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  UUID          REFERENCES companies(id) ON DELETE SET NULL,
  action      VARCHAR(20)   NOT NULL DEFAULT 'assign',     -- assign | release | auto_rotate | blocked
  reason      TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proxy_assignments_proxy ON proxy_assignments(proxy_id);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_user  ON proxy_assignments(user_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_static_proxies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_static_proxies_updated_at ON static_proxies;
CREATE TRIGGER trg_static_proxies_updated_at
  BEFORE UPDATE ON static_proxies
  FOR EACH ROW EXECUTE FUNCTION update_static_proxies_updated_at();
