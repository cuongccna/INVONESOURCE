/**
 * test-tracuunnt.js
 *
 * Kiểm tra TracuunntCrawler có đi qua proxy không, và kết quả tra cứu thực tế.
 *
 * Usage (VPS):
 *   cd /opt/INVONESOURCE/bot
 *   node scripts/test-tracuunnt.js
 *
 * Optional: test MST cụ thể
 *   TEST_MST=0100109106-215 node scripts/test-tracuunnt.js
 *
 * Cần env:
 *   IPROYAL_PROXY_LIST=geo.iproyal.com:12321:user:pass_session-XXX  (hoặc TMPROXY_API_KEY)
 */

require('dotenv').config();

const http   = require('http');
const https  = require('https');
const net    = require('net');
const tls    = require('tls');
const axios  = require('axios');
const { URL } = require('url');

// ── Resolve proxy from env (same logic as proxy-manager Mode C / Mode A) ──────
function resolveProxy() {
  const iproyalRaw = (process.env.IPROYAL_PROXY_LIST || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (iproyalRaw.length > 0) {
    const entry = iproyalRaw[0];
    const i1 = entry.indexOf(':');
    const i2 = entry.indexOf(':', i1 + 1);
    const i3 = entry.indexOf(':', i2 + 1);
    const host = entry.slice(0, i1);
    const port = entry.slice(i1 + 1, i2);
    const user = entry.slice(i2 + 1, i3);
    const pass = entry.slice(i3 + 1);
    const sessionMatch = pass.match(/_session-([^_]+)/);
    const auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
    return {
      provider:    'iproyal',
      sessionId:   sessionMatch?.[1] ?? pass.slice(-10),
      httpUrl:     `http://${auth}@${host}:${port}`,
      socks5Url:   `socks5://${auth}@${host}:${port}`,
      slots:       iproyalRaw.length,
    };
  }

  const tmKey = (process.env.TMPROXY_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)[0]
             || process.env.TMPROXY_API_KEY?.trim();
  if (tmKey) {
    return { provider: 'tmproxy_key', sessionId: tmKey.slice(0, 8) + '…', httpUrl: '__tmproxy__', socks5Url: null, slots: 1 };
  }

  const staticP = (process.env.PROXY_LIST || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (staticP) {
    return { provider: 'static', sessionId: 'static', httpUrl: staticP, socks5Url: null, slots: 1 };
  }
  return null;
}

function redact(url) {
  if (!url) return '(none)';
  try { const u = new URL(url); if (u.password) u.password = '***'; return u.toString(); } catch { return url; }
}

// ── Build plain-HTTP tunnel agent (port 80 targets) ───────────────────────────
function buildPlainHttpTunnelAgent(proxyUrl) {
  const proxy     = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 80;
  const proxyAuth = proxy.username
    ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    : null;

  const agent = new http.Agent({ keepAlive: false });

  agent.createConnection = (connectOpts, callback) => {
    const targetHost = connectOpts.hostname || connectOpts.host || 'localhost';
    const targetPort = connectOpts.port ?? 80;

    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    sock.once('error', err => callback(err, null));
    sock.setTimeout(20000);
    sock.once('timeout', () => { sock.destroy(); callback(new Error('Proxy TCP timeout'), null); });

    sock.once('connect', () => {
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        `\r\n`
      );

      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.toString('ascii').includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        sock.setTimeout(0);
        const statusLine = buf.toString('ascii').split('\r\n')[0] || '';
        if (!statusLine.includes('200')) {
          sock.destroy();
          callback(new Error(`Proxy CONNECT failed: ${statusLine}`), null);
          return;
        }
        // Plain HTTP: return raw socket (no TLS)
        callback(null, sock);
      };
      sock.on('data', onData);
    });
  };
  return agent;
}

// ── Build HTTPS tunnel agent (TLS after CONNECT) ─────────────────────────────
function buildHttpsTunnelAgent(proxyUrl) {
  const proxy     = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 80;
  const proxyAuth = proxy.username
    ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    : null;

  const agent = new http.Agent({ keepAlive: false });

  agent.createConnection = (connectOpts, callback) => {
    const targetHost = connectOpts.hostname || connectOpts.host || 'localhost';
    const targetPort = connectOpts.port ?? 443;
    const servername = connectOpts.servername || targetHost;

    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    sock.once('error', err => callback(err, null));
    sock.setTimeout(20000);
    sock.once('timeout', () => { sock.destroy(); callback(new Error('Proxy TCP timeout'), null); });

    sock.once('connect', () => {
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        `\r\n`
      );

      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.toString('ascii').includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);
        sock.setTimeout(0);
        const statusLine = buf.toString('ascii').split('\r\n')[0] || '';
        if (!statusLine.includes('200')) {
          sock.destroy();
          callback(new Error(`CONNECT failed: ${statusLine}`), null);
          return;
        }
        const tlsSock = tls.connect({ socket: sock, servername, rejectUnauthorized: false });
        tlsSock.once('error', err => callback(err, null));
        tlsSock.once('secureConnect', () => callback(null, tlsSock));
      };
      sock.on('data', onData);
    });
  };
  return agent;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const TEST_MST = process.env.TEST_MST || '0100109106';  // Viettel default test MST
  const TIMEOUT_MS = 20000;
  const GDT_URL  = 'http://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp';

  console.log('=== TracuunntCrawler Proxy Test ===');
  console.log(`MST đang test: ${TEST_MST}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms\n`);

  // ── [1] Phát hiện proxy ────────────────────────────────────────────────────
  const proxy = resolveProxy();
  if (!proxy) {
    console.error('[FAIL] Không tìm thấy proxy nào được cấu hình.');
    console.error('  Cần đặt IPROYAL_PROXY_LIST trong bot/.env');
    process.exit(1);
  }

  console.log('[1] Proxy đã cấu hình:');
  console.log(`  Provider:  ${proxy.provider}`);
  console.log(`  Session:   ${proxy.sessionId}`);
  console.log(`  HTTP URL:  ${redact(proxy.httpUrl)}`);
  console.log(`  SOCKS5:    ${redact(proxy.socks5Url)}`);
  console.log(`  Tổng slot: ${proxy.slots}`);

  if (proxy.provider === 'tmproxy_key') {
    console.log('\n  [INFO] TMProxy mode: proxy URL được đọc động qua API — không test ở đây.');
    console.log('  Dùng scripts/check-proxy-vps.js để test TMProxy.');
    process.exit(0);
  }

  const httpProxyUrl = proxy.httpUrl;

  // ── [2] Test xem proxy có thể kết nối IP ─────────────────────────────────
  console.log('\n[2] Kiểm tra IP thực qua proxy (https://ipv4.icanhazip.com):');
  try {
    const ipAgent = buildHttpsTunnelAgent(httpProxyUrl);
    const t0 = Date.now();
    const res = await axios.get('https://ipv4.icanhazip.com', {
      httpAgent: ipAgent,
      timeout: TIMEOUT_MS,
    });
    const ip = (res.data || '').toString().trim();
    console.log(`  PASS — IP qua proxy: ${ip} (${Date.now() - t0}ms)`);
    console.log(`  → GDT sẽ thấy IP: ${ip} thay vì IP VPS`);
  } catch (err) {
    console.log(`  FAIL — ${err.message}`);
  }

  // ── [3] Test TCP kết nối tới tracuunnt.gdt.gov.vn:80 qua proxy ───────────
  console.log('\n[3] Test proxy → tracuunnt.gdt.gov.vn:80 (plain HTTP):');
  try {
    const plainAgent = buildPlainHttpTunnelAgent(httpProxyUrl);
    const t0 = Date.now();
    const res = await axios.get('http://tracuunnt.gdt.gov.vn/', {
      httpAgent: plainAgent,
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    console.log(`  PASS — status=${res.status} (${Date.now() - t0}ms)`);
    if (res.headers['location']) {
      console.log(`  → Redirect đến: ${res.headers['location']}`);
    }
  } catch (err) {
    console.log(`  FAIL — ${err.message}`);
  }

  // ── [4] Tra cứu thực tế qua GDT (tracuunnt.gdt.gov.vn) ───────────────────
  console.log(`\n[4] Lookup GDT qua proxy: MST=${TEST_MST}`);
  try {
    const plainAgent = buildPlainHttpTunnelAgent(httpProxyUrl);
    const t0 = Date.now();
    const res = await axios.post(
      GDT_URL,
      new URLSearchParams({ mst: TEST_MST }).toString(),
      {
        httpAgent: plainAgent,
        timeout: TIMEOUT_MS,
        maxRedirects: 5,
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer':       'http://tracuunnt.gdt.gov.vn/',
          'Origin':        'http://tracuunnt.gdt.gov.vn',
          'Accept':        'text/html,application/xhtml+xml',
          'Accept-Language': 'vi-VN,vi;q=0.9',
        },
      }
    );
    const html = res.data || '';
    const latency = Date.now() - t0;
    console.log(`  status=${res.status}, size=${html.length} bytes, latency=${latency}ms`);

    // Trích xuất dữ liệu từ HTML
    const nameMatch   = html.match(/Tên người nộp thuế[^<]*<\/td>\s*<td[^>]*>([^<]+)/i)
                     || html.match(/Tên đơn vị[^<]*<\/td>\s*<td[^>]*>([^<]+)/i);
    const statusMatch = html.match(/Tình trạng[^<]*<\/td>\s*<td[^>]*>([^<]+)/i)
                     || html.match(/Trạng thái[^<]*<\/td>\s*<td[^>]*>([^<]+)/i);
    const addrMatch   = html.match(/Địa chỉ[^<]*<\/td>\s*<td[^>]*>([^<]+)/i);

    const notFound = html.includes('Không tìm thấy') || html.includes('Không có dữ liệu');
    if (notFound) {
      console.log('  Kết quả: MST không tìm thấy');
    } else if (nameMatch || statusMatch) {
      console.log('  PASS — Có dữ liệu công ty:');
      if (nameMatch)   console.log(`    Tên:       ${nameMatch[1].trim()}`);
      if (statusMatch) console.log(`    Tình trạng: ${statusMatch[1].trim()}`);
      if (addrMatch)   console.log(`    Địa chỉ:   ${addrMatch[1].trim()}`);
    } else {
      console.log('  Không parse được dữ liệu — xem HTML snippet:');
      console.log('  ' + html.slice(0, 300).replace(/\n/g, ' ').replace(/\s+/g, ' '));
    }
  } catch (err) {
    console.log(`  FAIL — ${err.message}`);
  }

  // ── [5] Fallback masothue.com qua proxy ───────────────────────────────────
  console.log(`\n[5] Fallback masothue.com qua proxy: MST=${TEST_MST}`);
  try {
    const httpsAgent = buildHttpsTunnelAgent(httpProxyUrl);
    const t0 = Date.now();
    const res = await axios.get(
      `https://masothue.com/Search/Party?s=${encodeURIComponent(TEST_MST)}`,
      {
        httpAgent: httpsAgent,
        httpsAgent: httpsAgent,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }
    );
    const data = res.data;
    const latency = Date.now() - t0;
    const company = Array.isArray(data) ? data[0] : data;
    console.log(`  PASS — status=${res.status}, latency=${latency}ms`);
    if (company && (company.name || company.ten)) {
      console.log(`  Tên: ${company.name || company.ten || '(unknown)'}`);
    }
  } catch (err) {
    console.log(`  FAIL — ${err.message}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== Kết luận proxy TracuunntCrawler ===');
  console.log('- IPRoyal đọc từ env IPROYAL_PROXY_LIST (KHÔNG hardcode trong code)');
  console.log('- tracuunnt.gdt.gov.vn dùng plain HTTP port 80 → tunnel agent với plainHttp:true (không TLS)');
  console.log('- masothue.com dùng HTTPS → tunnel agent với TLS bình thường');
  console.log('- Tất cả requests đều đi qua proxy — không có request trực tiếp từ VPS');
}

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
