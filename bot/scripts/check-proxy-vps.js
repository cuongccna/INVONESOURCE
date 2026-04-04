/*
 * Proxy diagnostics for VPS (Node 18+)
 *
 * What this script checks:
 * 1) Resolve proxy config from .env (TMProxy key(s) or PROXY_LIST)
 * 2) Query TMProxy current session (if API key is set)
 * 3) Test GDT /captcha over HTTP CONNECT proxy tunnel
 * 4) Test GDT /captcha over SOCKS5 tunnel (if available)
 * 5) Test binary stream stability (multiple rounds) over both tunnels
 *
 * Usage:
 *   cd /opt/INVONESOURCE/bot
 *   node scripts/check-proxy-vps.js
 *
 * Optional env overrides:
 *   TEST_ROUNDS=5 TEST_TIMEOUT_MS=45000 TEST_BINARY_URL=http://speed.hetzner.de:443/1MB.bin
 */

require('dotenv').config();

const axios = require('axios');
const { createTunnelAgent, createSocks5TunnelAgent } = require('../dist/proxy-tunnel');

const GDT_BASE_HTTP = 'http://hoadondientu.gdt.gov.vn:30000';
const DEFAULT_BINARY_URL = 'http://speed.hetzner.de:443/1MB.bin';
const TEST_ROUNDS = Number(process.env.TEST_ROUNDS || 3);
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS || 45000);
const TEST_BINARY_URL = process.env.TEST_BINARY_URL || DEFAULT_BINARY_URL;

function redactProxy(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(invalid proxy url)';
  }
}

function pickTmproxyKey() {
  const keys = (process.env.TMPROXY_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (keys.length > 0) return keys[0];
  if ((process.env.TMPROXY_API_KEY || '').trim()) return process.env.TMPROXY_API_KEY.trim();
  return null;
}

function pickStaticProxy() {
  const list = (process.env.PROXY_LIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list[0] || null;
}

async function getTmproxyCurrent(apiKey) {
  const res = await axios.post(
    'https://tmproxy.com/api/proxy/get-current-proxy',
    { api_key: apiKey },
    {
      timeout: 12000,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
    }
  );
  return res.data;
}

async function getTmproxyNew(apiKey) {
  const res = await axios.post(
    'https://tmproxy.com/api/proxy/get-new-proxy',
    { api_key: apiKey, id_location: 0, id_isp: 0 },
    {
      timeout: 15000,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
    }
  );
  return res.data;
}

function buildProxyFromTmproxy(data) {
  const httpsHost = data?.https;
  const socks5Host = data?.socks5;
  const username = data?.username;
  const password = data?.password;

  if (!httpsHost || !username || !password) {
    throw new Error('TMProxy response missing https/username/password');
  }

  return {
    httpProxyUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${httpsHost}`,
    socks5ProxyUrl: socks5Host
      ? `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${socks5Host}`
      : null,
    publicIp: data?.public_ip || null,
    expiresAt: data?.expired_at || null,
  };
}

async function testGdtCaptcha(label, agent) {
  const client = axios.create({
    baseURL: GDT_BASE_HTTP,
    timeout: TEST_TIMEOUT_MS,
    httpAgent: agent,
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'proxy-check/1.0',
      origin: 'https://hoadondientu.gdt.gov.vn',
      referer: 'https://hoadondientu.gdt.gov.vn/',
    },
  });

  const t0 = Date.now();
  const res = await client.get('/captcha');
  const ms = Date.now() - t0;
  const ok = !!(res.data && res.data.key && res.data.content);
  return { ok, ms, status: res.status };
}

async function testBinaryStream(label, agent, rounds) {
  const client = axios.create({
    timeout: TEST_TIMEOUT_MS,
    httpAgent: agent,
    headers: {
      accept: '*/*',
      'user-agent': 'proxy-check/1.0',
    },
  });

  const stats = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = Date.now();
    try {
      const res = await client.get(TEST_BINARY_URL, {
        responseType: 'stream',
      });

      let bytes = 0;
      await new Promise((resolve, reject) => {
        res.data.on('data', (chunk) => {
          bytes += chunk.length;
        });
        res.data.on('end', resolve);
        res.data.on('error', reject);
      });

      stats.push({ ok: true, ms: Date.now() - t0, bytes, status: res.status });
    } catch (err) {
      stats.push({
        ok: false,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const success = stats.filter((s) => s.ok).length;
  return { success, total: rounds, stats };
}

async function main() {
  console.log('=== Proxy Diagnostics (VPS) ===');
  console.log(`Node: ${process.version}`);
  console.log(`Rounds: ${TEST_ROUNDS}, Timeout: ${TEST_TIMEOUT_MS}ms`);
  console.log(`Binary URL: ${TEST_BINARY_URL}`);

  const tmproxyKey = pickTmproxyKey();
  const staticProxy = pickStaticProxy();

  let httpProxyUrl = null;
  let socks5ProxyUrl = null;

  if (tmproxyKey) {
    console.log('\n[1] TMProxy mode detected');
    let tm = await getTmproxyCurrent(tmproxyKey);
    console.log(`TMProxy get-current-proxy code=${tm.code}, message=${tm.message}`);

    if (tm.code === 27) {
      console.log('TMProxy chưa có session active, đang gọi get-new-proxy...');
      tm = await getTmproxyNew(tmproxyKey);
      console.log(`TMProxy get-new-proxy code=${tm.code}, message=${tm.message}`);
    }

    if (tm.code !== 0) {
      throw new Error(`TMProxy failed: code=${tm.code} message=${tm.message}`);
    }

    const built = buildProxyFromTmproxy(tm.data);
    httpProxyUrl = built.httpProxyUrl;
    socks5ProxyUrl = built.socks5ProxyUrl;

    console.log(`publicIp=${built.publicIp || 'n/a'}, expiredAt=${built.expiresAt || 'n/a'}`);
    console.log(`httpProxy=${redactProxy(httpProxyUrl)}`);
    console.log(`socks5Proxy=${socks5ProxyUrl ? redactProxy(socks5ProxyUrl) : '(none)'}`);
  } else if (staticProxy) {
    console.log('\n[1] Static proxy mode detected (PROXY_LIST)');
    httpProxyUrl = staticProxy;
    console.log(`httpProxy=${redactProxy(httpProxyUrl)}`);
    console.log('socks5Proxy=(none from PROXY_LIST)');
  } else {
    throw new Error('No proxy configured: TMPROXY_API_KEY(S) and PROXY_LIST are both empty');
  }

  console.log('\n[2] Testing HTTP CONNECT tunnel -> GDT /captcha');
  const httpAgent = createTunnelAgent({ proxyUrl: httpProxyUrl });
  try {
    const r = await testGdtCaptcha('http-connect', httpAgent);
    console.log(`PASS HTTP CONNECT captcha: status=${r.status}, latency=${r.ms}ms`);
  } catch (err) {
    console.log(`FAIL HTTP CONNECT captcha: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (socks5ProxyUrl) {
    console.log('\n[3] Testing SOCKS5 tunnel -> GDT /captcha');
    const socksAgent = createSocks5TunnelAgent({ proxyUrl: socks5ProxyUrl });
    try {
      const r = await testGdtCaptcha('socks5', socksAgent);
      console.log(`PASS SOCKS5 captcha: status=${r.status}, latency=${r.ms}ms`);
    } catch (err) {
      console.log(`FAIL SOCKS5 captcha: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log('\n[4] Testing SOCKS5 binary stream stability');
    const socksBin = await testBinaryStream('socks5-binary', socksAgent, TEST_ROUNDS);
    console.log(`SOCKS5 binary success: ${socksBin.success}/${socksBin.total}`);
    socksBin.stats.forEach((s, i) => {
      if (s.ok) {
        console.log(`  round ${i + 1}: PASS status=${s.status} bytes=${s.bytes} time=${s.ms}ms`);
      } else {
        console.log(`  round ${i + 1}: FAIL time=${s.ms}ms err=${s.error}`);
      }
    });
  } else {
    console.log('\n[3] SOCKS5 test skipped (no socks5 URL)');
  }

  console.log('\n[5] Testing HTTP CONNECT binary stream stability');
  const httpBin = await testBinaryStream('http-binary', httpAgent, TEST_ROUNDS);
  console.log(`HTTP CONNECT binary success: ${httpBin.success}/${httpBin.total}`);
  httpBin.stats.forEach((s, i) => {
    if (s.ok) {
      console.log(`  round ${i + 1}: PASS status=${s.status} bytes=${s.bytes} time=${s.ms}ms`);
    } else {
      console.log(`  round ${i + 1}: FAIL time=${s.ms}ms err=${s.error}`);
    }
  });

  console.log('\n=== Summary ===');
  console.log('- Nếu captcha pass nhưng binary fail nhiều: proxy stream không ổn cho tải file XML');
  console.log('- Nếu cả SOCKS5 và HTTP đều fail: kiểm tra firewall/VPS egress hoặc TMProxy session');
  console.log('- Nếu SOCKS5 fail nhưng HTTP pass: tạm thời disable SOCKS5 path cho binary trên VPS');
}

main().catch((err) => {
  console.error('\n[ERROR]', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
