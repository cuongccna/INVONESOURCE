/**
 * Quick test: custom tunnel agent + TMProxy auto-refresh
 * Run: npx ts-node -r dotenv/config src/test-proxy.ts
 */
import axios from 'axios';
import { createTunnelAgent } from './proxy-tunnel';
import { TmproxyRefresher } from './tmproxy-refresher';

// Use http:// because our tunnel agent does TLS inside createConnection.
// axios must use http.request (httpAgent) so it doesn't double-wrap TLS.
const GDT_HTTP = 'http://hoadondientu.gdt.gov.vn:30000';

async function main() {
  const apiKey = process.env['TMPROXY_API_KEY'];
  if (!apiKey) { console.error('TMPROXY_API_KEY not set'); process.exit(1); }

  // ── Step 1: get-current-proxy ───────────────────────────────────────────────
  console.log('=== Step 1: get-current-proxy ===');
  const refresher = new TmproxyRefresher(apiKey);
  const cur = await refresher.getCurrent();
  console.log('Public IP :', cur.publicIp);
  console.log('URL       :', cur.url.replace(/:([^:@]+)@/, ':***@'));
  console.log('Expires   :', cur.expiresAt.toISOString());
  console.log('Min rotate:', cur.minRefreshMs / 1000, 'sec');

  // ── Step 2: check IP via proxy ─────────────────────────────────────────────
  console.log('\n=== Step 2: check public IP via proxy ===');
  // Must use explicit port 443 — our agent does TLS, so port must be the TLS port.
  // http:// scheme with explicit :443 makes axios pass port=443 to createConnection.
  const ipAgent  = createTunnelAgent({ proxyUrl: cur.url });
  const ipClient = axios.create({ baseURL: 'http://api.ipify.org:443', httpAgent: ipAgent, timeout: 12_000 });
  const ipRes    = await ipClient.get<{ ip: string }>('/?format=json');
  console.log('Confirmed public IP:', ipRes.data.ip, ipRes.data.ip === cur.publicIp ? '✅ matches' : '⚠️ mismatch');

  // ── Step 3: GDT captcha via proxy ──────────────────────────────────────────
  console.log('\n=== Step 3: GDT /captcha via proxy ===');
  const gdtAgent  = createTunnelAgent({ proxyUrl: cur.url });
  const gdtClient = axios.create({ baseURL: GDT_HTTP, httpAgent: gdtAgent, timeout: 12_000 });
  const cap = await gdtClient.get<{ key: string; content: string }>('/captcha');
  console.log('GDT status :', cap.status);
  console.log('Captcha key:', cap.data.key);
  console.log('SVG length :', cap.data.content?.length);

  console.log('\n✅ All steps passed — proxy tunnel + TMProxy API working!');
}

main().catch(e => { console.error('\n❌ FAILED:', e.message); process.exit(1); });
