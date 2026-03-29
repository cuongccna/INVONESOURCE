/**
 * Test 2captcha proxy for:
 * 1.  Basic HTTP GET (ip-api.com)  — standard JSON
 * 2.  HTTPS CONNECT tunnel        — test encrypted traffic
 * 3.  GDT portal login page       — check if site is accessible
 * 4.  Binary download (ZIP)       — httpbin.org/zip to confirm binary works
 * 5.  Raw axios.proxy option      — alternative approach without CONNECT tunnel
 *
 * Usage:
 *   node test-2captcha-proxy.js
 */
const axios  = require('axios');
const http   = require('http');
const https  = require('https');
const net    = require('net');
const tls    = require('tls');

const PROXY_USER = 'ufdcfb7f4587705e6-zone-custom-region-vn-session-wvJ7RysIQ-sessTime-1';
const PROXY_PASS = 'ufdcfb7f4587705e6';
const PROXY_HOST = 'ap.proxy.2captcha.com';
const PROXY_PORT = 2334;
const PROXY_URL  = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;

// Color output
const OK   = (s) => `\x1b[32m✔ ${s}\x1b[0m`;
const FAIL = (s) => `\x1b[31m✗ ${s}\x1b[0m`;
const INFO = (s) => `\x1b[36m→ ${s}\x1b[0m`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Test 1: Basic HTTP via axios proxy option ─────────────────────────────────
async function test1_basicHttp() {
  console.log('\n' + INFO('Test 1: Basic HTTP (ip-api.com) via axios proxy option'));
  try {
    const res = await axios.get('http://ip-api.com/json', {
      proxy: { protocol: 'http', host: PROXY_HOST, port: PROXY_PORT, auth: { username: PROXY_USER, password: PROXY_PASS } },
      timeout: 15000,
    });
    console.log(OK(`IP visible to target: ${res.data.query} (${res.data.country}, ${res.data.city})`));
    return true;
  } catch (e) {
    console.log(FAIL(`HTTP proxy failed: ${e.message}`));
    return false;
  }
}

// ── Test 2: Binary download via axios proxy option (httpbin.org returns a zip) ─
async function test2_binaryViaAxiosProxy() {
  console.log('\n' + INFO('Test 2: Binary download via axios proxy option (google favicon.ico)'));
  try {
    const res = await axios.get('https://www.google.com/favicon.ico', {
      proxy:        { protocol: 'http', host: PROXY_HOST, port: PROXY_PORT, auth: { username: PROXY_USER, password: PROXY_PASS } },
      responseType: 'arraybuffer',
      timeout:      20000,
    });
    const buf = Buffer.from(res.data);
    console.log(OK(`Binary received via proxy: ${buf.length} bytes, type: ${res.headers['content-type']}`));
    return buf.length > 0;
  } catch (e) {
    console.log(FAIL(`Binary download failed: ${e.message}`));
    return false;
  }
}

// ── Test 3: HTTPS CONNECT tunnel (our custom proxy-tunnel.ts approach) ─────────
function buildCustomTunnelAgent() {
  const proxyAuth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');

  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = (opts, callback) => {
    const targetHost = opts.hostname || opts.host || 'localhost';
    const targetPort = opts.port ?? 443;

    const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
      const connectReq = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
        `Proxy-Authorization: Basic ${proxyAuth}`,
        '',
        '',
      ].join('\r\n');
      sock.write(connectReq);

      let response = '';
      sock.once('data', (chunk) => {
        response += chunk.toString();
        if (!response.includes('\r\n\r\n')) return;
        const statusLine = response.split('\r\n')[0];
        const status = parseInt((statusLine || '').split(' ')[1] ?? '0', 10);
        if (status !== 200) {
          callback(new Error(`CONNECT failed: ${statusLine}`), null);
          return;
        }
        // TLS handshake over the socket
        const tlsSock = tls.connect({
          socket: sock,
          servername: targetHost,
          rejectUnauthorized: false,
        }, () => callback(null, tlsSock));
        tlsSock.on('error', (err) => callback(err, null));
      });
      sock.on('error', (err) => callback(err, null));
    });
    sock.on('error', (err) => callback(err, null));
  };
  return agent;
}

// Raw CONNECT test — show exactly what proxy responds
async function test3_connectRaw() {
  console.log('\n' + INFO('Test 3a: Raw CONNECT handshake — show proxy response'));
  return new Promise((resolve) => {
    const proxyAuth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
      const req = [
        'CONNECT httpbin.org:443 HTTP/1.1',
        'Host: httpbin.org:443',
        `Proxy-Authorization: Basic ${proxyAuth}`,
        '',
        '',
      ].join('\r\n');
      sock.write(req);

      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const text = buf.toString('utf-8', 0, Math.min(buf.length, 512));
        if (text.includes('\r\n\r\n') || buf.length > 200) {
          const statusLine = text.split('\r\n')[0];
          console.log(`  Raw response (first 300 chars): ${text.slice(0, 300).replace(/\r\n/g,' | ')}`);
          const status = parseInt((statusLine || '').split(' ')[1] ?? '0', 10);
          if (status === 200) {
            console.log(OK('CONNECT 200 — proxy supports CONNECT tunneling'));
            resolve(true);
          } else {
            console.log(FAIL(`CONNECT refused: ${statusLine}`));
            resolve(false);
          }
          sock.destroy();
        }
      });
      sock.on('error', (e) => {
        console.log(FAIL(`TCP error: ${e.message}`));
        resolve(false);
      });
      setTimeout(() => { sock.destroy(); resolve(false); }, 10000);
    });
    sock.on('error', (e) => { console.log(FAIL(`Connect failed: ${e.message}`)); resolve(false); });
  });
}

// After CONNECT 200, dump raw bytes BEFORE starting TLS — reveals if proxy injects data
async function test3_postConnectRawBytes() {
  console.log('\n' + INFO('Test 3b: Post-CONNECT raw bytes — is the tunnel clean?'));
  return new Promise((resolve) => {
    const proxyAuth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
      // CONNECT to google.com:443 (valid HTTPS port)
      const req = [
        'CONNECT www.google.com:443 HTTP/1.1',
        'Host: www.google.com:443',
        `Proxy-Authorization: Basic ${proxyAuth}`,
        '',
        '',
      ].join('\r\n');
      sock.write(req);

      let buf = Buffer.alloc(0);
      let phase = 'connect';

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (phase === 'connect') {
          const text = buf.toString('ascii');
          if (!text.includes('\r\n\r\n')) return;
          const statusLine = text.split('\r\n')[0];
          const status = parseInt((statusLine || '').split(' ')[1] ?? '0', 10);
          if (status !== 200) {
            console.log(FAIL(`CONNECT refused: ${statusLine}`));
            sock.destroy(); resolve(false); return;
          }
          // Find end of headers
          const headerEnd = buf.indexOf('\r\n\r\n');
          const leftover  = buf.slice(headerEnd + 4);
          console.log(`  CONNECT response: ${statusLine}`);
          if (leftover.length > 0) {
            console.log(`  ⚠ Proxy injected ${leftover.length} extra bytes AFTER 200: ${leftover.slice(0,80).toString('hex')}`);
          } else {
            console.log(`  No extra bytes after 200 ✓ — tunnel stream is clean`);
          }
          phase = 'tunnel';
          buf   = leftover;
          // Wait 500ms for any delayed injection
          setTimeout(() => {
            if (buf.length > 0) {
              console.log(FAIL(`  Proxy sent ${buf.length} unsolicited bytes in tunnel: ${buf.slice(0,80).toString('hex')}`));
              sock.destroy(); resolve(false);
            } else {
              console.log(OK('Post-CONNECT tunnel is clean — proxy properly waits for client data'));
              sock.destroy(); resolve(true);
            }
          }, 500);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
      };

      sock.on('data', onData);
      sock.on('error', (e) => { console.log(FAIL(`Error: ${e.message}`)); resolve(false); });
      setTimeout(() => { sock.destroy(); console.log(FAIL('Timeout')); resolve(false); }, 12000);
    });
    sock.on('error', (e) => { console.log(FAIL(`Connect failed: ${e.message}`)); resolve(false); });
  });
}

async function test3_httpsBinaryTunnel() {
  console.log('\n' + INFO('Test 3c: HTTPS binary via CONNECT tunnel — google.com:443 favicon'));
  const agent = buildCustomTunnelAgent();
  try {
    // IMPORTANT: Must use port 443 explicitly so CONNECT tunnels to TLS port
    const res = await axios.get('http://www.google.com:443/favicon.ico', {
      httpAgent:    agent,
      responseType: 'arraybuffer',
      timeout:      25000,
    });
    const buf = Buffer.from(res.data);
    console.log(OK(`Binary received via CONNECT: ${buf.length} bytes, content-type: ${res.headers['content-type']}`));
    return true;
  } catch (e) {
    console.log(FAIL(`CONNECT tunnel binary failed: ${e.message}`));
    return false;
  }
}

// ── Test 4: GDT portal reachable? ─────────────────────────────────────────────
// First: raw byte inspection for GDT port 30000 via CONNECT
async function test4_gdtConnectRaw() {
  console.log('\n' + INFO('Test 4a: Raw CONNECT+bytes for GDT port 30000 — what does proxy send?'));
  return new Promise((resolve) => {
    const proxyAuth = Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
    const sock = net.connect(PROXY_PORT, PROXY_HOST, () => {
      const req = [
        'CONNECT hoadondientu.gdt.gov.vn:30000 HTTP/1.1',
        'Host: hoadondientu.gdt.gov.vn:30000',
        `Proxy-Authorization: Basic ${proxyAuth}`,
        '',
        '',
      ].join('\r\n');
      sock.write(req);

      let buf = Buffer.alloc(0);
      let phase = 'connect';

      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (phase === 'connect') {
          const text = buf.toString('ascii');
          if (!text.includes('\r\n\r\n')) return;
          const statusLine = text.split('\r\n')[0];
          const status = parseInt((statusLine || '').split(' ')[1] ?? '0', 10);
          console.log(`  CONNECT response: ${statusLine}`);
          if (status !== 200) {
            console.log(FAIL(`Proxy blocked CONNECT to port 30000: ${statusLine}`));
            sock.destroy(); resolve(false); return;
          }
          const headerEnd = buf.indexOf('\r\n\r\n');
          const leftover = buf.slice(headerEnd + 4);
          if (leftover.length > 0) {
            console.log(`  ⚠ Proxy injected ${leftover.length} bytes after 200: ${leftover.slice(0,120).toString('hex')}`);
            console.log(`  As ASCII: ${leftover.slice(0,120).toString('ascii').replace(/\r\n/g,' | ')}`);
            sock.destroy(); resolve(false); return;
          }
          phase = 'tunnel';
          buf = Buffer.alloc(0);
          console.log('  Waiting 800ms for any tunnel data...');
          setTimeout(() => {
            if (buf.length > 0) {
              console.log(`  Proxy sent ${buf.length} unsolicited bytes:\n  HEX: ${buf.slice(0,120).toString('hex')}\n  ASCII: ${buf.slice(0,120).toString('ascii').replace(/\r\n/g,' | ')}`);
              sock.destroy(); resolve(false);
            } else {
              console.log(OK('Post-CONNECT port 30000 tunnel is clean'));
              sock.destroy(); resolve(true);
            }
          }, 800);
          return;
        }
        buf = Buffer.concat([buf]);
      };

      sock.on('data', onData);
      sock.on('error', (e) => { console.log(FAIL(`Error: ${e.message}`)); resolve(false); });
      setTimeout(() => { sock.destroy(); console.log(FAIL('Timeout waiting for CONNECT response')); resolve(false); }, 15000);
    });
    sock.on('error', (e) => { console.log(FAIL(`TCP failed: ${e.message}`)); resolve(false); });
  });
}

async function test4_gdtReachable() {
  console.log('\n' + INFO('Test 4: GDT portal reachable (hoadondientu.gdt.gov.vn:30000/captcha)'));
  const agent = buildCustomTunnelAgent();
  try {
    const res = await axios.get('http://hoadondientu.gdt.gov.vn:30000/captcha', {
      httpAgent: agent,
      timeout:   20000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      },
    });
    console.log(OK(`GDT captcha endpoint accessible, status ${res.status}, key field: ${JSON.stringify(res.data?.key ?? '?')}`));
    return true;
  } catch (e) {
    const status = e?.response?.status;
    if (status) {
      console.log(OK(`GDT reachable (HTTP ${status}) — proxy tunnel works`));
      return true;
    }
    console.log(FAIL(`GDT unreachable: ${e.message}`));
    return false;
  }
}

// ── Test 5: Direct connection (no proxy) for comparison ────────────────────────
async function test5_directBinary() {
  console.log('\n' + INFO('Test 5: Binary direct (no proxy) — baseline check'));
  try {
    const res = await axios.get('https://www.google.com/favicon.ico', {
      responseType: 'arraybuffer',
      timeout:      10000,
    });
    const buf = Buffer.from(res.data);
    console.log(OK(`Direct binary: ${buf.length} bytes OK`));
    return buf.length > 0;
  } catch (e) {
    console.log(FAIL(`Direct binary failed: ${e.message}`));
    return false;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log(' 2captcha Proxy Capability Test');
  console.log(`  Proxy: ${PROXY_HOST}:${PROXY_PORT}`);
  console.log(`  User:  ${PROXY_USER}`);
  console.log('='.repeat(60));

  const results = {};

  results.t1 = await test1_basicHttp();
  await sleep(1000);

  results.t2 = await test2_binaryViaAxiosProxy();
  await sleep(1000);

  results.t3a = await test3_connectRaw();
  await sleep(500);

  results.t3b = await test3_postConnectRawBytes();
  await sleep(500);

  results.t3c = await test3_httpsBinaryTunnel();
  await sleep(1000);

  results.t4raw = await test4_gdtConnectRaw();
  await sleep(500);

  results.t4 = await test4_gdtReachable();
  await sleep(1000);

  results.t5 = await test5_directBinary();

  console.log('\n' + '='.repeat(60));
  console.log(' SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Basic HTTP (axios proxy):       ${results.t1    ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  Binary (axios proxy HTTPS):     ${results.t2    ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  CONNECT handshake (200):        ${results.t3a   ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  Post-CONNECT clean tunnel:      ${results.t3b   ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  HTTPS binary port 443 tunnel:   ${results.t3c   ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  GDT CONNECT port 30000 clean:   ${results.t4raw ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  GDT portal TLS request:         ${results.t4    ? OK('PASS') : FAIL('FAIL')}`);
  console.log(`  Binary direct (baseline):       ${results.t5    ? OK('PASS') : FAIL('FAIL')}`);

  const proxyOk = results.t3b && results.t3c && results.t4raw && results.t4;
  console.log('\n' + (proxyOk
    ? OK('✅ 2captcha proxy SUPPORTS binary — recommend switching bot to use this proxy')
    : FAIL('❌ 2captcha proxy DOES NOT fully support binary downloads or GDT access')));

  if (!proxyOk) {
    console.log('\n\x1b[33mRecommended alternatives:\x1b[0m');
    console.log('  1. BrightData (luminati.io) — supports CONNECT tunnel + binary, Vietnamese IPs');
    console.log('  2. Oxylabs    — residential proxies, supports all binary + HTTPS');
    console.log('  3. IPRoyal    — cheaper, residential, SOCKS5+HTTP CONNECT');
    console.log('  4. SmartProxy — supports sticky sessions + HTTPS CONNECT + binary');
    console.log('  5. ProxyEmpire — Vietnam-specific IPs, HTTPS CONNECT, binary allowed');
  }
}

main().catch(console.error);
