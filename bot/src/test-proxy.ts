/**
 * Quick test: static proxy tunnel + GDT captcha endpoint reachability.
 * Run: npx ts-node -r dotenv/config src/test-proxy.ts
 */
import axios from 'axios';
import { createTunnelAgent } from './proxy-tunnel';
import { ProxyManager } from './proxy-manager';

// http:// because our tunnel agent does TLS inside createConnection.
const GDT_HTTP = 'http://hoadondientu.gdt.gov.vn:30000';

async function main() {
  const manager = new ProxyManager();
  const proxyUrl = manager.next();
  if (!proxyUrl) {
    console.error('No proxies configured — set PROXY_LIST in .env');
    process.exit(1);
  }

  const masked = proxyUrl.replace(/:([^:@]+)@/, ':***@');

  // ── Step 1: probe TCP connectivity ────────────────────────────────────────
  console.log('=== Step 1: TCP probe ===');
  const ok = await manager.probe(proxyUrl, 8_000);
  console.log(`Proxy: ${masked}`);
  console.log(`TCP:   ${ok ? '✅ reachable' : '❌ unreachable'}`);
  if (!ok) process.exit(1);

  // ── Step 2: check public IP via proxy ─────────────────────────────────────
  console.log('\n=== Step 2: check public IP via proxy ===');
  const ipAgent  = createTunnelAgent({ proxyUrl });
  const ipClient = axios.create({ baseURL: 'http://api.ipify.org:443', httpAgent: ipAgent, timeout: 12_000 });
  const ipRes    = await ipClient.get<{ ip: string }>('/?format=json');
  console.log('Public IP:', ipRes.data.ip);

  // ── Step 3: GDT captcha via proxy ──────────────────────────────────────────
  console.log('\n=== Step 3: GDT /captcha via proxy ===');
  const gdtAgent  = createTunnelAgent({ proxyUrl });
  const gdtClient = axios.create({ baseURL: GDT_HTTP, httpAgent: gdtAgent, timeout: 12_000 });
  const cap = await gdtClient.get<{ key: string; content: string }>('/captcha');
  console.log('GDT status :', cap.status);
  console.log('Captcha key:', cap.data.key);
  console.log('SVG length :', cap.data.content?.length);

  console.log('\n✅ All steps passed — static proxy tunnel working!');
}

main().catch(e => { console.error('\n❌ FAILED:', (e as Error).message); process.exit(1); });
