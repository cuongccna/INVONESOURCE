-- 023_bypassrls_service_account.sql
-- The backend app user (user_invone) is a service account protected by
-- application-level auth (JWT + RBAC middleware). RLS policies that rely on
-- session variables (SET LOCAL app.current_user_id) are not set by the pool,
-- causing INSERT/UPDATE violations.
--
-- Granting BYPASSRLS lets the service account skip RLS entirely while keeping
-- RLS active for any direct DB access by other roles (e.g. read-only analysts).
--
-- Idempotent: running multiple times is safe.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'user_invone') THEN
    ALTER ROLE user_invone BYPASSRLS;
    RAISE NOTICE 'BYPASSRLS granted to user_invone';
  ELSE
    RAISE NOTICE 'Role user_invone not found — skipping';
  END IF;
END $$;
