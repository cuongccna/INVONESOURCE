/**
 * Diagnostic script — test TMProxy API key connectivity.
 * Run:  npx ts-node -r dotenv/config src/test-proxy-key.ts
 */
import { TmproxyRefresher, TmproxyNoSessionError } from './tmproxy-refresher';

async function main() {
  const apiKey = process.env['TMPROXY_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('ERROR: TMPROXY_API_KEY is not set in .env');
    process.exit(1);
  }

  console.log(`\nTesting TMProxy API key: ${apiKey.slice(0, 8)}…\n`);
  const refresher = new TmproxyRefresher(apiKey);

  // ── Step 1: get-current-proxy ─────────────────────────────────────────────
  console.log('[1/2] Calling getCurrent() (get-current-proxy) …');
  try {
    const session = await refresher.getCurrent();
    console.log('  ✓ getCurrent() succeeded:');
    console.log(`      publicIp  : ${session.publicIp}`);
    console.log(`      url       : ${session.url.replace(/:([^@]+)@/, ':***@')}`);
    console.log(`      expiresAt : ${session.expiresAt.toISOString()}`);
    console.log(`      cooldownMs: ${session.minRefreshMs}`);
  } catch (err) {
    if (err instanceof TmproxyNoSessionError) {
      console.warn(`  ⚠ getCurrent() returned code=${err.code} (no active session yet).`);
      console.warn('    This is the expected cause of the "No proxy available" error.');
      console.warn('    Proceeding to getNew() to start a session …\n');
    } else {
      console.error('  ✗ getCurrent() failed with unexpected error:', (err as Error).message);
      process.exit(1);
    }
  }

  // ── Step 2: get-new-proxy ─────────────────────────────────────────────────
  console.log('\n[2/2] Calling getNew() (get-new-proxy) …');
  try {
    const session = await refresher.getNew();
    console.log('  ✓ getNew() succeeded (new session started):');
    console.log(`      publicIp  : ${session.publicIp}`);
    console.log(`      url       : ${session.url.replace(/:([^@]+)@/, ':***@')}`);
    console.log(`      expiresAt : ${session.expiresAt.toISOString()}`);
    console.log(`      cooldownMs: ${session.minRefreshMs}`);
    console.log('\n✓ Proxy key is working. Restart the bot — it will now pick up the active session.');
  } catch (err) {
    console.error('  ✗ getNew() failed:', (err as Error).message);
    console.error('    Possible causes: key balance expired, invalid API key, network error.');
    process.exit(1);
  }
}

main().catch(err => { console.error('Unhandled error:', err); process.exit(1); });
