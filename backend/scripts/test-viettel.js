/**
 * Viettel VInvoice API Discovery Script
 *
 * Usage:  node scripts/test-viettel.js
 * Run from: backend/
 *
 * Credentials from demo account (change as needed):
 *   username: 0100109106-509
 *   password: 2wsxCDE#
 *
 * This script tries multiple auth endpoints and invoice-list endpoints
 * to determine the correct API shape for the VInvoice system.
 */

'use strict';

const https = require('https');
const http  = require('http');
const url   = require('url');

// ─── Config ──────────────────────────────────────────────────────────────────
const USERNAME = '0100109106-509';
const PASSWORD = '2wsxCDE#';
const TAX_CODE = '0100109106-509';

// Date range: Jan 2025
const FROM_DATE = new Date('2025-01-01T00:00:00.000Z');
const TO_DATE   = new Date('2025-01-31T23:59:59.000Z');
const START_MS  = String(FROM_DATE.getTime());
const END_MS    = String(TO_DATE.getTime());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Simple HTTP(S) request — returns { status, headers, body, bodyText } */
function request({ method, href, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(href);
    const lib    = parsed.protocol === 'https:' ? https : http;

    const bodyBuf = body ? Buffer.from(body, 'utf-8') : null;
    if (bodyBuf) {
      headers['Content-Length'] = String(bodyBuf.length);
    }

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method,
      headers,
      rejectUnauthorized: false, // accept self-signed certs in demo env
      timeout: 30_000,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        let bodyParsed = null;
        try { bodyParsed = JSON.parse(bodyText); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: bodyParsed, bodyText });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function log(label, data) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + label);
  console.log('─'.repeat(60));
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function encodeForm(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// ─── Auth endpoint candidates ────────────────────────────────────────────────

const AUTH_CANDIDATES = [
  // 1. VInvoice custom JSON login — JHipster format, with rememberMe
  {
    label: 'VInvoice JSON login (JHipster LoginVM)',
    href:  'https://vinvoice.viettel.vn/api/authenticate',
    requestHeaders: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, rememberMe: true }),
  },
  // 2. api-vinvoice OAuth2 — client_secret = "web_app"
  {
    label: 'OAuth2 /oauth/token (secret=web_app)',
    href:  'https://api-vinvoice.viettel.vn/oauth/token',
    requestHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from('web_app:web_app').toString('base64'),
      'Accept': '*/*',
    },
    body: encodeForm({ grant_type: 'password', username: USERNAME, password: PASSWORD }),
  },
  // 3. OAuth2 — known JHipster default secret
  {
    label: 'OAuth2 /oauth/token (secret=my-secret-key-which-should-be-changed-in-production)',
    href:  'https://api-vinvoice.viettel.vn/oauth/token',
    requestHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from('web_app:my-secret-key-which-should-be-changed-in-production').toString('base64'),
      'Accept': '*/*',
    },
    body: encodeForm({ grant_type: 'password', username: USERNAME, password: PASSWORD }),
  },
  // 4. OAuth2 — no Basic auth header (client is public)
  {
    label: 'OAuth2 /oauth/token (no Basic auth)',
    href:  'https://api-vinvoice.viettel.vn/oauth/token',
    requestHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
    },
    body: encodeForm({ grant_type: 'password', username: USERNAME, password: PASSWORD, client_id: 'web_app' }),
  },
  // 5. api-vinvoice JSON login
  {
    label: 'api-vinvoice /api/authenticate (JSON)',
    href:  'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/authenticate',
    requestHeaders: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, rememberMe: false }),
  },
  // 6. api-vinvoice JSON login without sub-path
  {
    label: 'api-vinvoice root /api/authenticate (JSON)',
    href:  'https://api-vinvoice.viettel.vn/api/authenticate',
    requestHeaders: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, rememberMe: false }),
  },
  // 7. OAuth2 with scope=openid
  {
    label: 'OAuth2 /oauth/token (secret=web_app, scope=openid)',
    href:  'https://api-vinvoice.viettel.vn/oauth/token',
    requestHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from('web_app:web_app').toString('base64'),
      'Accept': '*/*',
    },
    body: encodeForm({ grant_type: 'password', username: USERNAME, password: PASSWORD, scope: 'openid' }),
  },
  // 8. Try vinvoice.viettel.vn JHipster JWT auth (GET request to diagnose 405)
  {
    label: 'VInvoice GET /api/authenticate (diagnose)',
    href:  'https://vinvoice.viettel.vn/api/authenticate',
    requestHeaders: { 'Accept': 'application/json, text/plain, */*' },
    body: null,
    method: 'GET',
  },
];

// ─── Invoice list endpoint candidates (used after successful auth) ────────────

function invoiceCandidates(token) {
  const BASE = 'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS';

  const authHeader = { Authorization: `Bearer ${token}` };

  return [
    // 1. Form-encoded with all known GetInvoiceInput fields
    {
      label: 'getListInvoice (form-encoded)',
      href: `${BASE}/getListInvoice`,
      requestHeaders: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ supplierTaxCode: TAX_CODE, startDate: START_MS, endDate: END_MS, rowPerPage: 10, pageNum: 0 }),
    },
    // 2. JSON body
    {
      label: 'getListInvoice (application/json)',
      href: `${BASE}/getListInvoice`,
      requestHeaders: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierTaxCode: TAX_CODE, startDate: START_MS, endDate: END_MS, rowPerPage: 10, pageNum: 0 }),
    },
    // 3. getInvoiceList variant
    {
      label: 'getInvoiceList (form-encoded)',
      href: `${BASE}/getInvoiceList`,
      requestHeaders: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ supplierTaxCode: TAX_CODE, startDate: START_MS, endDate: END_MS, rowPerPage: 10, pageNum: 0 }),
    },
    // 4. getListInvoiceDataControl (old pattern)
    {
      label: 'getListInvoiceDataControl (form-encoded)',
      href: `${BASE}/getListInvoiceDataControl`,
      requestHeaders: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ supplierTaxCode: TAX_CODE, startDate: START_MS, endDate: END_MS, rowPerPage: 10, pageNum: 0 }),
    },
    // 5. Input invoices
    {
      label: 'getListInvoiceInput (form-encoded)',
      href: `${BASE}/getListInvoiceInput`,
      requestHeaders: { ...authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encodeForm({ supplierTaxCode: TAX_CODE, startDate: START_MS, endDate: END_MS, rowPerPage: 10, pageNum: 0 }),
    },
  ];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  VIETTEL VInvoice API Discovery');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Username : ${USERNAME}`);
  console.log(`  Tax Code : ${TAX_CODE}`);
  console.log(`  Date from: ${FROM_DATE.toISOString()} (${START_MS} ms)`);
  console.log(`  Date to  : ${TO_DATE.toISOString()} (${END_MS} ms)`);
  console.log('════════════════════════════════════════════════════════════\n');

  let accessToken = null;

  // ── Step 1: Try auth endpoints ──────────────────────────────────────────────
  console.log('\n╔══ Step 1: Trying auth endpoints ══╗\n');

  for (const candidate of AUTH_CANDIDATES) {
    console.log(`\n→ Trying: ${candidate.label}`);
    console.log(`  URL: ${candidate.href}`);

    let result;
    try {
      result = await request({ method: candidate.method ?? 'POST', ...candidate, headers: candidate.requestHeaders });
    } catch (err) {
      console.log(`  ✗ Network error: ${err.message}`);
      continue;
    }

    console.log(`  Status: ${result.status}`);

    if (result.status >= 200 && result.status < 300) {
      log(`✅ AUTH SUCCESS — ${candidate.label}`, result.body ?? result.bodyText);

      // Try to extract token
      const b = result.body;
      if (b) {
        accessToken = b.access_token ?? b.accessToken ?? b.token ?? b.data?.access_token ?? b.data?.token;
        if (accessToken) {
          console.log(`\n  🔑 Token found: ${String(accessToken).substring(0, 80)}...`);
        } else {
          console.log(`  ⚠ Status 2xx but no token found. Full body below:`);
          log('Auth response body', b);
        }
      }
      // Stop trying other auth methods once we find one that works
      if (accessToken) break;
    } else {
      // Show a short snippet of the error
      const snippet = result.bodyText ? result.bodyText.substring(0, 300) : '(empty)';
      console.log(`  ✗ HTTP ${result.status}: ${snippet}`);
    }
  }

  if (!accessToken) {
    console.log('\n⛔ No auth endpoint returned a valid token.');
    console.log('   Possible causes:');
    console.log('   1. Demo account credentials are wrong or expired');
    console.log('   2. Your IP is not whitelisted');
    console.log('   3. The auth endpoint URL is different from all tried variants');
    console.log('\nAll tried URLs:');
    AUTH_CANDIDATES.forEach(c => console.log(`   - ${c.href}`));
    return;
  }

  // ── Step 2: Try invoice list endpoints ─────────────────────────────────────
  console.log('\n╔══ Step 2: Trying invoice list endpoints ══╗\n');

  for (const candidate of invoiceCandidates(accessToken)) {
    console.log(`\n→ Trying: ${candidate.label}`);
    console.log(`  URL: ${candidate.href}`);

    let result;
    try {
      result = await request({ method: 'POST', ...candidate, headers: candidate.requestHeaders });
    } catch (err) {
      console.log(`  ✗ Network error: ${err.message}`);
      continue;
    }

    console.log(`  Status: ${result.status}`);

    if (result.status >= 200 && result.status < 300) {
      log(`✅ INVOICE LIST SUCCESS — ${candidate.label}`, result.body ?? result.bodyText);
      break; // Found a working endpoint
    } else {
      const snippet = result.bodyText ? result.bodyText.substring(0, 300) : '(empty)';
      console.log(`  ✗ HTTP ${result.status}: ${snippet}`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  Discovery complete');
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
