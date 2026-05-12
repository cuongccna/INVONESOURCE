/**
 * test-muaproxy.ts — Kiểm tra proxy (HTTP CONNECT hoặc SOCKS5) với GDT portal
 *
 * Kiểm tra các bước:
 *   1. TCP connectivity tới proxy server
 *   2. Public IP nhìn thấy từ GDT (qua proxy)
 *   2b. Raw CONNECT test tới GDT:443 (HTTP CONNECT only)
 *   2c. TLS handshake sau CONNECT (HTTP CONNECT only)
 *   3. Lấy captcha từ GDT (http://hoadondientu.gdt.gov.vn:443/api/captcha)
 *   4. Giải captcha bằng 2Captcha (nếu có TWO_CAPTCHA_API_KEY)
 *
 * Chạy:
 *   cd bot
 *   npx ts-node -r dotenv/config src/test-muaproxy.ts
 */

import 'dotenv/config';
import * as net  from 'net';
import * as fs   from 'fs';
import * as path from 'path';
import axios      from 'axios';
import { createTunnelAgent, createSocks5TunnelAgent } from './proxy-tunnel';
import { CaptchaService }   from './captcha.service';

// ── Catch any uncaught errors so we always see what crashed ──────────────────
process.on('uncaughtException',  (e) => { fs.appendFileSync(LOG, `[uncaughtException] ${e.stack ?? e.message}\n`); console.error('[uncaughtException]', e.message); process.exit(1); });
process.on('unhandledRejection', (r) => { fs.appendFileSync(LOG, `[unhandledRejection] ${String(r)}\n`);           console.error('[unhandledRejection]', r);              process.exit(1); });

const LOG = path.resolve(__dirname, '..', 'tmp', 'test-muaproxy.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, `=== test-muaproxy run ${new Date().toISOString()} ===\n`);

// ─── Proxy cần test ────────────────────────────────────────────────────────────
// HTTP CONNECT: format host:port:user:pass (type = 'http')
// SOCKS5:       format host:port:user:pass (type = 'socks5')
const PROXY_TYPE: 'http' | 'socks5' = 'socks5';
const PROXY_RAW = '113.173.113.214:39057:tmproxyVyo4E:wXyYiJRTwf';

// ─── GDT endpoint (HTTP CONNECT → port 443 / standard HTTPS) ────────────────
const GDT_HTTP_BASE = 'http://hoadondientu.gdt.gov.vn:443/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OK   = (s: string) => `\x1b[32m✔ ${s}\x1b[0m`;
const FAIL = (s: string) => `\x1b[31m✗ ${s}\x1b[0m`;
const INFO = (s: string) => `\x1b[36m→ ${s}\x1b[0m`;
const WARN = (s: string) => `\x1b[33m⚠ ${s}\x1b[0m`;

function parseProxy(raw: string): { host: string; port: number; user: string; pass: string; url: string; socks5Url: string } {
  const parts = raw.split(':');
  if (parts.length < 4) throw new Error(`Invalid proxy format. Expected host:port:user:pass, got: ${raw}`);
  const [host, portStr, user, ...passParts] = parts;
  const pass = passParts.join(':');
  const port = Number(portStr);
  if (!host || isNaN(port) || !user || !pass) throw new Error(`Invalid proxy parts: ${raw}`);
  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(pass);
  return {
    host, port, user, pass,
    url:       `http://${encodedUser}:${encodedPass}@${host}:${port}`,
    socks5Url: `socks5://${encodedUser}:${encodedPass}@${host}:${port}`,
  };
}

function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}

// ─── Bước 1: TCP probe ────────────────────────────────────────────────────────
async function step1_tcpProbe(proxy: ReturnType<typeof parseProxy>): Promise<boolean> {
  console.log(`\n${INFO(`Step 1: TCP probe → ${proxy.host}:${proxy.port}`)}`);
  const ok = await tcpProbe(proxy.host, proxy.port, 8_000);
  if (ok) {
    console.log(OK(`TCP connected to ${proxy.host}:${proxy.port}`));
  } else {
    console.log(FAIL(`TCP probe failed — proxy unreachable: ${proxy.host}:${proxy.port}`));
  }
  return ok;
}

// ─── Bước 2: Public IP qua proxy ─────────────────────────────────────────────
async function step2_publicIp(proxyUrl: string, proxyType: 'http' | 'socks5'): Promise<string | null> {
  console.log(`\n${INFO(`Step 2: Public IP via ${proxyType.toUpperCase()} proxy (api.ipify.org)`)}`);
  try {
    const agent = proxyType === 'socks5'
      ? createSocks5TunnelAgent({ proxyUrl })
      : createTunnelAgent({ proxyUrl });
    const client = axios.create({
      baseURL:   'http://api.ipify.org:443',
      httpAgent: agent,
      timeout:   15_000,
    });
    const res = await client.get<{ ip: string }>('/?format=json');
    const ip  = res.data.ip;
    console.log(OK(`Public IP seen by target: ${ip}`));
    return ip;
  } catch (e) {
    const err = e as Error;
    console.log(FAIL(`Public IP check failed: ${err.message}`));
    return null;
  }
}

// ─── Bước 2b: Raw CONNECT test tới GDT port 443 ────────────────────────────────────
function rawConnectTest(
  proxyHost: string, proxyPort: number, proxyAuth: string | null,
  targetHost: string, targetPort: number, timeoutMs = 10_000,
): Promise<{ status: number; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('CONNECT timeout')); }, timeoutMs);

    sock.once('connect', () => {
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader + `\r\n`,
      );
    });

    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (!buf.includes('\r\n\r\n') && !buf.includes('\r\n') ) return;
      clearTimeout(timer);
      sock.destroy();
      const firstLine = buf.split('\r\n')[0] ?? '';
      const code = parseInt((firstLine.split(' ')[1] ?? '0'), 10);
      resolve({ status: code, statusLine: firstLine });
    });
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function step2b_connectTest(proxy: { host: string; port: number; user: string; pass: string }): Promise<boolean> {
  console.log(`\n${INFO('Step 2b: Raw CONNECT test → hoadondientu.gdt.gov.vn:443')}`);
  try {
    const auth = `${proxy.user}:${proxy.pass}`;
    const result = await rawConnectTest(proxy.host, proxy.port, auth, 'hoadondientu.gdt.gov.vn', 443);
    if (result.status === 200) {
      console.log(OK(`CONNECT accepted: ${result.statusLine}`));
      return true;
    } else {
      console.log(FAIL(`CONNECT rejected: ${result.statusLine}`));
      console.log(WARN('Proxy này KHÔNG hỗ trợ CONNECT tới port 443.'));
      return false;
    }
  } catch (e) {
    console.log(FAIL(`CONNECT test error: ${(e as Error).message}`));
    return false;
  }
}

// ─── Bước 2c: TLS handshake sau CONNECT ──────────────────────────────────────
// Sau khi CONNECT 200, thử TLS handshake thủ công để xem proxy có thực sự forward hay không
function tlsAfterConnectTest(
  proxyHost: string, proxyPort: number, proxyAuth: string | null,
  targetHost: string, targetPort: number, timeoutMs = 15_000,
): Promise<{ success: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ success: false, detail: 'timeout waiting for TLS' });
    }, timeoutMs);

    sock.once('error', (e) => { clearTimeout(timer); resolve({ success: false, detail: `TCP error: ${e.message}` }); });
    sock.once('connect', () => {
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader + `\r\n`,
      );

      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('ascii');
        if (!buf.includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);

        const statusLine = buf.split('\r\n')[0] ?? '';
        const code = parseInt((statusLine.split(' ')[1] ?? '0'), 10);
        if (code !== 200) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ success: false, detail: `CONNECT rejected: ${statusLine}` });
          return;
        }

        // CONNECT OK — thử TLS handshake
        import('tls').then(tls => {
          const tlsSock = tls.connect({
            socket: sock,
            servername: targetHost,
            rejectUnauthorized: false,
          });
          const tlsTimer = setTimeout(() => {
            tlsSock.destroy();
            clearTimeout(timer);
            resolve({ success: false, detail: 'TLS handshake timeout (proxy possibly blocking port 443)' });
          }, 10_000);

          tlsSock.once('secureConnect', () => {
            clearTimeout(tlsTimer);
            clearTimeout(timer);
            const cert = tlsSock.getPeerCertificate();
            tlsSock.destroy();
            resolve({ success: true, detail: `TLS OK — cert subject: ${cert?.subject?.CN ?? 'unknown'}` });
          });
          tlsSock.once('error', (tlsErr) => {
            clearTimeout(tlsTimer);
            clearTimeout(timer);
            resolve({ success: false, detail: `TLS error: ${tlsErr.message}` });
          });
        }).catch(e => {
          clearTimeout(timer);
          resolve({ success: false, detail: `TLS import error: ${(e as Error).message}` });
        });
      };
      sock.on('data', onData);
    });
  });
}

async function step2c_tlsTest(proxy: { host: string; port: number; user: string; pass: string }): Promise<boolean> {
  console.log(`\n${INFO('Step 2c: TLS handshake test sau CONNECT → hoadondientu.gdt.gov.vn:443')}`);
  const auth = `${proxy.user}:${proxy.pass}`;
  const result = await tlsAfterConnectTest(proxy.host, proxy.port, auth, 'hoadondientu.gdt.gov.vn', 443);
  if (result.success) {
    console.log(OK(`TLS handshake thành công: ${result.detail}`));
    return true;
  } else {
    console.log(FAIL(`TLS handshake thất bại: ${result.detail}`));
    if (result.detail.includes('timeout') || result.detail.includes('blocking')) {
      console.log(WARN('Proxy có thể chặn traffic tới port 443 (chỉ accept CONNECT nhưng không forward).'));
    }

    // Cross-check với google.com:443 — nếu TLS qua proxy 443 OK thì lỗi do GDT block IP
    console.log(`   ${INFO('Cross-check: TLS qua proxy → www.google.com:443')}`);
    const googleResult = await tlsAfterConnectTest(proxy.host, proxy.port, auth, 'www.google.com', 443);
    if (googleResult.success) {
      console.log(`   ${OK(`Google TLS OK: ${googleResult.detail}`)}`);
      console.log(WARN('→ Proxy forward TLS OK nhưng GDT:443 thất bại — GDT có thể block IP exit của proxy.'));
    } else {
      console.log(`   ${FAIL(`Google TLS cũng thất bại: ${googleResult.detail}`)}`);
      console.log(WARN('→ Proxy không hỗ trợ TLS forwarding (fake CONNECT 200).'));
    }
    return false;
  }
}

// ─── Bước 3: Lấy GDT captcha qua proxy ───────────────────────────────────────
async function step3_gdtCaptcha(proxyUrl: string, proxyType: 'http' | 'socks5'): Promise<{ key: string; content: string } | null> {
  console.log(`\n${INFO(`Step 3: GDT captcha via ${proxyType.toUpperCase()} proxy (${GDT_HTTP_BASE}/captcha)`)}`);
  fs.appendFileSync(LOG, `[step3] starting captcha request via ${proxyType}, proxyUrl=${proxyUrl.slice(0, 40)}\n`);
  try {
    const agent = proxyType === 'socks5'
      ? createSocks5TunnelAgent({ proxyUrl })
      : createTunnelAgent({ proxyUrl });
    fs.appendFileSync(LOG, `[step3] agent created\n`);
    const client = axios.create({
      baseURL:   GDT_HTTP_BASE,
      httpAgent: agent,
      timeout:   25_000,
      headers: {
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    fs.appendFileSync(LOG, `[step3] axios client created, sending GET /captcha...\n`);
    const res = await client.get<{ key: string; content: string }>('/captcha');
    fs.appendFileSync(LOG, `[step3] response status=${res.status}, key=${res.data?.key}\n`);
    const { key, content } = res.data;
    console.log(OK(`GDT responded — HTTP ${res.status}`));
    console.log(`   Captcha key    : ${key}`);
    console.log(`   SVG/content len: ${content?.length ?? 0} chars`);

    // Lưu captcha SVG để xem thủ công
    if (content) {
      const outPath = path.resolve(__dirname, '..', 'tmp', 'captcha-muaproxy.svg');
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const svgData = content.startsWith('data:') ? Buffer.from(content.split(',')[1] ?? '', 'base64').toString() : content;
      fs.writeFileSync(outPath, svgData.includes('<svg') ? svgData : content, 'utf8');
      console.log(`   Captcha saved  : ${outPath}`);
    }
    return { key, content };
  } catch (e) {
    const err = e as Error & { response?: { status: number; data: unknown } };
    fs.appendFileSync(LOG, `[step3] ERROR: ${err.message}\n${err.stack ?? ''}\n`);
    if (err.response) {
      console.log(FAIL(`GDT captcha HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`));
    } else {
      console.log(FAIL(`GDT captcha failed: ${err.message}`));
    }
    return null;
  }
}

// ─── Bước 4: Giải captcha bằng 2Captcha ──────────────────────────────────────
async function step4_solveCaptcha(content: string): Promise<string | null> {
  const apiKey = process.env['TWO_CAPTCHA_API_KEY'];
  if (!apiKey) {
    console.log(`\n${WARN('Step 4: Bỏ qua — TWO_CAPTCHA_API_KEY không có trong .env')}`);
    return null;
  }
  console.log(`\n${INFO('Step 4: Giải captcha bằng 2Captcha...')}`);
  try {
    const svc = new CaptchaService(apiKey);

    // GDT trả về SVG hoặc base64 PNG — cần convert sang base64 trước khi gửi
    let base64: string;
    if (content.startsWith('data:image')) {
      // data:image/png;base64,XXXX
      base64 = content.split(',')[1] ?? '';
    } else if (content.includes('<svg') || content.includes('<?xml')) {
      // SVG text — 2Captcha không nhận SVG trực tiếp
      console.log(WARN('   GDT trả về SVG. 2Captcha chỉ nhận PNG/JPG — bỏ qua bước này.'));
      console.log(WARN('   Xem captcha-muaproxy.svg trong thư mục tmp/ để kiểm tra thủ công.'));
      return null;
    } else {
      // Assume raw base64
      base64 = content;
    }

    if (!base64) { console.log(WARN('   Không parse được base64 từ captcha content.')); return null; }

    const { text, captchaId } = await svc.solve(base64);
    console.log(OK(`Captcha solved: "${text}" (id=${captchaId})`));
    return text;
  } catch (e) {
    console.log(FAIL(`2Captcha failed: ${(e as Error).message}`));
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log('  Test Proxy → GDT Captcha: muaproxy.net static proxy  ');
  console.log('════════════════════════════════════════════════════════');
  console.log(`Type : ${PROXY_TYPE.toUpperCase()}`);
  console.log(`Proxy: ${PROXY_RAW.replace(/:([^:]+)$/, ':***')}`);

  let proxy: ReturnType<typeof parseProxy>;
  try {
    proxy = parseProxy(PROXY_RAW);
  } catch (e) {
    console.log(FAIL(`Parse proxy error: ${(e as Error).message}`));
    process.exit(1);
  }

  // Bước 1
  const tcpOk = await step1_tcpProbe(proxy);
  if (!tcpOk) {
    console.log('\n' + FAIL('DỪNG — proxy không kết nối được TCP. Kiểm tra lại host/port hoặc firewall.'));
    process.exit(1);
  }

  // Bước 2
  const activeUrl = PROXY_TYPE === 'socks5' ? proxy.socks5Url : proxy.url;
  const publicIp = await step2_publicIp(activeUrl, PROXY_TYPE);

  // Bước 2b & 2c: chỉ dành cho HTTP CONNECT proxy
  let connectOk = true;
  let tlsOk     = true;
  if (PROXY_TYPE === 'http') {
    connectOk = await step2b_connectTest(proxy);
    tlsOk     = await step2c_tlsTest(proxy);
  } else {
    console.log(`\n${INFO('Step 2b/2c: Bỏ qua (SOCKS5 proxy — không dùng HTTP CONNECT)')}`);
  }

  // Bước 3
  const captcha = await step3_gdtCaptcha(activeUrl, PROXY_TYPE);

  // Bước 4
  let captchaText: string | null = null;
  if (captcha?.content) {
    captchaText = await step4_solveCaptcha(captcha.content);
  }

  // ── Tổng kết ──────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════');
  console.log('  Kết quả:');
  console.log(`  Type          : ${PROXY_TYPE.toUpperCase()}`);
  console.log(`  TCP           : ${tcpOk     ? '✅ OK'            : '❌ FAIL'}`);
  console.log(`  Public IP     : ${publicIp  ? `✅ ${publicIp}`   : '❌ FAIL'}`);
  if (PROXY_TYPE === 'http') {
    console.log(`  CONNECT:443   : ${connectOk ? '✅ OK'          : '❌ BLOCKED'}`);
    console.log(`  TLS handshake : ${tlsOk     ? '✅ OK'          : '❌ FAIL (proxy chặn port 443)'}`);
  }
  console.log(`  GDT captcha   : ${captcha   ? `✅ key=${captcha.key}` : '❌ FAIL'}`);
  console.log(`  2Captcha      : ${captchaText ? `✅ "${captchaText}"` : captcha?.content ? '⚠ SVG (skip) hoặc FAIL' : '— (bỏ qua)'}`);
  console.log('════════════════════════════════════════════════════════');

  const allOk = tcpOk && !!publicIp && (PROXY_TYPE === 'http' ? connectOk && tlsOk : true) && !!captcha;
  if (allOk) {
    console.log(OK('Proxy hoạt động tốt với GDT!'));
    process.exit(0);
  } else {
    if (tcpOk && !!publicIp && connectOk && !tlsOk && PROXY_TYPE === 'http') {
      console.log(FAIL('CHẨN ĐOÁN: Proxy chặn TLS tới port 443.'));
      console.log(WARN('Proxy chấp nhận CONNECT nhưng không forward TLS — proxy không dùng được với GDT.'));
    } else {
      console.log(FAIL('Một hoặc nhiều bước thất bại. Kiểm tra log phía trên.'));
    }
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error('\n' + FAIL(`Unhandled error: ${(e as Error).message}`));
  process.exit(1);
});
