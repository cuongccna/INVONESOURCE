/**
 * Diagnostic script — test 2Captcha API key and full captcha solve pipeline.
 *
 * Tests (in order):
 *   1. Check API key balance via /res.php?action=getbalance
 *   2. Fetch a live captcha image from GDT portal (needs proxy if configured)
 *   3. Convert SVG → PNG via sharp
 *   4. Submit to 2captcha and poll for result
 *
 * Run:
 *   npx ts-node -r dotenv/config src/test-captcha.ts
 *   npx ts-node -r dotenv/config src/test-captcha.ts --skip-gdt   (skip GDT fetch, use dummy PNG)
 */
import axios from 'axios';
import { CaptchaService } from './captcha.service';

const TWOCAPTCHA_API    = 'https://2captcha.com';
// Port 30000 is the actual GDT REST API port (not the public HTTPS portal port 443)
const GDT_CAPTCHA_BASE  = 'http://hoadondientu.gdt.gov.vn:30000';
const GDT_CAPTCHA_PATH  = '/captcha';

const skipGdt = process.argv.includes('--skip-gdt');

async function checkBalance(apiKey: string): Promise<number> {
  const res = await axios.get<string>(`${TWOCAPTCHA_API}/res.php`, {
    params: { key: apiKey, action: 'getbalance' },
    timeout: 10_000,
    responseType: 'text',
  });
  const body = String(res.data).trim();
  // ERROR_WRONG_USER_KEY, ERROR_KEY_DOES_NOT_EXIST, ERROR_ZERO_BALANCE, etc.
  if (body.startsWith('ERROR')) throw new Error(`2captcha balance check: ${body}`);
  return parseFloat(body);
}

async function getProxyUrl(): Promise<string | undefined> {
  // 1. Explicit PROXY_URL or PROXY_LIST env (manual override)
  const explicit = process.env['PROXY_URL']
    ?? (process.env['PROXY_LIST'] ?? '').split(',')[0]?.trim()
    ?? undefined;
  if (explicit) return explicit;

  // 2. TMProxy — same env vars as bot (TMPROXY_API_KEYS or TMPROXY_API_KEY)
  const keysEnv  = process.env['TMPROXY_API_KEYS'] ?? '';
  const singleEnv = process.env['TMPROXY_API_KEY']?.trim() ?? '';
  const key = keysEnv.split(',').map(s => s.trim()).filter(Boolean)[0]
             ?? (singleEnv || undefined);
  if (key) {
    const { TmproxyRefresher } = await import('./tmproxy-refresher');
    const refresher = new TmproxyRefresher(key);
    const session   = await refresher.getCurrent();
    console.log(`  ✓ TMProxy session: ip=${session.publicIp}`);
    return session.url;
  }
  return undefined;
}

async function fetchGdtCaptchaSvg(proxyUrl?: string): Promise<{ key: string; svgContent: string }> {
  const { createTunnelAgent } = await import('./proxy-tunnel');
  const agent = proxyUrl ? createTunnelAgent({ proxyUrl }) : undefined;
  const res = await axios.get<unknown>(GDT_CAPTCHA_PATH, {
    baseURL: GDT_CAPTCHA_BASE,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'vi-VN,vi;q=0.9',
      'Origin': 'https://hoadondientu.gdt.gov.vn',
      'Referer': 'https://hoadondientu.gdt.gov.vn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    timeout: 20_000,
    ...(agent ? { httpAgent: agent } : {}),
  });
  const data = res.data as Record<string, unknown>;
  if (!data?.['content']) {
    throw new Error(`GDT captcha response missing 'content'. Raw: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { key: String(data['key'] ?? ''), svgContent: String(data['content']) };
}

async function svgToPngBase64(svgContent: string): Promise<string> {
  const { default: sharp } = await import('sharp');
  const pngBuffer = await sharp(Buffer.from(svgContent)).png().toBuffer();
  return pngBuffer.toString('base64');
}

async function main() {
  const apiKey = process.env['TWO_CAPTCHA_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('❌ TWO_CAPTCHA_API_KEY is not set in .env');
    process.exit(1);
  }
  console.log(`\n=== 2Captcha Diagnostic ===`);
  console.log(`API key: ${apiKey.slice(0, 8)}…\n`);

  // ── Step 1: Balance check ─────────────────────────────────────────────────
  console.log('[1/4] Checking 2captcha account balance…');
  try {
    const balance = await checkBalance(apiKey);
    if (balance <= 0) {
      console.error(`  ❌ Balance is $${balance} — TOP UP YOUR 2CAPTCHA ACCOUNT!`);
      console.error('     Go to https://2captcha.com/pay and add funds.');
    } else {
      console.log(`  ✓ Balance: $${balance.toFixed(4)}`);
    }
    if (balance < 0.1) {
      console.warn('  ⚠ Balance is low (< $0.1). Top up soon to avoid captcha failures.');
    }
  } catch (err) {
    console.error(`  ❌ Balance check failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 2: Fetch GDT captcha SVG ────────────────────────────────────────
  let svgContent = '';
  let captchaKey = '';
  if (skipGdt) {
    console.log('\n[2/4] --skip-gdt flag set — using 1×1 dummy PNG instead of GDT captcha…');
    // Minimal valid 1×1 transparent PNG (base64) as stand-in
    svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text y="30" font-size="20">TEST</text></svg>';
    captchaKey  = 'SKIP';
  } else {
    console.log('\n[2/4] Resolving proxy for GDT connection…');
    let proxyUrl: string | undefined;
    try {
      proxyUrl = await getProxyUrl();
    } catch (err) {
      console.warn(`  ⚠ Could not get proxy: ${(err as Error).message}`);
    }

    console.log(`  → ${proxyUrl ? `via proxy ${proxyUrl.replace(/:([^@:]+)@/, ':***@')}` : 'direct connection (no proxy configured)'}`);
    console.log(`  → URL: ${GDT_CAPTCHA_BASE}${GDT_CAPTCHA_PATH}`);
    try {
      const result = await fetchGdtCaptchaSvg(proxyUrl);
      svgContent = result.svgContent;
      captchaKey = result.key;
      const svgPreview = svgContent.slice(0, 120).replace(/\n/g, ' ');
      console.log(`  ✓ Got SVG (key=${captchaKey}, length=${svgContent.length}): ${svgPreview}…`);
    } catch (err) {
      console.error(`  ❌ Failed to fetch GDT captcha: ${(err as Error).message}`);
      console.error('     Tip: if you need the proxy, set PROXY_URL=http://user:pass@ip:port in .env');
      console.error('     Or run with --skip-gdt to skip the GDT fetch step');
      process.exit(1);
    }
  }

  // ── Step 3: SVG → PNG conversion ─────────────────────────────────────────
  console.log('\n[3/4] Converting SVG → PNG via sharp…');
  let base64: string;
  try {
    base64 = await svgToPngBase64(svgContent);
    console.log(`  ✓ PNG size: ${Math.round(base64.length * 0.75 / 1024)} KB (base64 len=${base64.length})`);
  } catch (err) {
    console.error(`  ❌ sharp SVG→PNG failed: ${(err as Error).message}`);
    console.error('     Ensure sharp is installed: cd bot && npm install sharp');
    process.exit(1);
  }

  // ── Step 4: Submit to 2captcha ────────────────────────────────────────────
  console.log('\n[4/4] Submitting to 2captcha and polling for result (up to 120s)…');
  try {
    const svc = new CaptchaService(apiKey);
    const start = Date.now();
    const { text, captchaId } = await svc.solve(base64);
    const elapsedMs = Date.now() - start;
    console.log(`  ✓ Solved in ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`  ✓ captchaId : ${captchaId}`);
    console.log(`  ✓ solved text: "${text}"`);
    if (captchaKey !== 'SKIP') {
      console.log(`  ✓ captcha key (ckey for auth): ${captchaKey}`);
    }
    console.log('\n✅ 2Captcha pipeline is working correctly!');
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`  ❌ 2captcha solve failed: ${msg}`);
    if (msg.includes('ERROR_ZERO_BALANCE')) {
      console.error('     → TOP UP your 2captcha.com account balance');
    } else if (msg.includes('ERROR_WRONG_USER_KEY') || msg.includes('ERROR_KEY_DOES_NOT_EXIST')) {
      console.error('     → TWO_CAPTCHA_API_KEY in .env is invalid — check https://2captcha.com/setting');
    } else if (msg.includes('timeout')) {
      console.error('     → 2captcha is taking too long. Check https://2captcha.com/stat');
    } else {
      console.error('     → Unexpected error. Check above for details.');
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
