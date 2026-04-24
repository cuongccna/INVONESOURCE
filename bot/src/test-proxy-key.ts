/**
 * Diagnostic script — test static proxy connectivity.
 * Run:  npx ts-node -r dotenv/config src/test-proxy-key.ts
 */
import { ProxyManager } from './proxy-manager';

async function main() {
  const proxyList = (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (proxyList.length === 0) {
    console.error('ERROR: PROXY_LIST is not set in .env');
    process.exit(1);
  }

  console.log(`\nTesting static proxy pool: ${proxyList.length} proxies\n`);
  const manager = new ProxyManager(proxyList);

  for (const proxyUrl of proxyList) {
    const masked = proxyUrl.replace(/:([^@:]+)@/, ':***@');
    process.stdout.write(`  Probing ${masked} … `);
    const ok = await manager.probe(proxyUrl, 8_000);
    console.log(ok ? '✓ reachable' : '✗ unreachable');
  }

  console.log(`\nPool size: ${manager.size}, failed: ${manager.failedCount}`);
  console.log(manager.failedCount === 0 ? '\n✅ All proxies reachable!' : '\n⚠ Some proxies unreachable — check PROXY_LIST.');
}

main().catch(err => { console.error('Unhandled error:', err); process.exit(1); });
