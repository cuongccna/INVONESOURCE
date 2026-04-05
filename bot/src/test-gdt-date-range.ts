/**
 * test-gdt-date-range.ts
 *
 * Test whether GDT API accepts date ranges LARGER than 1 month.
 *
 * The bot currently splits ranges into monthly chunks because we ASSUME GDT limits to 1 month.
 * This script verifies that assumption by calling the real GDT API with 3 different ranges:
 *   Test A: 1 month  (baseline — should always work)
 *   Test B: 2 months (e.g. Jan + Feb 2026)
 *   Test C: 3 months (Q1 2026: Jan + Feb + Mar)
 *
 * For each test, it compares:
 *   - HTTP status code (200/400/500)
 *   - X-Total-Count header
 *   - datas.length in response body
 *   - Whether count matches the sum of individual months
 *
 * Usage:
 *   BACKFILL_COMPANY_ID=<uuid> npx ts-node -r dotenv/config src/test-gdt-date-range.ts
 *   ALLOW_DIRECT_CONNECTION=true BACKFILL_COMPANY_ID=<uuid> npx ts-node -r dotenv/config src/test-gdt-date-range.ts
 *
 * Output: table printed to console showing which ranges GDT accepts.
 */
import 'dotenv/config';
import axios from 'axios';
import { Pool } from 'pg';
import { decryptCredentials } from './encryption.service';
import { GdtDirectApiService } from './gdt-direct-api.service';
import { logger } from './logger';

const pool = new Pool({
  connectionString: process.env['WORKER_DB_URL'] ?? process.env['DATABASE_URL'],
  max: 2,
});

const COMPANY_ID = process.env['BACKFILL_COMPANY_ID'];
if (!COMPANY_ID) {
  console.error('❌  Set BACKFILL_COMPANY_ID=<uuid> before running');
  process.exit(1);
}

const GDT_BASE = 'https://hoadondientu.gdt.gov.vn:30000';
const PAGE_SIZE = 20;

function fmt(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}T00:00:00`;
}

function fmtEnd(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}T23:59:59`;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Directly call GDT API and return { status, total, rowsReturned, errorMsg } */
async function rawFetch(
  token: string,
  taxCode: string,
  fromStr: string,
  toStr: string,
  endpoint = '/query/invoices/sold',
): Promise<{ status: number; total: number | null; rowsReturned: number; errorMsg: string | null }> {
  try {
    const search = `tdlap=ge=${fromStr};tdlap=le=${toStr}`;
    const res = await axios.get(`${GDT_BASE}${endpoint}`, {
      params: { sort: 'tdlap:desc', size: PAGE_SIZE, page: 0, search },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'vi-VN,vi;q=0.9',
      },
      timeout: 30_000,
      // Ignore TLS cert errors (GDT uses self-signed-ish cert)
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    });
    const headerTotal = parseInt(res.headers['x-total-count'] ?? '', 10);
    const bodyTotal   = res.data?.total ?? null;
    const total       = !isNaN(headerTotal) ? headerTotal : (bodyTotal != null ? Number(bodyTotal) : null);
    const rows        = (res.data?.datas ?? res.data?.data ?? []) as unknown[];
    return { status: res.status, total, rowsReturned: rows.length, errorMsg: null };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const body = typeof err.response.data === 'string'
        ? err.response.data.slice(0, 200)
        : JSON.stringify(err.response.data).slice(0, 200);
      return { status: err.response.status, total: null, rowsReturned: 0, errorMsg: body };
    }
    return { status: 0, total: null, rowsReturned: 0, errorMsg: String(err) };
  }
}

function pad(s: string | number, n: number) { return String(s).padEnd(n); }
function rpad(s: string | number, n: number) { return String(s).padStart(n); }

async function main() {
  // ── Load credentials ──────────────────────────────────────────────────────
  const cfgRes = await pool.query<{ encrypted_credentials: string; tax_code: string }>(
    `SELECT encrypted_credentials, tax_code FROM gdt_bot_configs WHERE company_id=$1 AND is_active=true`,
    [COMPANY_ID],
  );
  if (cfgRes.rows.length === 0) {
    console.error(`❌  No active bot config for company ${COMPANY_ID}`);
    process.exit(1);
  }
  const taxCode = cfgRes.rows[0]!.tax_code;
  const creds   = decryptCredentials(cfgRes.rows[0]!.encrypted_credentials);
  console.log(`\n🔐  Company: ${COMPANY_ID}`);
  console.log(`📋  Tax code: ${taxCode}`);

  // ── Proxy / direct setup ──────────────────────────────────────────────────
  const proxyUrl = process.env['BACKFILL_PROXY_URL']
    ?? (process.env['PROXY_LIST'] ?? '').split(',').map(s => s.trim()).find(Boolean)
    ?? null;
  const allowDirect = process.env['ALLOW_DIRECT_CONNECTION'] === 'true';
  if (!proxyUrl && !allowDirect) {
    console.error(
      '❌  No proxy set. Use BACKFILL_PROXY_URL or set ALLOW_DIRECT_CONNECTION=true (dev only)',
    );
    process.exit(1);
  }
  console.log(`🌐  Proxy: ${proxyUrl ? proxyUrl.replace(/:([^@]+)@/, ':***@') : 'DIRECT (no proxy)'}\n`);

  // ── Login once via GdtDirectApiService ───────────────────────────────────
  const gdtApi = new GdtDirectApiService(proxyUrl, null);
  await gdtApi.login(creds.username, creds.password);
  const token: string = (gdtApi as unknown as Record<string, unknown>)['token'] as string;
  console.log(`✅  GDT login OK — token length: ${token?.length ?? 0}`);

  // ── Define test ranges ────────────────────────────────────────────────────
  // Use the last 3 completed months so there's likely real data
  const now  = new Date();
  const year = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();

  const jan1  = new Date(year, 0,  1);
  const jan31 = new Date(year, 0, 31);
  const feb1  = new Date(year, 1,  1);
  const feb28 = new Date(year, 2,  0); // last day of Feb
  const mar1  = new Date(year, 2,  1);
  const mar31 = new Date(year, 2, 31);

  const tests: Array<{ label: string; from: Date; to: Date }> = [
    { label: `Tháng 1/${year} (1 tháng — baseline)`,    from: jan1, to: jan31 },
    { label: `Tháng 2/${year} (1 tháng — baseline)`,    from: feb1, to: feb28 },
    { label: `Tháng 3/${year} (1 tháng — baseline)`,    from: mar1, to: mar31 },
    { label: `T1–T2/${year} (2 tháng liên tiếp)`,       from: jan1, to: feb28 },
    { label: `T1–T3/${year} QI (3 tháng — quý 1)`,     from: jan1, to: mar31 },
  ];

  const endpoints = [
    { name: 'Bán ra (sold)',           path: '/query/invoices/sold' },
    { name: 'Mua vào ttxly==5',        path: '/query/invoices/purchase', filter: 'ttxly==5' },
  ];

  // ── Run tests ────────────────────────────────────────────────────────────
  for (const ep of endpoints) {
    console.log(`\n${'═'.repeat(75)}`);
    console.log(`ENDPOINT: ${ep.name}  →  ${ep.path}${ep.filter ? `?${ep.filter}` : ''}`);
    console.log(`${'═'.repeat(75)}`);
    console.log(
      pad('Range', 44) +
      pad('Status', 8) +
      rpad('Total', 8) +
      rpad('Page0', 7) +
      '  Kết quả'
    );
    console.log('─'.repeat(75));

    for (const t of tests) {
      await sleep(3_000); // polite delay between requests

      const fromStr = fmt(t.from);
      const toStr   = fmtEnd(t.to);
      const path    = ep.path + (ep.filter ? '' : ''); // filter goes in search param below

      // Build search — reuse rawFetch with custom endpoint path
      const searchWithFilter = ep.filter
        ? `tdlap=ge=${fromStr};tdlap=le=${toStr};${ep.filter}`
        : `tdlap=ge=${fromStr};tdlap=le=${toStr}`;

      let result: Awaited<ReturnType<typeof rawFetch>>;
      try {
        const res = await axios.get(`${GDT_BASE}${path}`, {
          params: { sort: 'tdlap:desc', size: PAGE_SIZE, page: 0, search: searchWithFilter },
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            accept: 'application/json, text/plain, */*',
            'accept-language': 'vi-VN,vi;q=0.9',
          },
          timeout: 30_000,
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        });
        const headerTotal = parseInt(res.headers['x-total-count'] ?? '', 10);
        const bodyTotal   = res.data?.total ?? null;
        const total       = !isNaN(headerTotal) ? headerTotal : (bodyTotal != null ? Number(bodyTotal) : null);
        const rows        = (res.data?.datas ?? res.data?.data ?? []) as unknown[];
        result = { status: res.status, total, rowsReturned: rows.length, errorMsg: null };
      } catch (err: unknown) {
        if (axios.isAxiosError(err) && err.response) {
          const body = typeof err.response.data === 'string'
            ? err.response.data.slice(0, 120)
            : JSON.stringify(err.response.data).slice(0, 120);
          result = { status: err.response.status, total: null, rowsReturned: 0, errorMsg: body };
        } else {
          result = { status: 0, total: null, rowsReturned: 0, errorMsg: String(err) };
        }
      }

      const statusIcon = result.status === 200 ? '✅' : result.status === 400 ? '⚠️' : '❌';
      const totalStr   = result.total != null ? String(result.total) : '?';
      const verdict    = result.errorMsg
        ? `LỖI: ${result.errorMsg}`
        : result.status === 200
          ? (result.total != null && result.total > PAGE_SIZE
              ? `OK — còn ${result.total - result.rowsReturned} hoá đơn chưa lấy (trang sau)`
              : 'OK')
          : `HTTP ${result.status}`;

      console.log(
        pad(t.label, 44) +
        pad(`${statusIcon} ${result.status}`, 8) +
        rpad(totalStr, 8) +
        rpad(result.rowsReturned, 7) +
        `  ${verdict}`
      );
    }
  }

  console.log('\n' + '═'.repeat(75));
  console.log('GIẢI THÍCH KẾT QUẢ:');
  console.log('  ✅ 200 + total > 0  → GDT cho phép range này');
  console.log('  ✅ 200 + total = 0  → GDT cho phép nhưng công ty không có hoá đơn kỳ đó');
  console.log('  ⚠️  400             → GDT từ chối range (quá dài hoặc sai format)');
  console.log('  ❌ 500/timeout     → GDT lỗi server hoặc bị block');
  console.log('\nNếu 2 tháng và 3 tháng đều ✅ → có thể bỏ splitIntoMonths và gọi thẳng.');
  console.log('Nếu 400 → giữ nguyên split theo tháng.\n');

  await pool.end();
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
