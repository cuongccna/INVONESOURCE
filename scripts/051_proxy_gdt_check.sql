-- Migration 051: GDT block-check result columns on static_proxies
--
-- Stores the result of the admin-initiated "check which proxy IPs are blocked
-- by GDT" feature.  Admin presses a button → backend sends an HTTP CONNECT
-- tunnel request through each proxy to hoadondientu.gdt.gov.vn:443 — if the
-- tunnel times out the proxy's IP is being blackholed by GDT.
--
-- gdt_check_status values:
--   'reachable'       — tunnel succeeded; GDT is reachable through this proxy
--   'gdt_blocked'     — proxy connected OK but GDT TCP-blackholed the tunnel
--   'proxy_error'     — could not connect to the proxy server itself
--   'proxy_auth_fail' — proxy rejected CONNECT with 407 (wrong credentials)

ALTER TABLE static_proxies
  ADD COLUMN IF NOT EXISTS gdt_check_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gdt_check_status VARCHAR(20),
  ADD COLUMN IF NOT EXISTS gdt_check_ms     INTEGER;

COMMENT ON COLUMN static_proxies.gdt_check_at     IS 'When the last GDT reachability check was run';
COMMENT ON COLUMN static_proxies.gdt_check_status IS 'Result: reachable | gdt_blocked | proxy_error | proxy_auth_fail';
COMMENT ON COLUMN static_proxies.gdt_check_ms     IS 'Round-trip latency in ms for the CONNECT tunnel (NULL if timed-out)';
