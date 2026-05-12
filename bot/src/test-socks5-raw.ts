/**
 * test-socks5-raw.ts — Kiểm tra thủ công từng bước SOCKS5 → GDT:443
 *
 * Không dùng axios/http.Agent. Thực hiện:
 *   1. TCP → SOCKS5 proxy
 *   2. Auth handshake
 *   3. CONNECT tới hoadondientu.gdt.gov.vn:443
 *   4. TLS handshake
 *   5. Gửi HTTP GET /api/captcha và đọc phản hồi
 *
 * Chạy: cd bot && npx ts-node -r dotenv/config src/test-socks5-raw.ts
 */

import 'dotenv/config';
import * as net from 'net';
import * as tls from 'tls';
import * as fs  from 'fs';
import * as path from 'path';

const PROXY_HOST = '113.173.113.214';
const PROXY_PORT = 39057;
const PROXY_USER = 'tmproxyVyo4E';
const PROXY_PASS = 'wXyYiJRTwf';

// Thay đổi TARGET để cross-check:
//   GDT:443     → hoadondientu.gdt.gov.vn:443   (mục tiêu chính — API mới)
//   Google:443  → www.google.com:443             (cross-check port thường)
const TARGET_HOST = process.env['TEST_TARGET_HOST'] ?? 'hoadondientu.gdt.gov.vn';
const TARGET_PORT = parseInt(process.env['TEST_TARGET_PORT'] ?? '443', 10);

const LOG = path.resolve(__dirname, '..', 'tmp', 'test-socks5-raw.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}

process.on('exit', (code) => fs.appendFileSync(LOG, `[EXIT] code=${code}\n`));
process.on('uncaughtException',  (e) => { log(`[uncaughtException] ${e.stack ?? e.message}`); process.exit(1); });
process.on('unhandledRejection', (r) => { log(`[unhandledRejection] ${String(r)}`); process.exit(1); });

fs.writeFileSync(LOG, `=== test-socks5-raw ${new Date().toISOString()} ===\n`);

async function main(): Promise<void> {
  log(`Connecting to SOCKS5 proxy ${PROXY_HOST}:${PROXY_PORT}...`);

  await new Promise<void>((resolve, reject) => {
    const OVERALL_TIMEOUT = 15_000;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Overall timeout 30s')); }, OVERALL_TIMEOUT);

    const sock = net.createConnection({ host: PROXY_HOST, port: PROXY_PORT });
    sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`TCP connect error: ${e.message}`)); });

    sock.once('connect', () => {
      log('✔ TCP connected to SOCKS5 proxy');

      // ── Phase 1: Greeting ─────────────────────────────────────────────────
      // \x05 = SOCKS5, \x01 = 1 method, \x02 = USERNAME/PASSWORD
      sock.write(Buffer.from([0x05, 0x01, 0x02]));
      log('→ Sent SOCKS5 greeting (method: USERNAME/PASSWORD)');

      let phase: 'auth_select' | 'auth_verify' | 'connect_resp' | 'http' = 'auth_select';
      let buf = Buffer.alloc(0);
      let tlsSock: tls.TLSSocket | null = null;

      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        log(`  [${phase}] received ${chunk.length} bytes: ${chunk.slice(0, 8).toString('hex')}`);

        if (phase === 'auth_select') {
          if (buf.length < 2) return;
          const method = buf[1];
          log(`  Server chose auth method: 0x${method?.toString(16) ?? '??'}`);
          if (method === 0xFF) { sock.destroy(); reject(new Error('SOCKS5: no acceptable auth methods (server returned 0xFF)')); return; }
          if (method !== 0x02) { sock.destroy(); reject(new Error(`SOCKS5: unexpected method 0x${method?.toString(16)}`)); return; }
          buf   = buf.slice(2);
          phase = 'auth_verify';

          // ── Phase 2: Username/Password auth ─────────────────────────────
          const userBuf = Buffer.from(PROXY_USER, 'utf-8');
          const passBuf = Buffer.from(PROXY_PASS, 'utf-8');
          const authPkt = Buffer.concat([
            Buffer.from([0x01, userBuf.length]),
            userBuf,
            Buffer.from([passBuf.length]),
            passBuf,
          ]);
          sock.write(authPkt);
          log(`→ Sent auth (user=${PROXY_USER}, pass=***)`);
          return;
        }

        if (phase === 'auth_verify') {
          if (buf.length < 2) return;
          const status = buf[1];
          log(`  Auth response: ver=0x${buf[0]?.toString(16)} status=0x${status?.toString(16)}`);
          if (status !== 0x00) { sock.destroy(); reject(new Error(`SOCKS5: auth failed, status=0x${status?.toString(16)}`)); return; }
          log('✔ SOCKS5 auth OK');
          buf   = buf.slice(2);
          phase = 'connect_resp';

          // ── Phase 3: CONNECT request ─────────────────────────────────────
          const hostBuf = Buffer.from(TARGET_HOST, 'utf-8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(TARGET_PORT, 0);
          const connectPkt = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            portBuf,
          ]);
          sock.write(connectPkt);
          log(`→ Sent SOCKS5 CONNECT to ${TARGET_HOST}:${TARGET_PORT}`);
          return;
        }

        if (phase === 'connect_resp') {
          if (buf.length < 4) return;
          const rep  = buf[1];
          const atyp = buf[3]!;
          const repMessages: Record<number, string> = {
            0: 'success', 1: 'general SOCKS failure', 2: 'connection not allowed',
            3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused',
            6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
          };
          log(`  CONNECT response: rep=0x${rep?.toString(16)} (${repMessages[rep ?? 0] ?? 'unknown'}) atyp=0x${atyp.toString(16)}`);
          if (rep !== 0x00) {
            sock.destroy();
            reject(new Error(`SOCKS5 CONNECT rejected: ${repMessages[rep ?? 99] ?? `code ${rep}`} — GDT:443 may be blocked`));
            return;
          }

          // Wait for full response including BND.ADDR + BND.PORT
          let expectedLen: number;
          if (atyp === 0x01) expectedLen = 10;
          else if (atyp === 0x04) expectedLen = 22;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            expectedLen = 5 + (buf[4] ?? 0) + 2;
          } else expectedLen = 10;
          if (buf.length < expectedLen) return;

          log('✔ SOCKS5 CONNECT success — tunnel established');
          sock.removeListener('data', onData);
          sock.setTimeout(0);
          phase = 'http';

          // ── Phase 4: TLS handshake ────────────────────────────────────────
          log('→ Starting TLS handshake...');
          tlsSock = tls.connect({
            socket: sock,
            servername: TARGET_HOST,
            rejectUnauthorized: false,
          });

          const tlsTimer = setTimeout(() => {
            tlsSock?.destroy();
            reject(new Error('TLS handshake timeout 15s'));
          }, 15_000);

          tlsSock.once('error', (e) => {
            clearTimeout(tlsTimer);
            reject(new Error(`TLS error: ${e.message}`));
          });

          tlsSock.once('secureConnect', () => {
            clearTimeout(tlsTimer);
            const cert = tlsSock!.getPeerCertificate();
            log(`✔ TLS handshake OK — cert: ${cert?.subject?.CN ?? 'unknown'}`);

            // ── Phase 5: HTTP GET /api/captcha ─────────────────────────────
            log('→ Sending HTTP GET /api/captcha...');
            const req = [
              `GET /api/captcha HTTP/1.1`,
              `Host: ${TARGET_HOST}`,
              `Accept: application/json`,
              `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`,
              `Connection: close`,
              ``,
              ``,
            ].join('\r\n');
            tlsSock!.write(req);

            let httpBuf = '';
            const httpTimer = setTimeout(() => {
              tlsSock?.destroy();
              reject(new Error('HTTP GET /api/captcha timeout 15s'));
            }, 15_000);

            tlsSock!.on('data', (chunk: Buffer) => {
              httpBuf += chunk.toString('utf-8');
              // Wait for headers at minimum
              if (httpBuf.includes('\r\n\r\n')) {
                clearTimeout(httpTimer);
                clearTimeout(timer);
                tlsSock?.destroy();
                sock.destroy();

                const [headers, body = ''] = httpBuf.split('\r\n\r\n') as [string, string];
                const statusLine = headers.split('\r\n')[0] ?? '';
                log(`✔ HTTP response: ${statusLine}`);
                log(`  Body (first 300): ${body.slice(0, 300)}`);

                // Parse JSON
                try {
                  const json = JSON.parse(body.trim().split('\r\n').pop() ?? body.trim()) as { key?: string; content?: string };
                  log(`  Captcha key: ${json.key}`);
                  log(`  Content len: ${json.content?.length ?? 0}`);
                } catch {
                  // chunked transfer — try to parse last non-empty line
                  const lines = body.trim().split('\n').filter(l => l.trim().length > 10);
                  const lastLine = lines[lines.length - 1] ?? '';
                  try {
                    const json = JSON.parse(lastLine) as { key?: string; content?: string };
                    log(`  Captcha key: ${json.key}`);
                    log(`  Content len: ${json.content?.length ?? 0}`);
                  } catch {
                    log(`  (Could not parse JSON: ${lastLine.slice(0, 100)})`);
                  }
                }

                console.log('\n════════════════════════════════════════════════════');
                console.log('✅ SOCKS5 proxy hoạt động tốt với GDT:443!');
                console.log(`✅ HTTP status: ${statusLine}`);
                console.log(`Log: ${LOG}`);
                console.log('════════════════════════════════════════════════════');
                resolve();
              }
            });

            tlsSock!.once('end', () => {
              clearTimeout(httpTimer);
              clearTimeout(timer);
              // Parse whatever we got
              if (httpBuf.length > 0 && !httpBuf.includes('\r\n\r\n')) {
                log(`HTTP stream ended before headers. Raw (${httpBuf.length} bytes): ${httpBuf.slice(0, 200)}`);
              }
              resolve();
            });

            tlsSock!.once('error', (e) => {
              clearTimeout(httpTimer);
              clearTimeout(timer);
              reject(new Error(`HTTP/TLS read error: ${e.message}`));
            });
          });
          return;
        }
      };

      sock.on('data', onData);
      sock.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Socket error during ${phase}: ${e.message}`));
      });
    });
  });
}

main()
  .then(() => {
    log('=== DONE OK ===');
    process.exit(0);
  })
  .catch((e: unknown) => {
    const msg = (e as Error).message;
    log(`=== FAILED: ${msg} ===`);
    console.error(`\n❌ FAILED: ${msg}`);
    console.log(`Log: ${LOG}`);
    process.exit(1);
  });
