/**
 * proxy-tunnel.ts
 *
 * Creates a custom http.Agent that tunnels through an HTTP CONNECT proxy,
 * performing TLS itself inside createConnection.
 *
 * Architecture: createConnection does the full pipeline —
 *   raw TCP → HTTP CONNECT → TLS handshake → return TLS socket
 * Node's http.request then writes HTTP text directly to the TLS socket,
 * so GDT receives a valid HTTPS request (HTTP over TLS).
 *
 * IMPORTANT: Use with http.request (not https.request) and with
 *            baseURL = "http://..." so axios picks httpAgent, not httpsAgent.
 *            Using https.Agent would double-wrap TLS and break the connection.
 *            Using http.Agent bypasses Node's TLS wrapping and sends HTTP
 *            directly to our already-encrypted TLS socket.
 *
 * Why not use https-proxy-agent / tunnel npm package?
 * Residential proxies (e.g. tmproxy.net) close the TCP connection immediately
 * after sending "200 Connection Established", which defeats the HTTP response
 * parser used by those libraries. Our raw byte listener handles this correctly.
 *
 * Why not https.Agent with raw TCP socket in createConnection?
 * Node's https engine introduces an event-loop roundtrip between secureConnect
 * and the first HTTP write. GDT has a very short idle timeout, causing it to
 * close the connection before the first byte arrives.
 */

import * as net  from 'net';
import * as tls  from 'tls';
import * as http from 'http';
import { URL } from 'url';

export interface ProxyOptions {
  /** Full proxy URL, e.g. "http://user:pass@1.2.3.4:8080" */
  proxyUrl: string;
  /** Skip TLS verification for the target server (default: false = verify normally) */
  rejectUnauthorized?: boolean;
  /**
   * Set to true for plain-HTTP targets (port 80).
   * When true, the tunnel returns the raw TCP socket after CONNECT 200 instead
   * of wrapping it in TLS. Use with http:// axios URLs + httpAgent.
   * Default: false (assumes HTTPS target — wraps TLS after CONNECT).
   */
  plainHttp?: boolean;
}

/**
 * Build a custom HTTP agent whose createConnection establishes the full
 * TCP → CONNECT → TLS pipeline and returns the TLS socket.
 *
 * Callers MUST use this with http.request (axios baseURL = "http://...") so
 * that Node writes HTTP text directly to the TLS socket without an additional
 * TLS wrapping layer.
 *
 * Usage:
 *   const agent = createTunnelAgent({ proxyUrl: 'http://user:pass@host:port' });
 *   const axiosInstance = axios.create({
 *     baseURL: 'http://hoadondientu.gdt.gov.vn:30000',   // ← http, not https
 *     httpAgent: agent,
 *   });
 */
export function createTunnelAgent(opts: ProxyOptions): http.Agent {
  const proxy     = new URL(opts.proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 80;
  const proxyAuth = proxy.username
    ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
    : null;

  const rejectUnauthorized = opts.rejectUnauthorized ?? false;
  const plainHttp          = opts.plainHttp          ?? false;

  const agent = new http.Agent({ keepAlive: false });

  // Override createConnection:
  //  1. Open raw TCP connection to the proxy
  //  2. Send HTTP CONNECT; wait for 200 response
  //  3. Perform TLS handshake over the raw TCP socket
  //  4. Return the TLS socket → http.request writes HTTP directly to it
  //     (no second TLS layer, no event-loop roundtrip before first write)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).createConnection = (
    connectOpts: { host?: string | null; hostname?: string | null; port?: number; servername?: string },
    callback: (err: Error | null, socket: net.Socket | null) => void,
  ): void => {
    const targetHost = connectOpts.hostname || connectOpts.host || 'localhost';
    const targetPort = connectOpts.port ?? 443;
    const servername = connectOpts.servername || targetHost;

    // 1. Raw TCP to proxy
    const sock = net.createConnection({ host: proxyHost, port: proxyPort });

    sock.once('error',   (err) => callback(err, null));
    sock.once('timeout', ()    => { sock.destroy(); callback(new Error('Proxy TCP connection timed out'), null); });
    sock.setTimeout(30_000);

    sock.once('connect', () => {
      // 2. HTTP CONNECT tunnel request
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        authHeader +
        `\r\n`,
      );

      // 3. Read proxy response until blank line (\r\n\r\n)
      //    Raw byte accumulation handles proxies that close TCP immediately
      //    after "200 Connection Established" (before libraries parse it).
      let buf = Buffer.alloc(0);

      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.toString('ascii').includes('\r\n\r\n')) return;

        sock.removeListener('data', onData);
        sock.setTimeout(0);
        sock.setKeepAlive(true, 5_000);  // prevent TMProxy idle-timeout during slow binary downloads

        const statusLine = buf.toString('ascii').split('\r\n')[0] ?? '';
        if (!statusLine.includes('200')) {
          sock.destroy();
          callback(new Error(`Proxy CONNECT failed: ${statusLine}`), null);
          return;
        }

        // 4a. Plain HTTP target: return the raw TCP socket directly.
        //     http.request will write HTTP text to it (no TLS needed).
        if (plainHttp) {
          callback(null, sock as unknown as net.Socket);
          return;
        }

        // 4b. HTTPS target: upgrade to TLS over the existing TCP socket.
        //    We do TLS here so http.request gets a ready-to-use TLS socket.
        //    When the callback fires, http writes HTTP headers immediately
        //    (synchronously in the same tick) — no event-loop gap, no timeout.
        const tlsSock = tls.connect({
          socket: sock,
          servername,
          rejectUnauthorized,
        });

        // Guard: TLS handshake can hang indefinitely if proxy accepts TCP but GDT
        // throttles the TLS ServerHello (observed in prod: zombie locks for 4+ hours).
        const TLS_HANDSHAKE_TIMEOUT_MS = 15_000;
        const tlsTimer = setTimeout(() => {
          tlsSock.destroy(new Error('TLS handshake timeout after 15s'));
        }, TLS_HANDSHAKE_TIMEOUT_MS);

        tlsSock.once('error',         (err) => { clearTimeout(tlsTimer); callback(err, null); });
        tlsSock.once('secureConnect', ()    => { clearTimeout(tlsTimer); callback(null, tlsSock as unknown as net.Socket); });
      };

      sock.on('data', onData);
    });
  };

  return agent;
}

/**
 * Build a custom HTTP agent that tunnels through a SOCKS5 proxy,
 * performing TLS inside createConnection.
 *
 * Architecture: TCP → SOCKS5 handshake (RFC 1928 + RFC 1929) → TLS → HTTP text
 *
 * SOCKS5 vs HTTP CONNECT for binary downloads:
 *   HTTP CONNECT — proxy may inspect/filter response content (port 30000 gets 403 on 2captcha)
 *   SOCKS5       — pure TCP relay, no content inspection, no port filtering
 *
 * Usage: identical to createTunnelAgent.
 *   Pass socks5ProxyUrl = "socks5://user:pass@host:port"
 *   Use with http.request + baseURL = "http://hoadondientu.gdt.gov.vn:30000"
 */
export function createSocks5TunnelAgent(opts: ProxyOptions): http.Agent {
  const proxy     = new URL(opts.proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = Number(proxy.port) || 1080;
  const username  = decodeURIComponent(proxy.username);
  const password  = decodeURIComponent(proxy.password);
  const rejectUnauthorized = opts.rejectUnauthorized ?? false;

  const agent = new http.Agent({ keepAlive: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (agent as any).createConnection = (
    connectOpts: { host?: string | null; hostname?: string | null; port?: number; servername?: string },
    callback: (err: Error | null, socket: net.Socket | null) => void,
  ): void => {
    const targetHost = connectOpts.hostname || connectOpts.host || 'localhost';
    const targetPort = connectOpts.port ?? 443;
    const servername = connectOpts.servername || targetHost;

    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    sock.once('error',   (err) => callback(err, null));
    sock.once('timeout', ()    => { sock.destroy(); callback(new Error('SOCKS5 TCP connection timed out'), null); });
    sock.setTimeout(30_000);

    sock.once('connect', () => {
      let phase: 'auth_select' | 'auth_verify' | 'connect' = 'auth_select';
      let buf = Buffer.alloc(0);

      // Phase 1: Greeting — advertise username/password auth (method 0x02)
      sock.write(Buffer.from([0x05, 0x01, 0x02]));

      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);

        if (phase === 'auth_select') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x02) {
            sock.destroy();
            callback(new Error(`SOCKS5: auth method rejected (server chose 0x${buf[1]?.toString(16) ?? '??'})`), null);
            return;
          }
          buf   = buf.slice(2);
          phase = 'auth_verify';
          // Phase 2: Username/password sub-negotiation (RFC 1929)
          const userBuf = Buffer.from(username, 'utf-8');
          const passBuf = Buffer.from(password, 'utf-8');
          sock.write(Buffer.concat([
            Buffer.from([0x01, userBuf.length]),
            userBuf,
            Buffer.from([passBuf.length]),
            passBuf,
          ]));
          return;
        }

        if (phase === 'auth_verify') {
          if (buf.length < 2) return;
          if (buf[0] !== 0x01 || buf[1] !== 0x00) {
            sock.destroy();
            callback(new Error('SOCKS5: authentication failed — wrong username or password'), null);
            return;
          }
          buf   = buf.slice(2);
          phase = 'connect';
          // Phase 3: CONNECT request — ATYP=0x03 (domain name)
          const hostBuf = Buffer.from(targetHost, 'utf-8');
          const portBuf = Buffer.alloc(2);
          portBuf.writeUInt16BE(targetPort, 0);
          sock.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            portBuf,
          ]));
          return;
        }

        if (phase === 'connect') {
          // Minimum response is 4 bytes: VER REP RSV ATYP
          if (buf.length < 4) return;
          if (buf[0] !== 0x05 || buf[1] !== 0x00) {
            const repMessages: Record<number, string> = {
              1: 'general SOCKS failure',       2: 'connection blocked by ruleset',
              3: 'network unreachable',          4: 'host unreachable',
              5: 'connection refused',           6: 'TTL expired',
              7: 'command not supported',        8: 'address type not supported',
            };
            const rep = buf[1] ?? 0;
            sock.destroy();
            callback(new Error(`SOCKS5 CONNECT failed: ${repMessages[rep] ?? `code ${rep}`}`), null);
            return;
          }
          // Determine total response length from ATYP to skip BND.ADDR + BND.PORT
          const atyp = buf[3]!;
          let expectedLen: number;
          if      (atyp === 0x01) expectedLen = 10;               // IPv4 (4 + 4 + 2)
          else if (atyp === 0x04) expectedLen = 22;               // IPv6 (4 + 16 + 2)
          else if (atyp === 0x03) {
            if (buf.length < 5) return;                           // need domain length byte
            expectedLen = 5 + (buf[4] ?? 0) + 2;                 // domain
          } else  expectedLen = 10;                               // fallback IPv4
          if (buf.length < expectedLen) return;

          // SOCKS5 tunnel established — wrap in TLS
          sock.removeListener('data', onData);
          sock.setTimeout(0);
          sock.setKeepAlive(true, 5_000);  // prevent TMProxy idle-timeout during slow binary downloads
          const tlsSock = tls.connect({ socket: sock, servername, rejectUnauthorized });

          // Same TLS handshake timeout as HTTP CONNECT tunnel
          const TLS_HANDSHAKE_TIMEOUT_MS = 15_000;
          const tlsTimer = setTimeout(() => {
            tlsSock.destroy(new Error('TLS handshake timeout after 15s'));
          }, TLS_HANDSHAKE_TIMEOUT_MS);

          tlsSock.once('error',         (err) => { clearTimeout(tlsTimer); callback(err, null); });
          tlsSock.once('secureConnect', ()    => { clearTimeout(tlsTimer); callback(null, tlsSock as unknown as net.Socket); });
        }
      };

      sock.on('data', onData);
      sock.on('error', (err) => callback(err, null));
    });
  };

  return agent;
}

/**
 * TLS-level probe: verify that this proxy can complete a full TLS handshake
 * with a target host:port (typically GDT port 30000).
 *
 * Unlike a plain TCP probe (which only checks the proxy server is reachable),
 * this test catches IP-based GDT blocks that happen at the TLS layer:
 *   TCP to proxy → CONNECT to target → TLS handshake → if secureConnect fires = OK
 *
 * Returns true if TLS handshake completes, false otherwise.
 * Timeout: 12s (GDT-blocked IPs fail in ~1-2s, so this gives plenty of margin).
 *
 * Use this before consuming captcha credits or DB lock to fail fast on blocked IPs.
 */
export async function probeTlsViaProxy(
  proxyUrl: string,
  targetHost: string,
  targetPort: number,
  timeoutMs = 12_000,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tlsSock?.destroy();
      sock?.destroy();
      resolve(ok);
    };

    let proxy: URL;
    try { proxy = new URL(proxyUrl); } catch { resolve(false); return; }

    const proxyHost = proxy.hostname;
    const proxyPort = Number(proxy.port) || 80;
    const proxyAuth = proxy.username
      ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      : null;

    const timer = setTimeout(() => done(false), timeoutMs);
    let tlsSock: tls.TLSSocket | undefined;

    const sock = net.createConnection({ host: proxyHost, port: proxyPort });
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => done(false));

    sock.once('connect', () => {
      const authHeader = proxyAuth
        ? `Proxy-Authorization: Basic ${Buffer.from(proxyAuth).toString('base64')}\r\n`
        : '';
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`,
      );

      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        buf = Buffer.concat([buf, chunk]);
        if (!buf.toString('ascii').includes('\r\n\r\n')) return;
        sock.removeListener('data', onData);

        const statusLine = buf.toString('ascii').split('\r\n')[0] ?? '';
        if (!statusLine.includes('200')) { done(false); return; }

        sock.setTimeout(0);
        tlsSock = tls.connect({ socket: sock, servername: targetHost, rejectUnauthorized: false });
        tlsSock.once('secureConnect', () => done(true));
        tlsSock.once('error', () => done(false));
      };
      sock.on('data', onData);
    });
  });
}

/**
 * Parse a proxy URL string and return its components.
 * Returns null if no proxy is configured.
 */
export function parseProxyUrl(raw: string | undefined | null): ProxyOptions | null {
  if (!raw || raw.trim() === '') return null;
  try {
    new URL(raw); // validate
    return { proxyUrl: raw };
  } catch {
    return null;
  }
}


