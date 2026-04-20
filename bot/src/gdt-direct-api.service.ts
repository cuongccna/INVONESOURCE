/**
 * GDT Direct API Service
 *
 * Replaces Playwright-based GdtAuthService + GdtBotRunner with direct HTTP calls
 * to hoadondientu.gdt.gov.vn:30000 REST API.
 *
 * Flow (from DevTools inspection):
 *   1. GET  /captcha                              → { key, content: SVG string }
 *   2. SVG  → PNG via sharp → base64 → 2captcha  → cvalue (solved text)
 *   3. POST /security-taxpayer/authenticate       → { token: JWT }
 *   4. GET  /query/invoices/sold            (output list, JSON, paginated)
  *      GET  /query/invoices/purchase        (input list: ttxly==5, ttxly==6, ttxly==8)
 *      GET  /query/invoices/export-xml      (per-invoice signed XML download)
 *      GET  /query/invoices/export-excel    (output bulk XLSX download)
 *      GET  /query/invoices/export-excel-sold?type=purchase  (input bulk XLSX)
 *
 * FIQL query syntax: tdlap=ge=DD/MM/YYYYTHH:MM:SS;tdlap=le=DD/MM/YYYYTHH:MM:SS
 * Pagination:   page=0 (0-indexed), size=50, X-Total-Count response header
 * Sort format:  tdlap:desc  (colon, NOT tdlapdesc)
 */
import axios, { AxiosInstance } from 'axios';
import { createTunnelAgent, createSocks5TunnelAgent } from './proxy-tunnel';
import { CaptchaService } from './captcha.service';
import { logger } from './logger';
import type { RawInvoice } from './parsers/GdtXmlParser';
import type { CrawlerRecipe, RecipeFields } from './types/recipe.types';
import { SyncCheckpoint } from './crawl-cache/SyncCheckpoint';
import type { ProxyManager } from './proxy-manager';

// ── Human-like browser simulation ───────────────────────────────────────────
// Realistic Chrome User-Agents observed on Vietnamese ISPs (Viettel / VNPT / FPT).
// Rotated randomly per session so GDT doesn't see the same UA every 6 hours.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

/**
 * Phase 4: Pick a random UA, guaranteeing it is different from `last`.
 * Prevents GDT from seeing the exact same UA on back-to-back jobs for the same company.
 */
function randomUserAgentExcluding(last: string | null): string {
  const pool = last ? USER_AGENTS.filter(u => u !== last) : USER_AGENTS;
  const source = pool.length > 0 ? pool : USER_AGENTS;
  return source[Math.floor(Math.random() * source.length)]!;
}

/**
 * BUG-1: Custom paramsSerializer — encode keys only, keep FIQL values raw.
 *
 * GDT WAF performs immediate TCP RST when FIQL delimiters are percent-encoded.
 * Default axios encodes:
 *   tdlap=ge=01/03/2026T00:00:00  →  tdlap%3Dge%3D01%2F03%2F2026T00%3A00%3A00
 * GDT WAF treats %3D/%3B as injection → TCP RST, status:0 within 1s.
 *
 * Rule: encode KEY (prevent key collision), do NOT encode VALUE.
 * sort=tdlap:desc → sort key encoded, colon in value stays raw.
 */
function serializeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${String(v)}`)
    .join('&');
}

/**
 * Random delay between min and max ms (inclusive).
 * Used to mimic human think-time between actions.
 */
function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

const GDT_API_HTTPS = 'https://hoadondientu.gdt.gov.vn:30000';
// When tunnelling through a proxy we use http:// as the base URL so that axios
// routes through http.request (which uses httpAgent). Our httpAgent's
// createConnection performs the full TCP→CONNECT→TLS pipeline and returns a
// TLS socket, so HTTP text is encrypted end-to-end. Using https.request would
// double-wrap TLS and break the connection.
const GDT_API_HTTP  = 'http://hoadondientu.gdt.gov.vn:30000';
// sco-query endpoints serve invoices sourced from POS machines (máy tính tiền — MTTTT)
const GDT_SCO_SOLD     = '/sco-query/invoices/sold';
const GDT_SCO_PURCHASE = '/sco-query/invoices/purchase';
const GDT_SCO_DETAIL   = '/sco-query/invoices/detail';
const PAGE_SIZE = 50;

// Retry config for transient errors
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 3_000; // ms
const REQUEST_TIMEOUT = 30_000;
// Binary downloads (XML ZIP, XLSX) can be large and GDT server is slow to generate them.
// TMProxy and residential proxies have short idle timeouts — give generous room.
const BINARY_TIMEOUT = 120_000; // 2 min — override with recipe.timing.binaryTimeoutMs

// ── Peak period detection ─────────────────────────────────────────────────────
// GDT traffic peaks during tax filing deadline (20th of each month).
// Ngày 18-25: response times balloon from ~2s to 5-6 min. Static 30-60s timeouts
// cause mass failures. Dynamic multiplier adjusts all timeouts + retries.

/**
 * Returns a timeout multiplier based on the current day of the month (Vietnam timezone).
 *   Day  1-17, 26-31: 1.0  (normal traffic)
 *   Day 18-20:        4.0  (early peak, approaching deadline)
 *   Day 21-25:        6.0  (post-deadline peak, heaviest load)
 */
export function getPeakTimeoutMultiplier(): number {
  const vnNow = new Date(Date.now() + 7 * 3_600_000); // UTC+7
  const day = vnNow.getUTCDate();
  if (day >= 21 && day <= 25) return 6.0;
  if (day >= 18 && day <= 20) return 4.0;
  return 1.0;
}

/** Returns retry count adjusted for peak periods */
export function getPeakMaxRetries(): number {
  const m = getPeakTimeoutMultiplier();
  return m > 1 ? 5 : MAX_RETRIES; // 3 → 5 during peak
}

/** Returns retry delay base (ms) adjusted for peak periods */
export function getPeakRetryDelay(): number {
  const m = getPeakTimeoutMultiplier();
  return m > 1 ? 8_000 : RETRY_DELAY; // 3s → 8s during peak
}

// VĐ2: Per-endpoint timeouts — /sco-query/ endpoints are significantly slower than /query/
// Base values (normal period). Multiply by getPeakTimeoutMultiplier() at runtime.
const BASE_ENDPOINT_TIMEOUTS: Record<string, number> = {
  '/query/invoices/sold':                   30_000,
  '/query/invoices/purchase':               30_000,
  '/query/invoices/detail':                 45_000,
  '/sco-query/invoices/sold':               60_000,   // sco chậm hơn
  '/sco-query/invoices/purchase':           60_000,
  '/sco-query/invoices/detail':             60_000,
  '/captcha':                               15_000,
  '/security-taxpayer/authenticate':        20_000,
};

/**
 * VĐ1: Detect network-level TCP failures (proxy drop) as distinct from GDT HTTP errors.
 * These should trigger proxy rotation rather than counting toward GDT retry budget.
 */
function isNetworkLevelError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const msg  = error.message.toLowerCase();
  const code = error.code ?? '';
  return (
    error.response === undefined &&  // No HTTP response = network drop
    (
      msg.includes('stream has been aborted') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up') ||
      msg.includes('socket disconnected') ||
      code === 'ECONNABORTED' ||
      code === 'ERR_STREAM_DESTROYED' ||
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED'
    )
  );
}

// ── GDT API types ──────────────────────────────────────────────────────────────

interface CaptchaResponse {
  key:     string;
  content: string; // SVG XML string
}

interface AuthResponse {
  token: string;
}

/** Supplementary key-value field from GDT detail response (ttkhac arrays) */
interface GdtTtkhacEntry {
  ttruong?: string;  // field label
  kdlieu?:  string;  // data type
  dlieu?:   unknown; // value (string number or null)
}

/** One line item from hdhhdvu in the GDT detail response */
interface GdtHdhhdvuItem {
  stt?:     number;   // line number
  ten?:     string;   // item name
  sluong?:  number;   // quantity
  dgia?:    number;   // unit price
  dvtinh?:  string;   // unit
  tsuat?:   number;   // VAT rate as decimal (e.g. 0.08)
  ltsuat?:  string;   // VAT rate as string (e.g. "8%")
  thtien?:  number;   // subtotal before VAT
  tthue?:   number;   // VAT amount per line (may be null)
  stckhau?: number;   // discount amount
  tlckhau?: number;   // discount rate
  tchat?:   number;
  ttkhac?:  GdtTtkhacEntry[];
}

/** Top-level GDT invoice detail response */
interface GdtInvoiceDetail {
  nbmst?:    string;
  khhdon?:   string;
  shdon?:    number;
  khmshdon?: number;
  nbten?:    string;   // seller name
  nmten?:    string;   // buyer name
  nmmst?:    string;   // buyer tax code
  tdlap?:    string;   // invoice date ISO
  tgtcthue?: number;   // total before VAT
  tgtthue?:  number;   // total VAT
  tgtttbso?: number;   // total with VAT
  ttxly?:    number;   // processing status
  hdhhdvu?:  GdtHdhhdvuItem[];  // line items array
  [key: string]: unknown;
}

/**
 * Raw invoice record as returned by the GDT JSON API.
 * Field names follow Vietnamese abbreviations used by the GDT portal.
 * Not all fields are guaranteed — use optional access everywhere.
 *
 * Common field name conventions:
 *   shdon    = số hóa đơn
 *   khhdon   = ký hiệu hóa đơn (serial prefix like "C26TFA")
 *   tdlap    = thời điểm lập (invoice date, ISO string)
 *   tthdon   = trạng thái hóa đơn (1=valid 3=cancelled 5=replaced 6=adjusted)
 *   tgtcthue = tổng giá trị chưa thuế (subtotal)
 *   tgtthue  = tổng tiền thuế (VAT amount)
 *   tgtttbso = tổng giá trị thanh toán bằng số (total amount)
 *   tsuat    = thuế suất (VAT rate %)
 *   msttcgpbh / mst_ban = MST người bán
 *   tenbh / ten_ban     = tên người bán
 *   mnmst / mst_mua     = MST người mua
 *   tenn  / ten_mua     = tên người mua
 */
interface GdtInvoiceRaw {
  [key: string]: unknown;
  // Known fields (may vary by portal version):
  shdon?:      string | number;
  khhdon?:     string;
  khmshdon?:   string;
  tdlap?:      string;
  tthdon?:     number;
  tgtcthue?:   number;
  tgtthue?:    number;
  tgtttbso?:   number;
  tsuat?:      string | number;
  msttcgpbh?:  string;  // MST người bán (nhiều định dạng)
  mst_ban?:    string;
  msttcgp_ban?: string;
  tenbh?:      string;  // tên người bán
  ten_ban?:    string;
  mnmst?:      string;  // MST người mua
  mst_mua?:    string;
  tenn?:       string;  // tên người mua
  ten_mua?:    string;
}

interface GdtPagedResponse {
  datas?: GdtInvoiceRaw[];
  data?:  GdtInvoiceRaw[];
  total?: number;
}

// Status code → our status string
const STATUS_MAP: Record<number, RawInvoice['status']> = {
  1: 'valid',
  3: 'cancelled',
  5: 'replaced',
  6: 'adjusted',
};

/**
 * ttxly values whose invoices have a signed XML on GDT server.
 * Only ttxly==5 ("Đã cấp mã") has an actual XML file.
 * ttxly==6 (không mã) and ttxly==8 (ủy nhiệm) return HTTP 500 on export-xml.
 */
const XML_AVAILABLE_TTXLY = new Set([5]);

// ── Helper utilities ───────────────────────────────────────────────────────────

/** Format Date → DD/MM/YYYYTHH:MM:SS  (GDT FIQL date format) */
function formatGdtDate(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const HH   = String(d.getHours()).padStart(2, '0');
  const MM   = String(d.getMinutes()).padStart(2, '0');
  const SS   = String(d.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}T${HH}:${MM}:${SS}`;
}

/** Parse ISO-ish invoice date from GDT → YYYY-MM-DD */
function parseInvoiceDate(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw);
  // ISO timestamp with time component — GDT API returns UTC strings (e.g. "2026-04-03T17:00:00Z")
  // which is Vietnam midnight (UTC+7 = 2026-04-04 00:00). Must convert to VN timezone before
  // extracting date, otherwise invoices appear 1 day early.
  if (s.includes('T')) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const vnMs = d.getTime() + 7 * 3_600_000; // UTC+7
      const vn = new Date(vnMs);
      const yyyy = vn.getUTCFullYear();
      const mm   = String(vn.getUTCMonth() + 1).padStart(2, '0');
      const dd   = String(vn.getUTCDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  // YYYY-MM-DD date string (already a calendar date, no timezone conversion needed)
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // VN format: 01/03/2026
  const vn = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (vn) return `${vn[3]}-${vn[2]}-${vn[1]}`;
  return null;
}

/** Normalise VAT rate → numeric string or null */
function parseVatRate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace('%', '').trim().toLowerCase();
  if (s === '') return null;
  // KCT (không chịu thuế) / KKKTT (không kê khai không tính thuế) = 0% VAT-exempt.
  // Must return '0' (not null) so they appear in ct30 (exempt revenue) rather than
  // silently inflating ct40_total_output_revenue with an untracked NaN bucket.
  if (s === 'kct' || s === 'kkktt') return '0';
  const n = parseFloat(s);
  return isNaN(n) ? null : String(n);
}

/**
 * Derive tax_category from raw VAT rate string.
 * Keeps the semantic distinction that parseVatRate() loses by normalising to '0'.
 * Returns:
 *   'KCT'   — không chịu thuế GTGT → chỉ tiêu [26]
 *   'KKKNT' — không phải kê khai, tính nộp GTGT → chỉ tiêu [32a]
 *   '0'     — thuế suất 0% (xuất khẩu) → chỉ tiêu [29]
 *   '5'|'8'|'10' — thuế suất thông thường
 *   null    — không xác định
 */
function extractTaxCategory(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace('%', '').trim().toLowerCase();
  if (s === '') return null;
  if (s === 'kct') return 'KCT';
  if (s === 'kkknt' || s === 'kkktt') return 'KKKNT';
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  if (n === 0) return '0';
  if (n === 5) return '5';
  if (n === 8) return '8';
  if (n === 10) return '10';
  return String(n);
}

/** Coerce to number or null */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** Get first non-null value from a list of keys on an object */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '') return v;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Split a date range into calendar-month windows.
 * GDT API rejects ranges > 1 calendar month.
 * e.g. [Feb 10, Apr 5] → [{Feb 10, Feb 28}, {Mar 1, Mar 31}, {Apr 1, Apr 5}]
 */
function splitIntoMonths(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cur = new Date(from);
  while (cur <= to) {
    // End of cur's calendar month
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0, 23, 59, 59, 999);
    const chunkEnd = monthEnd < to ? monthEnd : to;
    chunks.push({ from: new Date(cur), to: chunkEnd });
    // Start of next month
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1, 0, 0, 0, 0);
  }
  return chunks;
}

/**
 * FIX-6: Split a date range into ISO-week windows (Mon–Sun).
 * Used when estimated invoice count > 5 000 to keep each fetch run manageable.
 * e.g. [Mar 3, Mar 31] → [{Mar 3–Mar 9}, {Mar 10–Mar 16}, ..., {Mar 31–Mar 31}]
 */
function splitIntoWeeks(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cur = new Date(from);
  while (cur <= to) {
    // End of the ISO week (Sunday 23:59:59)
    const dow     = cur.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const toSun   = dow === 0 ? 0 : 7 - dow; // days until Sunday
    const weekEnd = new Date(cur);
    weekEnd.setDate(weekEnd.getDate() + toSun);
    weekEnd.setHours(23, 59, 59, 999);
    const chunkEnd = weekEnd < to ? weekEnd : to;
    chunks.push({ from: new Date(cur), to: chunkEnd });
    const next = new Date(chunkEnd);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    cur = next;
  }
  return chunks;
}

// ── Map GDT JSON row → RawInvoice ─────────────────────────────────────────────

interface MapInvoiceOpts {
  ttxlyFilter?:     string;
  isSco?:           boolean;  // true when fetched via /sco-query (MTTTT)
  fields?:          RecipeFields;
  statusMap?:       Record<string, string>;
  xmlAvailableTtxly?: Set<number>;
}

function mapInvoice(
  row:       GdtInvoiceRaw,
  direction: 'output' | 'input',
  opts:      MapInvoiceOpts = {},
): RawInvoice {
  const { ttxlyFilter, isSco, fields, statusMap: recipeStatusMap, xmlAvailableTtxly: recipeXmlSet } = opts;
  const r = row as Record<string, unknown>;

  // tthai = trạng thái hóa đơn (1=valid, 3=cancelled, 5=replaced, 6=adjusted)
  // ttxly = trạng thái xử lý by GDT (5=accepted) — NOT the invoice status
  const statusCode = num(pick(r, ...(fields?.status ?? ['tthai', 'ttxly', 'tthdon', 'trangThai', 'status']))) ?? 1;
  const status: RawInvoice['status'] =
    (recipeStatusMap?.[String(statusCode)] as RawInvoice['status'] | undefined)
    ?? STATUS_MAP[statusCode]
    ?? 'valid';

  // Seller: nb = người bán
  const sellerTax = String(pick(r,
    ...(fields?.sellerTax ?? ['nbmst', 'msttcgpbh', 'mst_ban', 'msttcgp_ban', 'mstNguoiBan']),
  ) ?? '').trim() || null;

  const sellerName = String(pick(r,
    ...(fields?.sellerName ?? ['nbten', 'tenbh', 'ten_ban', 'tenNguoiBan', 'nguoiBanHang']),
  ) ?? '').trim() || null;

  // Buyer: mn/nm = người mua
  const buyerTax = String(pick(r,
    ...(fields?.buyerTax ?? ['nmmst', 'mnmst', 'mst_mua', 'mstnmua', 'mstNguoiMua']),
  ) ?? '').trim() || null;

  const buyerName = String(pick(r,
    ...(fields?.buyerName ?? ['nmten', 'tenn', 'ten_mua', 'tenNguoiMua', 'nguoiMuaHang']),
  ) ?? '').trim() || null;

  const invoiceNum = String(pick(r, ...(fields?.invoiceNum ?? ['shdon', 'soHoaDon', 'so_hd', 'ma_hd'])) ?? '').trim() || null;
  const serial     = String(pick(r, ...(fields?.serial    ?? ['khhdon', 'kyHieuHoaDon', 'ky_hieu_hd'])) ?? '').trim() || null;
  const dateRaw    = pick(r, ...(fields?.date             ?? ['tdlap', 'ngayLap', 'ngay_lap']));

  const subtotal   = num(pick(r, ...(fields?.subtotal  ?? ['tgtcthue', 'tien_chua_thue', 'tienHangChuaThue'])));
  const vatAmount  = num(pick(r, ...(fields?.vatAmount  ?? ['tgtthue', 'tien_thue', 'tienThue'])));
  const total      = num(pick(r, ...(fields?.total      ?? ['tgtttbso', 'thanh_toan', 'tongThanhToan', 'tongTien']))) ??
                     (subtotal != null && vatAmount != null ? subtotal + vatAmount : null);

  // VAT rate is nested in thttltsuat[0].tsuat (path configurable via recipe)
  const vatNestedPath = fields?.vatRateNestedPath ?? 'thttltsuat';
  let vatRate: string | null = null;
  let taxCategory: string | null = null;
  const nestedArr = r[vatNestedPath];
  if (Array.isArray(nestedArr) && nestedArr.length > 0) {
    const rawTsuat = (nestedArr[0] as Record<string, unknown>)['tsuat'];
    vatRate     = parseVatRate(rawTsuat);
    taxCategory = extractTaxCategory(rawTsuat);
  }
  // fallback to top-level tsuat
  if (!vatRate) {
    const rawFallback = pick(r, ...(fields?.vatRate ?? ['tsuat', 'thueSuat', 'thue_suat']));
    vatRate     = parseVatRate(rawFallback);
    taxCategory = extractTaxCategory(rawFallback);
  }

  const xmlSet = recipeXmlSet ?? XML_AVAILABLE_TTXLY;

  // Read ttxly directly from the row to determine xml_available.
  // This is accurate for unfiltered sco-query calls (where ttxlyFilter is absent)
  // and also correct for filtered calls. Falls back to filter string parsing if
  // the row doesn't have a ttxly field (legacy / recipe-overridden endpoints).
  const rowTtxly = typeof r['ttxly'] === 'number' ? r['ttxly'] as number : null;
  const xmlAvailable = direction === 'output'
    ? true
    : rowTtxly != null
      ? xmlSet.has(rowTtxly)
      : xmlSet.has(parseInt((ttxlyFilter ?? '').replace('ttxly==', ''), 10));

  return {
    invoice_number:  invoiceNum,
    serial_number:   serial,
    invoice_date:    parseInvoiceDate(dateRaw),
    direction,
    status,
    seller_name:     sellerName,
    seller_tax_code: sellerTax,
    buyer_name:      buyerName,
    buyer_tax_code:  buyerTax,
    total_amount:    total,
    vat_amount:      vatAmount,
    vat_rate:        vatRate,
    invoice_type:    String(pick(r, ...(fields?.invoiceType ?? ['thdon', 'loaiHD', 'loai_hd', 'la'])) ?? '').trim() || null,
    source:          'gdt_bot',
    gdt_validated:   true,
    xml_available:   xmlAvailable,
    is_sco:          isSco ?? false,
    // Hóa đơn thay thế / điều chỉnh: shdgoc = số HĐ gốc, khhdgoc = ký hiệu HĐ gốc
    // Nếu shdgoc có giá trị → đây là HĐ thay thế (tc_hdon=1) hoặc điều chỉnh (tc_hdon=2)
    tc_hdon:      (() => {
                    const goc  = String(pick(r, 'shdgoc',   'shdon_goc',   'soHdonGoc',   'sHdonGoc')   ?? '').trim() || null;
                    const tcRaw = num(pick(r, 'tcHDon', 'tcHdon', 'tCHDon', 'loaiHDon'));
                    if (tcRaw != null && tcRaw > 0) return tcRaw;
                    return goc ? 1 : 0;
                  })(),
    khhd_cl_quan: String(pick(r, 'khhdgoc', 'khhdon_goc', 'kyHieuGoc', 'KHHDCLQuan') ?? '').trim() || null,
    so_hd_cl_quan: String(pick(r, 'shdgoc',  'shdon_goc',  'soHdonGoc', 'SHDCLQuan')  ?? '').trim() || null,
    tax_category: taxCategory,
  };
}

// ── Main Service ───────────────────────────────────────────────────────────────

export class GdtDirectApiService {
  private token:          string | null = null;
  private captchaService: CaptchaService;
  // FIX-1: Store credentials for mid-run token refresh
  private _loginUsername: string | null = null;
  private _loginPassword: string | null = null;
  private _reloginAttempted = false;
  // FIX-2: Pagination checkpoint (resume after crash)
  private _companyId:    string | null = null;
  private _checkpoint:   SyncCheckpoint | null = null;
  // Phase 4: UA rotation — never use the same UA twice in a row per company
  private static _lastUaMap = new Map<string, string>();
  private _lastUa:       string | null = null;

  /** FIX-PERF-01: Allow session cache to restore a previously-issued JWT. */
  setToken(token: string): void { this.token = token; }
  getToken(): string | null     { return this.token; }
  private http:           AxiosInstance;
  /**
   * Binary downloads client (XML ZIP / XLSX).
   * When socks5ProxyUrl is provided: uses SOCKS5 tunnel agent.
   * SOCKS5 = transparent TCP relay — no content inspection, no port filtering,
   * no binary blocking. Works for port 30000 unlike HTTP CONNECT proxies.
   * Falls back to this.http (HTTP CONNECT) when socks5ProxyUrl is null.
   */
  private binaryHttp:     AxiosInstance | null = null;
  private recipe:         CrawlerRecipe | null = null;
  // VĐ1: Proxy swap on network-level failures
  private _currentProxyUrl:      string | null = null;
  private _proxyManager:         ProxyManager | null = null;
  private _proxySessionSuffix:   string | null = null;
  // VĐ2: Cached headers for hot-swap axios recreate
  private _commonHeaders:        Record<string, string> = {};

  constructor(
    proxyUrl?:     string | null,
    socks5ProxyUrl?: string | null,
    recipe?:       CrawlerRecipe,
    companyId?:    string | null,
    checkpoint?:   SyncCheckpoint | null,
  ) {
    this.recipe       = recipe ?? null;
    this._companyId   = companyId ?? null;
    this._checkpoint  = checkpoint ?? null;
    this.captchaService = new CaptchaService();
    const httpAgent = proxyUrl ? createTunnelAgent({ proxyUrl }) : undefined;
    // Phase 4: Pick a UA that differs from the previous one for this company.
    // Prevents GDT from fingerprinting the same UA repeated every 6 hours.
    const companyKey = companyId ?? '_';
    const lastUa = GdtDirectApiService._lastUaMap.get(companyKey) ?? null;
    const ua = randomUserAgentExcluding(lastUa);
    GdtDirectApiService._lastUaMap.set(companyKey, ua);
    this._lastUa = ua;
    const commonHeaders = {
      'Accept':                    'application/json, text/plain, */*',
      'Accept-Language':           'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding':           'gzip, deflate, br',
      'Cache-Control':             'no-cache',
      'Pragma':                    'no-cache',
      'User-Agent':                ua,
      'Origin':                    'https://hoadondientu.gdt.gov.vn',
      'Referer':                   'https://hoadondientu.gdt.gov.vn/',
      'sec-ch-ua':                 '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile':          '?0',
      'sec-ch-ua-platform':        '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-full-version-list': '"Chromium";v="122.0.6261.94", "Not(A:Brand";v="24.0.0.0", "Google Chrome";v="122.0.6261.94"',
      'sec-fetch-site':            'same-origin',
      'sec-fetch-mode':            'cors',
      'sec-fetch-dest':            'empty',
    };
    this._commonHeaders = commonHeaders;
    this._currentProxyUrl = proxyUrl ?? null;
    this.http = axios.create({
      // With proxy: use http:// so axios uses http.request + our httpAgent
      // (our httpAgent.createConnection does tunnel+TLS, so HTTP goes over TLS).
      // Without proxy: use https:// for a normal direct TLS connection.
      baseURL: httpAgent
        ? (this.recipe?.api.baseUrlHttp ?? GDT_API_HTTP)
        : (this.recipe?.api.baseUrl    ?? GDT_API_HTTPS),
      timeout: REQUEST_TIMEOUT,
      headers: commonHeaders,
      paramsSerializer: serializeParams,  // BUG-1: raw FIQL values, encoded keys only
      ...(httpAgent ? { httpAgent } : {}),
    });
    this._addTimeoutInterceptor(this.http);
    // SOCKS5 client for binary downloads (XML ZIP / XLSX).
    // Pure TCP relay → no content filtering by proxy → binary always works.
    // When socks5ProxyUrl is null: binaryHttp stays null → _getBinaryWithRetry uses this.http.
    if (socks5ProxyUrl) {
      const socks5Agent = createSocks5TunnelAgent({ proxyUrl: socks5ProxyUrl });
      this.binaryHttp = axios.create({
        baseURL:          this.recipe?.api.baseUrlHttp ?? GDT_API_HTTP,   // http:// so axios uses httpAgent (our SOCKS5 tunnel does TLS)
        timeout:          BINARY_TIMEOUT,
        headers:          commonHeaders,
        paramsSerializer: serializeParams,  // BUG-1: raw FIQL values, encoded keys only
        httpAgent:        socks5Agent,
      });
    }
  }

  /** Returns the recipe currently active in this service instance (or null if using built-in defaults). */
  get activeRecipe(): CrawlerRecipe | null {
    return this.recipe;
  }

  /**
   * VĐ1: Wire up ProxyManager for mid-request proxy swap on TCP drops.
   * Call immediately after construction in sync.worker before any fetches.
   */
  setProxyManager(pm: ProxyManager, sessionSuffix: string): void {
    this._proxyManager      = pm;
    this._proxySessionSuffix = sessionSuffix;
  }

  /** VĐ2: Attach per-endpoint timeout override interceptor to an axios instance. */
  private _addTimeoutInterceptor(instance: AxiosInstance): void {
    instance.interceptors.request.use(config => {
      const url = config.url ?? '';
      const m = getPeakTimeoutMultiplier();
      for (const [path, baseMs] of Object.entries(BASE_ENDPOINT_TIMEOUTS)) {
        if (url.includes(path)) {
          config.timeout = Math.round(baseMs * m);
          break;
        }
      }
      // Apply peak multiplier to default timeout too (for unmatched endpoints)
      if (m > 1 && config.timeout === REQUEST_TIMEOUT) {
        config.timeout = Math.round(REQUEST_TIMEOUT * m);
      }
      return config;
    });
  }

  /**
   * VĐ1: Recreate this.http with a new proxy URL after a TCP drop.
   * Reuses stored _commonHeaders so session fingerprint stays consistent.
   */
  private _recreateHttpClient(newProxyUrl: string): void {
    const httpAgent = createTunnelAgent({ proxyUrl: newProxyUrl });
    this._currentProxyUrl = newProxyUrl;
    this.http = axios.create({
      baseURL:          this.recipe?.api.baseUrlHttp ?? GDT_API_HTTP,
      timeout:          REQUEST_TIMEOUT,
      headers:          this._commonHeaders,
      paramsSerializer: serializeParams,
      httpAgent,
    });
    this._addTimeoutInterceptor(this.http);
    logger.info('[GdtDirect] Proxy swapped — new axios instance created', {
      newProxy: newProxyUrl.replace(/:([^@:]+)@/, ':****@').slice(0, 50),
    });
  }

  // ── Phase 3: Pre-flight count ──────────────────────────────────────────────

  /**
   * FIX-6 / Phase 3: Fetch only the first page (page=0, size=1) and read X-Total-Count
   * to estimate how many invoices exist without downloading them all.
   * Returns -1 on any error (caller should proceed without warning).
   */
  async prefetchCount(
    endpoint:      'sold' | 'purchase',
    fromDate:      Date,
    toDate:        Date,
    extraFilter?:  string,
    overridePath?: string,
  ): Promise<number> {
    if (!this.token) return -1;
    try {
      const endpointPath = overridePath
        ?? (endpoint === 'sold'
          ? (this.recipe?.api.endpoints.sold     ?? '/query/invoices/sold')
          : (this.recipe?.api.endpoints.purchase ?? '/query/invoices/purchase'));
      const from   = formatGdtDate(fromDate);
      const to     = formatGdtDate(toDate);
      const search = extraFilter
        ? `tdlap=ge=${from};tdlap=le=${to};${extraFilter}`
        : `tdlap=ge=${from};tdlap=le=${to}`;

      const res = await this.http.get(endpointPath, {
        params: { sort: 'tdlap:desc', size: 1, page: 0, search },
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const headerTotal = parseInt((res.headers as Record<string, string>)['x-total-count'] ?? '', 10);
      if (!isNaN(headerTotal)) return headerTotal;
      const bodyTotal = (res.data as { total?: number }).total;
      return typeof bodyTotal === 'number' ? bodyTotal : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Phase 3: Estimate total sync duration in milliseconds.
   * Used to warn users before starting a very long sync.
   *
   * Model (conservative):
   *   pages  = ceil(total / 50)
   *   fetch  = pages × 2s avg page delay
   *   upsert = total × 20ms avg DB write (batch of 50 ≈ 1s round-trip)
   *   xml    = min(total, MAX_XML_FETCHES) × 3.5s avg detail call
   */
  static estimateSyncDurationMs(outputCount: number, inputCount: number): number {
    const total     = Math.max(0, outputCount) + Math.max(0, inputCount);
    const pageSize  = 50;
    const pages     = Math.ceil(total / pageSize);
    const fetchMs   = pages * 2_000;
    const upsertMs  = total * 20;
    const xmlCount  = Math.min(total, 50); // MAX_XML_FETCHES_PER_RUN
    const xmlMs     = xmlCount * 3_500;
    return fetchMs + upsertMs + xmlMs;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /**
   * Login to GDT portal and store JWT token.
   * Retries up to MAX_RETRIES times on wrong captcha.
   * Phase 4: Pass isManual=true for user-triggered syncs to use shorter warmup delay.
   */
  async login(username: string, password: string, isManual = false): Promise<void> {
    // FIX-1: Cache credentials at start so _getWithRetry can re-login on 401
    this._loginUsername     = username;
    this._loginPassword     = password;
    this._reloginAttempted  = false;
    let attempts = 0;
    let lastCaptchaId: string | null = null;
    const maxRetries   = this.recipe?.timing.maxRetries    ?? getPeakMaxRetries();
    const retryDelayMs = this.recipe?.timing.retryDelayMs  ?? getPeakRetryDelay();
    const captchaPath  = this.recipe?.api.endpoints.captcha ?? '/captcha';
    const authPath     = this.recipe?.api.endpoints.auth    ?? '/security-taxpayer/authenticate';

    while (attempts < maxRetries) {
      // Step 1: Get fresh captcha
      const captchaRes = await this.http.get<CaptchaResponse>(captchaPath);
      // Guard: log raw response if structure is unexpected (helps diagnose GDT API changes)
      const rawData = captchaRes.data as unknown as Record<string, unknown>;
      if (!rawData?.['content'] || typeof rawData['content'] !== 'string') {
        logger.error('[GdtDirect] Unexpected captcha response — missing content field', {
          status: captchaRes.status,
          keys:   Object.keys(rawData ?? {}),
          sample: JSON.stringify(rawData).slice(0, 300),
        });
        throw new Error(`GDT captcha API returned unexpected structure (missing 'content'). Keys: ${Object.keys(rawData ?? {}).join(', ')}`);
      }
      const { key: ckey, content: svgContent } = captchaRes.data;

      // Step 2: SVG → PNG → base64 → 2captcha
      // Phase 4: Run human warmup delay IN PARALLEL with captcha solve so the
      // anti-detection delay never adds on top of the 2Captcha round-trip.
      let cvalue: string;
      try {
        const captchaStart = Date.now();
        const { default: sharp } = await import('sharp');
        const pngBuffer = await sharp(Buffer.from(svgContent)).png().toBuffer();
        const base64    = pngBuffer.toString('base64');
        // Warmup delay (human-like pause) runs concurrently with captcha API call.
        const [result] = await Promise.all([
          this.captchaService.solve(base64),
          humanDelay(isManual ? 500 : 3_000, isManual ? 2_000 : 8_000),
        ]);
        const captchaElapsedMs = Date.now() - captchaStart;
        cvalue        = result.text.trim().toUpperCase();
        lastCaptchaId = result.captchaId;
        logger.info('[GdtDirect] Captcha giải xong', { captchaId: lastCaptchaId, cvalue, captchaElapsedMs });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn('[GdtDirect] Lỗi captcha', { attempts, errMsg });
        attempts++;
        await sleep(retryDelayMs);
        continue;
      }

      // Step 3: Authenticate
      try {
        const authRes = await this.http.post<AuthResponse>(
          authPath,
          { username, password, cvalue, ckey },
          // BUG-2: Force fresh TCP socket after login.
          // Prevents 'stream has been aborted' from reusing a server-half-closed socket
          // on the first API call immediately after authentication.
          { headers: { 'Connection': 'close' } },
        );
        this.token = authRes.data.token;
        logger.info('[GdtDirect] Login success', { username });
        return;
      } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          // GDT body can be JSON { message: '...' } or plain text string
          const rawBody = err.response?.data;
          const msg = typeof rawBody === 'string'
            ? rawBody
            : String((rawBody as Record<string, unknown>)?.message
                ?? (rawBody as Record<string, unknown>)?.error
                ?? '');
          const msgLc = msg.toLowerCase();

          // GDT returns HTTP 400 OR 401 for wrong captcha (inconsistent between versions).
          // Detect by message content first — never treat captcha failures as credential errors.
          const isCaptchaError =
            msgLc.includes('captcha') ||
            msgLc.includes('mã xác nhận') ||
            msgLc.includes('mã captcha');

          if ((status === 400 || status === 401) && isCaptchaError) {
            if (lastCaptchaId) await this.captchaService.reportBad(lastCaptchaId);
            logger.warn('[GdtDirect] Wrong captcha, retrying', { attempts, cvalue, msg });
            attempts++;
            lastCaptchaId = null;
            await sleep(retryDelayMs);
            continue;
          }

          // Wrong credentials → throw immediately (UnrecoverableError at caller)
          if (status === 400 || status === 401) {
            throw new Error(`GDT auth failed: ${msg || `HTTP ${status}`}`);
          }
        }
        throw err;
      }
    }

    throw new Error(`GDT login failed after ${maxRetries} captcha attempts`);
  }

  // ── Invoice fetching ───────────────────────────────────────────────────────

  /**
   * Fetch all output invoices (hóa đơn bán ra) for the given period.
   *
   * GDT portal has two tabs:
   *   /query/invoices/sold     — HĐ điện tử (standard e-invoices)
   *   /sco-query/invoices/sold — HĐ có mã khởi tạo từ máy tính tiền (MTTTT / POS-coded)
   * Both are merged and deduplicated.
   */
  async fetchOutputInvoices(fromDate: Date, toDate: Date): Promise<RawInvoice[]> {
    const scoPath = this.recipe?.api.endpoints.scoSold ?? GDT_SCO_SOLD;
    const queryResult = await this._fetchRangeByMonth('sold', fromDate, toDate);
    await humanDelay(1_500, 3_000);
    // SCO sold — always use weekly chunks to avoid the 50-item page limit bug on /sco-query.
    const scoResult = await this._fetchScoByWeeks('sold', fromDate, toDate, scoPath);

    // Dedup by invoice_number + serial_number + invoice_date
    const seen   = new Set<string>();
    const merged: RawInvoice[] = [];
    for (const inv of [...queryResult, ...scoResult]) {
      const key = `${inv.invoice_number ?? ''}|${inv.serial_number ?? ''}|${inv.invoice_date ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(inv);
      }
    }
    logger.info('[GdtDirect] Output invoices merged', {
      query: queryResult.length,
      sco:   scoResult.length,
      merged: merged.length,
    });
    return merged;
  }

  /**
   * Fetch all input invoices (hóa đơn mua vào) for the given period.
   *
   * GDT portal has two invoice source tabs, each with a "Kết quả kiểm tra" dropdown:
   *
   *   /query/invoices/purchase   — HĐ điện tử:
   *     ttxly==5  →  "Đã cấp mã hóa đơn"           (has signed XML)
   *     ttxly==6  →  "Cục Thuế đã nhận không mã"    (no XML)
   *
   *   /sco-query/invoices/purchase — HĐ có mã khởi tạo từ máy tính tiền (MTTTT):
   *     ttxly==5  →  "Cục Thuế đã nhận HĐ có mã MTTTT" (has signed XML)
   *     ttxly==6  →  "Cục Thuế đã nhận HĐ MTTTT không mã" (no XML)
   *     ttxly==8  →  "Cục Thuế đã nhận HĐ MTTTT ủy nhiệm" (no XML)
   *
   * NOTE: /sco-query/invoices/purchase does NOT support ttxly==8 as a FIQL filter
   * (GDT returns HTTP 500). We therefore fetch all SCO purchases in ONE request
   * without any ttxly filter — the row-level ttxly field determines xml_available
   * for each invoice individually (handled in mapInvoice).
   */
  async fetchInputInvoices(fromDate: Date, toDate: Date): Promise<RawInvoice[]> {
    const scoPurchasePath = this.recipe?.api.endpoints.scoPurchase ?? GDT_SCO_PURCHASE;

    // HĐ điện tử via /query (separate calls needed because /query requires ttxly filter)
    const q5 = await this._fetchRangeByMonth('purchase', fromDate, toDate, 'ttxly==5');
    await humanDelay(1_500, 3_000);
    const q6 = await this._fetchRangeByMonth('purchase', fromDate, toDate, 'ttxly==6');
    await humanDelay(1_500, 3_000);

    // HĐ MTTTT via /sco-query — weekly chunks with NO ttxly filter.
    // The SCO endpoint returns all types (5/6/8) in one paginated response.
    // xml_available is derived from each row's ttxly value in mapInvoice.
    // Weekly chunking prevents the X-Total-Count = pageSize bug from truncating results.
    const scoAll = await this._fetchScoByWeeks('purchase', fromDate, toDate, scoPurchasePath);

    // Merge & deduplicate across all three streams.
    // Dedup key: invoice_number + seller_tax_code + invoice_date
    const seen   = new Set<string>();
    const merged: RawInvoice[] = [];
    for (const inv of [...q5, ...q6, ...scoAll]) {
      const key = `${inv.invoice_number ?? ''}|${inv.seller_tax_code ?? ''}|${inv.invoice_date ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(inv);
      }
    }
    logger.info('[GdtDirect] Purchase invoices merged', {
      ttxly5_query: q5.length,
      ttxly6_query: q6.length,
      sco_all: scoAll.length,
      merged: merged.length,
    });
    return merged;
  }

  /**
   * Fetch SCO invoices by splitting the date range into WEEKLY chunks.
   *
   * Root cause of the SCO 50-item limit (GDT bug):
   *   /sco-query endpoints return X-Total-Count equal to the page size (50) instead of
   *   the true total, OR return HTTP 500 on page > 0 for companies with > 50 MTT invoices
   *   per month. Both cases cause _fetchAllPagesBuffered / _streamPages to stop after
   *   exactly one page — silently truncating results.
   *
   * Fix: split the range into 7-day windows. Each chunk has ~10-25 invoices (far below
   * page size = 50), so only one page is ever needed per chunk — the GDT limit is never hit.
   * Errors per chunk are caught non-fatally so one bad week doesn't abort the full sync.
   */
  private async _fetchScoByWeeks(
    endpoint:     'sold' | 'purchase',
    fromDate:     Date,
    toDate:       Date,
    scoPath:      string,
  ): Promise<RawInvoice[]> {
    const chunks = splitIntoWeeks(fromDate, toDate);
    logger.info('[GdtDirect] SCO weekly fetch', {
      endpoint, totalChunks: chunks.length,
      from: formatGdtDate(fromDate), to: formatGdtDate(toDate),
    });
    const all: RawInvoice[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await humanDelay(2_000, 5_000);
      const { from, to } = chunks[i]!;
      try {
        const chunk = await this._fetchAllPagesBuffered(endpoint, from, to, undefined, scoPath);
        all.push(...chunk);
        logger.debug('[GdtDirect] SCO weekly chunk done', {
          chunk: i + 1, total: chunks.length,
          from: formatGdtDate(from), to: formatGdtDate(to), count: chunk.length,
        });
      } catch (err) {
        logger.warn('[GdtDirect] SCO weekly chunk failed (non-fatal)', {
          chunk: i + 1, total: chunks.length,
          from: formatGdtDate(from), to: formatGdtDate(to),
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return all;
  }

  /**
   * Split [fromDate, toDate] into calendar-month windows (GDT max = 1 month)
   * and concatenate results.
   * FIX-6: Auto-switches to weekly chunks when estimated invoice count > 5 000
   *        to keep each run bounded in time.
   * @param extraFilter  Optional FIQL filter appended to the search string (e.g. 'ttxly==5').
   * @param overridePath Optional API path override (e.g. GDT_SCO_SOLD for MTTTT endpoints).
   */
  private async _fetchRangeByMonth(
    endpoint:     'sold' | 'purchase',
    fromDate:     Date,
    toDate:       Date,
    extraFilter?: string,
    overridePath?: string,
  ): Promise<RawInvoice[]> {
    // FIX-6: Pre-check count and choose chunk strategy
    const LARGE_VOLUME_THRESHOLD = 5_000;
    let chunks: Array<{ from: Date; to: Date }>;
    try {
      const estimated = await this.prefetchCount(
        endpoint === 'sold' ? 'sold' : 'purchase',
        fromDate, toDate, extraFilter, overridePath,
      );
      if (estimated > LARGE_VOLUME_THRESHOLD) {
        logger.info('[GdtDirect] Khối lượng lớn — dùng chunk theo tuần', {
          endpoint, estimated, threshold: LARGE_VOLUME_THRESHOLD,
        });
        chunks = splitIntoWeeks(fromDate, toDate);
      } else {
        chunks = splitIntoMonths(fromDate, toDate);
      }
    } catch {
      chunks = splitIntoMonths(fromDate, toDate);
    }

    const all: RawInvoice[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const { from, to } = chunks[i]!;
      // Human-like delay BEFORE each chunk (except the first).
      // Mimics an accountant pausing between page navigations (4–8s).
      // Without this, consecutive month requests arrive < 1s apart — GDT detects bot pattern
      // and responds with 429 after ~20 rapid requests.
      if (i > 0) await humanDelay(4_000, 8_000);
      const chunk = await this._fetchAllPagesBuffered(endpoint, from, to, extraFilter, overridePath);
      all.push(...chunk);
    }
    return all;
  }

  // ── Export XML (per invoice) ───────────────────────────────────────────────

  /**
   * Download the original signed XML for a single invoice (output or input).
   *
   * Params (from DevTools):
   *   nbmst    — MST người bán (seller tax code)
   *   khhdon   — ký hiệu hóa đơn  (serial, e.g. "C26TAS")
   *   shdon    — số hóa đơn       (invoice number)
   *   khmshdon — ký hiệu mẫu số   (always 1 in observed traffic)
   *
   * Returns the raw XML bytes.
   */
  async exportInvoiceXml(params: {
    nbmst:    string;
    khhdon:   string;
    shdon:    string | number;
    khmshdon?: string | number;
  }): Promise<Buffer> {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    const { nbmst, khhdon, shdon, khmshdon = 1 } = params;
    logger.debug('[GdtDirect] exportInvoiceXml', { nbmst, khhdon, shdon });
    return this._getBinaryWithRetry(this.recipe?.api.endpoints.exportXml ?? '/query/invoices/export-xml', {
      nbmst, khhdon, shdon, khmshdon,
    });
  }

  // ── Invoice detail (JSON — preferred over XML for line items) ─────────────────

  /**
   * Fetch invoice detail JSON from GDT.
   * Endpoint: GET /query/invoices/detail?nbmst=...&khhdon=...&shdon=...&khmshdon=...
   *
   * This is the PREFERRED way to obtain line items.
   * The XML ZIP approach (~400KB, chunked, binary) is unreliable over residential
   * 4G proxies (TMProxy cuts TCP after ~4-5s). This endpoint returns a tiny ~6KB
   * JSON response that goes through the normal HTTP CONNECT proxy reliably.
   *
   * The response field `hdhhdvu` contains the line items array.
   * Field mapping:
   *   stt       → line_number
   *   ten       → item_name
   *   sluong    → quantity
   *   dgia      → unit_price
   *   dvtinh    → unit
   *   tsuat     → vat_rate (decimal, e.g. 0.08)
   *   thtien    → subtotal (before VAT)
   *   tthue     → vat_amount (may be null — computed from tsuat*thtien if so)
   *   stckhau   → discount amount
   *   ttkhac entry "Tiền thuế dòng (Tiền thuế GTGT)" → vat_amount (more reliable)
   *   ttkhac entry "Thành tiền thanh toán của hàng hóa" → total (with VAT)
   */
  async fetchInvoiceDetail(params: {
    nbmst:    string;
    khhdon:   string;
    shdon:    string | number;
    khmshdon?: string | number;
    isSco?:   boolean;  // true = use /sco-query/invoices/detail (MTTTT invoices)
  }): Promise<GdtInvoiceDetail> {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    const { nbmst, khhdon, shdon, khmshdon = 1, isSco = false } = params;
    const url = isSco
      ? (this.recipe?.api.endpoints.scoDetail ?? GDT_SCO_DETAIL)
      : (this.recipe?.api.endpoints.detail    ?? '/query/invoices/detail');
    logger.debug('[GdtDirect] fetchInvoiceDetail', { nbmst, khhdon, shdon, isSco });
    const res = await this.http.get<GdtInvoiceDetail>(url, {
      params: { nbmst, khhdon, shdon, khmshdon },
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data;
  }

  /**
   * Parse line items from a GDT invoice detail response.
   * Returns array compatible with the LineItem interface used by the XML parser.
   */
  static parseLineItemsFromDetail(detail: GdtInvoiceDetail): import('./parsers/GdtXmlParser').LineItem[] {
    if (!Array.isArray(detail.hdhhdvu) || detail.hdhhdvu.length === 0) return [];

    return detail.hdhhdvu.map((item): import('./parsers/GdtXmlParser').LineItem => {
      // Extract vat_amount and total from ttkhac supplementary fields
      let vatAmountFromExtra: number | null = null;
      let totalFromExtra: number | null = null;
      if (Array.isArray(item.ttkhac)) {
        for (const extra of item.ttkhac) {
          if (extra.ttruong?.includes('Tiền thuế dòng') && extra.dlieu != null) {
            vatAmountFromExtra = parseFloat(String(extra.dlieu)) || null;
          }
          if (extra.ttruong?.includes('Thành tiền thanh toán') && extra.dlieu != null) {
            totalFromExtra = parseFloat(String(extra.dlieu)) || null;
          }
        }
      }

      const subtotal   = item.thtien   ?? null;
      const vatRate    = item.tsuat    ?? null;   // decimal e.g. 0.08
      const vatAmount  = item.tthue    ?? vatAmountFromExtra ?? (subtotal != null && vatRate != null ? Math.round(subtotal * vatRate) : null);
      const total      = totalFromExtra ?? (subtotal != null && vatAmount != null ? subtotal + vatAmount : subtotal);

      return {
        line_number: item.stt     ?? null,
        item_code:   null,                        // GDT detail API does not expose item code
        item_name:   item.ten     ?? null,
        unit:        item.dvtinh  ?? null,
        quantity:    item.sluong  ?? null,
        unit_price:  item.dgia    ?? null,
        subtotal,
        vat_rate:    vatRate != null ? Math.round(vatRate * 100) : null,  // store as integer % (e.g. 8)
        vat_amount:  vatAmount,
        total,
      };
    });
  }

  // ── Export Excel (bulk XLSX) ───────────────────────────────────────────────

  /**
   * Download all OUTPUT invoices (hóa đơn bán ra) as XLSX.
   * Endpoint: GET /query/invoices/export-excel
   * If the range spans multiple months, fetches each month separately and
   * returns the XLSX of the last (or only) chunk — the main use case is
   * single-month exports; for multi-month use the JSON list + local XLSX.
   */
  async exportOutputExcel(fromDate: Date, toDate: Date): Promise<Buffer> {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    const chunks = splitIntoMonths(fromDate, toDate);
    // Return last chunk's XLSX (most recent month) or first if only one
    const { from, to } = chunks[chunks.length - 1]!;
    const fromStr = formatGdtDate(from);
    const toStr   = formatGdtDate(to);
    const search  = `tdlap=ge=${fromStr};tdlap=le=${toStr}`;
    logger.info('[GdtDirect] exportOutputExcel', { from: fromStr, to: toStr });
    return this._getBinaryWithRetry(this.recipe?.api.endpoints.exportExcel ?? '/query/invoices/export-excel', {
      sort: 'tdlap:desc',
      search,
    });
  }

  /**
   * Download INPUT invoices (hóa đơn mua vào) as XLSX.
   * Endpoint: GET /query/invoices/export-excel-sold?type=purchase
   *
   * @param ttxlyType  5 = "Đã cấp mã" | 6 = "Không mã" | 8 = "Uỷ nhiệm" (default: 5)
   *
   * Note: GDT does not support merging both types in one XLSX download.
   * Call exportInputExcel(from,to,5) + exportInputExcel(from,to,6) separately if both XLSXs are needed.
   */
  async exportInputExcel(fromDate: Date, toDate: Date, ttxlyType: 5 | 6 | 8 = 5): Promise<Buffer> {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    const chunks = splitIntoMonths(fromDate, toDate);
    const { from, to } = chunks[chunks.length - 1]!;
    const fromStr = formatGdtDate(from);
    const toStr   = formatGdtDate(to);
    const search  = `tdlap=ge=${fromStr};tdlap=le=${toStr};ttxly==${ttxlyType}`;
    logger.info('[GdtDirect] exportInputExcel', { from: fromStr, to: toStr, ttxlyType });
    return this._getBinaryWithRetry(this.recipe?.api.endpoints.exportExcelPurchase ?? '/query/invoices/export-excel-sold', {
      sort:   'tdlap:desc',
      search,
      type:   'purchase',
    });
  }

  // ── Pagination ─────────────────────────────────────────────────────────────

  private async _fetchAllPagesBuffered(
    endpoint:     'sold' | 'purchase',
    fromDate:     Date,
    toDate:       Date,
    extraFilter?: string,
    overridePath?: string,
  ): Promise<RawInvoice[]> {
    if (!this.token) throw new Error('Not authenticated — call login() first');

    const direction: 'output' | 'input' = endpoint === 'sold' ? 'output' : 'input';
    const pageSize  = this.recipe?.api.pagination.pageSize ?? PAGE_SIZE;
    // Resolve the actual API path: overridePath takes precedence (used for sco-query endpoints),
    // then recipe setting, then hardcoded default.
    const endpointPath = overridePath
      ?? (endpoint === 'sold'
        ? (this.recipe?.api.endpoints.sold     ?? '/query/invoices/sold')
        : (this.recipe?.api.endpoints.purchase ?? '/query/invoices/purchase'));
    const from   = formatGdtDate(fromDate);
    const to     = formatGdtDate(toDate);
    // Build FIQL search string.
    // extraFilter is caller-supplied, e.g. 'ttxly==5' or 'ttxly==6'.
    // For sold invoices no extra filter is needed.
    const search = extraFilter
      ? `tdlap=ge=${from};tdlap=le=${to};${extraFilter}`
      : `tdlap=ge=${from};tdlap=le=${to}`;
    const all:   RawInvoice[] = [];
    let   total  = Infinity;

    // FIX-2: Pagination checkpoint — resume from last saved page after a crash.
    // Key: gdt:checkpoint:{companyId}:{yyyymm}:{direction}, TTL 1h.
    const yyyymm = this._companyId
      ? `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, '0')}`
      : null;
    let page = 0;
    if (this._checkpoint && this._companyId && yyyymm) {
      page = await this._checkpoint.loadStartPage(this._companyId, yyyymm, direction).catch(() => 0);
      if (page > 0) {
        logger.info('[GdtDirect] Đang tiếp tục từ checkpoint', {
          companyId: this._companyId, page, direction,
          message: `Đang tiếp tục từ trang ${page}, bỏ qua ${page * pageSize} hóa đơn đã lấy`,
        });
      }
    }

    logger.info('[GdtDirect] Fetching invoices', { endpoint, from, to, filter: extraFilter ?? 'none', startPage: page });

    while (all.length < total) {
      const res = await this._getWithRetry<GdtPagedResponse>(
        endpointPath,
        { sort: 'tdlap:desc', size: pageSize, page, search },
      );

      const rows = res.data.datas ?? res.data.data ?? [];

      // X-Total-Count header takes precedence over response body
      const headerTotal = parseInt(res.headers['x-total-count'] ?? '', 10);
      if (!isNaN(headerTotal)) total = headerTotal;
      else if (res.data.total != null) total = Number(res.data.total);

      if (rows.length === 0) break;

      const isSco = overridePath?.includes('sco-query') ?? false;
      const mapped = rows.map(r => mapInvoice(r, direction, {
        ttxlyFilter:      extraFilter,
        isSco,
        fields:           this.recipe?.fields,
        statusMap:        this.recipe?.statusMap,
        xmlAvailableTtxly: this.recipe
          ? new Set(this.recipe.api.query.xmlAvailableTtxly)
          : undefined,
      }));
      all.push(...mapped);

      logger.debug('[GdtDirect] Page fetched', {
        endpoint, page, rows: rows.length, soFar: all.length, total,
      });

      // FIX-2: Save checkpoint after each successful page (non-fatal)
      if (this._checkpoint && this._companyId && yyyymm) {
        await this._checkpoint.save(this._companyId, yyyymm, direction, page).catch(() => {});
      }

      if (all.length >= total) break;
      page++;
      // Random 0.8-2.5s between pages — mimics human scrolling through results.
      // Fixed delays are a bot fingerprint; randomised intervals are harder to detect.
      await humanDelay(800, 2500);
    }

    logger.info('[GdtDirect] Fetch complete', { endpoint, total: all.length });
    // FIX-2: Clear checkpoint on success — next run starts fresh from page 0.
    if (this._checkpoint && this._companyId && yyyymm) {
      await this._checkpoint.clear(this._companyId, yyyymm, direction).catch(() => {});
    }
    return all;
  }

  // ── Phase 8: Streaming (async generator) ──────────────────────────────────

  /**
   * Phase 8: Same logic as _fetchAllPages but yields each page as it arrives
   * instead of accumulating and returning at the end.
   * Enables the sync worker to upsert + report progress incrementally.
   */
  private async *_streamPages(
    endpoint:      'sold' | 'purchase',
    fromDate:      Date,
    toDate:        Date,
    extraFilter?:  string,
    overridePath?: string,
  ): AsyncGenerator<RawInvoice[]> {
    if (!this.token) throw new Error('Not authenticated — call login() first');

    const direction: 'output' | 'input' = endpoint === 'sold' ? 'output' : 'input';
    const pageSize    = this.recipe?.api.pagination.pageSize ?? PAGE_SIZE;
    const endpointPath = overridePath
      ?? (endpoint === 'sold'
        ? (this.recipe?.api.endpoints.sold     ?? '/query/invoices/sold')
        : (this.recipe?.api.endpoints.purchase ?? '/query/invoices/purchase'));
    const from   = formatGdtDate(fromDate);
    const to     = formatGdtDate(toDate);
    const search = extraFilter
      ? `tdlap=ge=${from};tdlap=le=${to};${extraFilter}`
      : `tdlap=ge=${from};tdlap=le=${to}`;

    const yyyymm = this._companyId
      ? `${fromDate.getFullYear()}${String(fromDate.getMonth() + 1).padStart(2, '0')}`
      : null;
    let page = 0;
    if (this._checkpoint && this._companyId && yyyymm) {
      page = await this._checkpoint.loadStartPage(this._companyId, yyyymm, direction).catch(() => 0);
    }

    const isSco  = overridePath?.includes('sco-query') ?? false;
    let fetched  = 0;
    let total    = Infinity;

    while (fetched < total) {
      const res = await this._getWithRetry<GdtPagedResponse>(
        endpointPath,
        { sort: 'tdlap:desc', size: pageSize, page, search },
      );

      const rows = res.data.datas ?? res.data.data ?? [];
      const headerTotal = parseInt(res.headers['x-total-count'] ?? '', 10);
      if (!isNaN(headerTotal)) total = headerTotal;
      else if (res.data.total != null) total = Number(res.data.total);

      if (rows.length === 0) break;

      const mapped = rows.map(r => mapInvoice(r, direction, {
        ttxlyFilter:       extraFilter,
        isSco,
        fields:            this.recipe?.fields,
        statusMap:         this.recipe?.statusMap,
        xmlAvailableTtxly: this.recipe
          ? new Set(this.recipe.api.query.xmlAvailableTtxly)
          : undefined,
      }));

      fetched += mapped.length;

      if (this._checkpoint && this._companyId && yyyymm) {
        await this._checkpoint.save(this._companyId, yyyymm, direction, page).catch(() => {});
      }

      yield mapped;

      if (fetched >= total) break;
      page++;
      await humanDelay(800, 2500);
    }

    if (this._checkpoint && this._companyId && yyyymm) {
      await this._checkpoint.clear(this._companyId, yyyymm, direction).catch(() => {});
    }
  }

  /**
   * Phase 8: Stream output invoices page-by-page (hóa đơn đầu ra).
   * Each yielded batch contains invoices from one page (~50 items).
   * Note: De-duplication across main vs SCO endpoints happens at caller level.
   */
  async *fetchOutputInvoicesStream(
    fromDate: Date,
    toDate:   Date,
  ): AsyncGenerator<RawInvoice[]> {
    const scoPath = this.recipe?.api.endpoints.scoSold ?? GDT_SCO_SOLD;
    // Main endpoint — paginated over full date range
    for await (const batch of this._streamPages('sold', fromDate, toDate)) {
      yield batch;
    }
    await humanDelay(1_500, 3_000);

    // SCO endpoint — split into WEEKLY chunks.
    // Root cause: GDT's /sco-query/invoices/sold returns X-Total-Count equal to the
    // current page size (50) instead of the true total, OR returns HTTP 500 on page > 0
    // for companies with many MTT invoices (> 50/month). This causes _streamPages to
    // stop after exactly one page (50 items) even when hundreds exist.
    // Fix: fetch one week at a time — each chunk has ~10-25 invoices, fits in 1 page,
    // so pagination is never needed and the GDT limit is never hit.
    // Each chunk is also isolated in its own try-catch so a transient 500 on one week
    // does not abort the entire sync.
    const scoSoldChunks = splitIntoWeeks(fromDate, toDate);
    logger.info('[GdtDirect] SCO sold — fetching by weekly chunks', {
      totalChunks: scoSoldChunks.length,
      from: formatGdtDate(fromDate),
      to:   formatGdtDate(toDate),
    });
    for (let i = 0; i < scoSoldChunks.length; i++) {
      if (i > 0) await humanDelay(2_000, 5_000);
      const { from, to } = scoSoldChunks[i]!;
      try {
        for await (const batch of this._streamPages('sold', from, to, undefined, scoPath)) {
          yield batch;
        }
      } catch (err) {
        logger.warn('[GdtDirect] SCO sold chunk failed (non-fatal, skipping chunk)', {
          chunk: i + 1,
          from:  formatGdtDate(from),
          to:    formatGdtDate(to),
          err:   err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Phase 8: Stream input invoices page-by-page (hóa đơn đầu vào).
   */
  async *fetchInputInvoicesStream(
    fromDate: Date,
    toDate:   Date,
  ): AsyncGenerator<RawInvoice[]> {
    const scoPurchasePath = this.recipe?.api.endpoints.scoPurchase ?? GDT_SCO_PURCHASE;
    // ttxly==5 stream
    for await (const batch of this._streamPages('purchase', fromDate, toDate, 'ttxly==5')) {
      yield batch;
    }
    await humanDelay(1_500, 3_000);
    // ttxly==6 stream
    for await (const batch of this._streamPages('purchase', fromDate, toDate, 'ttxly==6')) {
      yield batch;
    }
    await humanDelay(1_500, 3_000);

    // SCO purchase endpoint — weekly chunks for the same reason as SCO sold.
    // /sco-query/invoices/purchase also suffers from X-Total-Count = pageSize bug.
    const scoPurchaseChunks = splitIntoWeeks(fromDate, toDate);
    logger.info('[GdtDirect] SCO purchase — fetching by weekly chunks', {
      totalChunks: scoPurchaseChunks.length,
      from: formatGdtDate(fromDate),
      to:   formatGdtDate(toDate),
    });
    for (let i = 0; i < scoPurchaseChunks.length; i++) {
      if (i > 0) await humanDelay(2_000, 5_000);
      const { from, to } = scoPurchaseChunks[i]!;
      try {
        for await (const batch of this._streamPages('purchase', from, to, undefined, scoPurchasePath)) {
          yield batch;
        }
      } catch (err) {
        logger.warn('[GdtDirect] SCO purchase chunk failed (non-fatal, skipping chunk)', {
          chunk: i + 1,
          from:  formatGdtDate(from),
          to:    formatGdtDate(to),
          err:   err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** GET JSON with auto-retry on transient errors (5xx, timeout) */
  private async _getWithRetry<T>(url: string, params: Record<string, unknown>) {
    const maxRetries   = this.recipe?.timing.maxRetries   ?? getPeakMaxRetries();
    const retryDelayMs = this.recipe?.timing.retryDelayMs ?? getPeakRetryDelay();
    let lastErr: Error | null = null;
    // VĐ1: Track proxy swaps separately — they don't consume the GDT retry budget
    let proxySwaps = 0;
    const MAX_PROXY_SWAPS = 2;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.http.get<T>(url, {
          params,
          headers: { Authorization: `Bearer ${this.token}` },
        });
      } catch (err) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status ?? 0;
          if (status === 401) {
            // FIX-1: Mid-run token refresh — re-login once on JWT expiry, then give up.
            // At page 600/2000 the JWT (~30-45 min TTL) expires — without this the job
            // fails and increments consecutive_failures, auto-blocking the company.
            if (!this._reloginAttempted && this._loginUsername && this._loginPassword) {
              this._reloginAttempted = true;
              logger.warn('[GdtDirect] Token hết hạn giữa lúc lấy dữ liệu — đang đăng nhập lại', { url });
              await this.login(this._loginUsername, this._loginPassword);
              continue; // retry request with fresh token
            }
            throw new Error('GDT token expired — re-login required');
          }
          // Log body for 4xx to help diagnose field/format issues
          if (status >= 400 && status < 500) {
            const body = JSON.stringify(err.response?.data ?? '').slice(0, 300);
            logger.error('[GdtDirect] 4xx error', { url, status, params, body });
            throw new Error(`GDT API ${status}: ${body}`);
          }
          if (status >= 500 || !err.response) {
            // VĐ1: Network-level failure (proxy TCP drop) — swap proxy, don't count retry
            if (
              isNetworkLevelError(err) &&
              this._proxyManager &&
              this._proxySessionSuffix &&
              proxySwaps < MAX_PROXY_SWAPS
            ) {
              const oldUrl = this._currentProxyUrl;
              // FIX: Do NOT call markFailed() here for session-level TCP drops.
              // A TCP drop mid-session is often GDT-side (rate-limit, server reset)
              // rather than an infra proxy failure. Calling markFailed() globally nulls
              // the slot for ALL companies and triggers a 4-6 min rotation cooldown.
              // markFailed() is still called by sync.worker.ts on login/probe failures
              // (more reliable infra-failure signal). Just swap locally here.
              const newProxyUrl = this._proxyManager.nextForCompany(this._proxySessionSuffix);
              if (newProxyUrl && newProxyUrl !== oldUrl) {
                proxySwaps++;
                logger.warn('[GdtDirect] Proxy TCP drop — swapping proxy (infra fail, not GDT retry)', {
                  url,
                  proxySwap: proxySwaps,
                  errMsg: err.message.slice(0, 80),
                  newProxy: newProxyUrl.replace(/:([^@:]+)@/, ':****@').slice(0, 40),
                });
                this._recreateHttpClient(newProxyUrl);
                attempt--; // proxy swap doesn't consume GDT retry budget
                await humanDelay(500, 1_500);
                continue;
              }
            }
            lastErr = err as Error;
            logger.warn('[GdtDirect] Retrying after error', { url, attempt, status });
            // Jittered exponential back-off: base * (attempt+1) ± 20%
            const base = retryDelayMs * (attempt + 1);
            await humanDelay(base * 0.8, base * 1.2);
            continue;
          }
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`Failed to GET ${url} after ${maxRetries} retries`);
  }

  /**
   * GET binary (arraybuffer) with retry — used for XML and XLSX downloads.
   * Uses binaryHttp (SOCKS5 tunnel) when available, else falls back to this.http.
   * Returns a Node.js Buffer.
   */
  private async _getBinaryWithRetry(
    url: string,
    params: Record<string, unknown>,
  ): Promise<Buffer> {
    // Prefer SOCKS5 client for binary downloads — pure TCP relay, no content filtering.
    // Falls back to main HTTP CONNECT client if SOCKS5 not configured.
    const primaryClient = this.binaryHttp ?? this.http;
    const client = primaryClient;
    const maxRetries   = this.recipe?.timing.maxRetries    ?? MAX_RETRIES;
    const retryDelayMs = this.recipe?.timing.retryDelayMs  ?? RETRY_DELAY;
    const binaryTimeout = this.recipe?.timing.binaryTimeoutMs ?? BINARY_TIMEOUT;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this._streamResponse(client, url, params, binaryTimeout);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (axios.isAxiosError(err)) {
          const status = err.response?.status ?? 0;
          if (status === 401) throw new Error('GDT token expired — re-login required');
          if (status >= 500 || !err.response) {
            // Log the response body so we can diagnose what GDT is saying
            if (err.response?.data) {
              try {
                const bodyText = Buffer.from(err.response.data as ArrayBuffer).toString('utf-8').slice(0, 300);
                logger.warn('[GdtDirect] Binary 500 body', { url, attempt, body: bodyText });
              } catch { /* ignore decode errors */ }
            }
            lastErr = err as Error;
            logger.warn('[GdtDirect] Binary retry (axios)', { url, attempt, status });
            await sleep(retryDelayMs * (attempt + 1));
            continue;
          }
        }
        // Also retry on plain stream/TCP errors (responseType:'stream' errors are NOT AxiosErrors).
        // "aborted" = axios cancels the stream after headers received, or Node http abort.
        // "ECONNRESET" / "socket hang up" = proxy dropped mid-stream.
        // These must retry just like network errors, not throw immediately.
        const isRetriableStream = /aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|stream|EPIPE/i.test(errMsg);
        if (isRetriableStream) {
          lastErr = err as Error;
          logger.warn('[GdtDirect] Binary retry (stream error)', { url, attempt, msg: errMsg });
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        throw err;
      }
    }

    // SOCKS5 failed on all retries — try once more with the regular HTTP CONNECT proxy.
    // "stream has been aborted" / status:0 = TCP dropped mid-stream by TMProxy SOCKS5.
    // HTTP CONNECT proxy is more stable for long-lived binary downloads.
    if (this.binaryHttp && lastErr != null) {
      logger.warn('[GdtDirect] SOCKS5 binary all retries failed — falling back to HTTP proxy', { url });
      try {
        return await this._streamResponse(this.http, url, params, binaryTimeout);
      } catch (fallbackErr) {
        logger.warn('[GdtDirect] HTTP proxy fallback also failed', {
          url,
          msg: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }

    throw lastErr ?? new Error(`Failed binary GET ${url} after ${maxRetries} retries`);
  }

  /**
   * Stream binary response through proxy tunnel into a Buffer.
   *
   * Why stream instead of arraybuffer:
   *   arraybuffer = axios buffers EVERYTHING before resolving.
   *   If TMProxy sees idle TCP (no bytes flowing) it drops the connection.
   *   stream = data chunks flow immediately as GDT sends them,
   *   keeping the TCP connection active through the proxy.
   *
   * Why Accept-Encoding: identity:
   *   commonHeaders sends gzip/deflate/br. Proxy may try to decompress
   *   the already-binary ZIP response and corrupt it. identity = raw bytes.
   *
   * Why decompress: false:
   *   Prevents axios from running the zlib decompressor on the stream.
   *   If response has no Content-Encoding (plain binary), the decompressor
   *   would abort with "stream has been aborted".
   */
  private async _streamResponse(
    client: AxiosInstance,
    url: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<Buffer> {
    const res = await client.get<NodeJS.ReadableStream>(url, {
      params,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Accept-Encoding': 'identity',
      },
      responseType: 'stream',
      decompress: false,
      timeout,
    });

    // Log response headers so we can diagnose what GDT is actually returning
    logger.info('[GdtDirect] Stream response headers', {
      url,
      status:        res.status,
      contentType:   res.headers['content-type'],
      contentLength: res.headers['content-length'],
      contentEncoding: res.headers['content-encoding'],
      transferEncoding: res.headers['transfer-encoding'],
    });

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      // Hard deadline: destroy stream if full response not received within timeout
      const deadline = setTimeout(() => {
        (res.data as NodeJS.ReadableStream & { destroy?: (e: Error) => void }).destroy?.(
          new Error('Binary stream timeout'),
        );
      }, timeout);

      (res.data as NodeJS.ReadableStream)
        .on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          chunks.push(buf);
          totalBytes += buf.length;
        })
        .on('end', () => {
          clearTimeout(deadline);
          logger.info('[GdtDirect] Stream complete', { url, totalBytes });
          resolve(Buffer.concat(chunks, totalBytes));
        })
        .on('error', (e: Error) => {
          clearTimeout(deadline);
          logger.warn('[GdtDirect] Stream error', { url, msg: e.message, bytesReceived: totalBytes });
          reject(e);
        });
    });
  }

  /**
   * VĐ5: Fetch invoice details with controlled concurrency (semaphore pattern).
   *
   * Sequential detail calls at 9–10s each become 30×10s=300s for 30 invoices.
   * With concurrency=3: 10 batches × ~10s = ~100s (67% reduction).
   *
   * Limits:
   *   /query/ endpoints:     max 3 concurrent
   *   /sco-query/ endpoints: max 2 concurrent (slower, avoid overload)
   *
   * Returns a Map from invoice key (invoice_number|serial) → detail JSON.
   * Errors per-invoice are caught individually and logged; one failure won't
   * abort the batch.
   */
  async fetchDetailsWithConcurrency(
    invoices: Array<{
      nbmst:    string;
      khhdon:   string;
      shdon:    string | number;
      khmshdon?: string | number;
      isSco?:   boolean;
    }>,
    concurrency = 3,
  ): Promise<Map<string, GdtInvoiceDetail>> {
    const results = new Map<string, GdtInvoiceDetail>();
    if (invoices.length === 0) return results;

    // Reduce concurrency for sco-query (slower endpoint)
    const hasSco = invoices.some(i => i.isSco);
    const effectiveConcurrency = hasSco ? Math.min(concurrency, 2) : concurrency;

    // Simple semaphore: maintain a pool of slots
    let active = 0;
    const queue: Array<() => void> = [];
    const acquire = (): Promise<() => void> =>
      new Promise(resolve => {
        const tryAcquire = () => {
          if (active < effectiveConcurrency) {
            active++;
            resolve(() => {
              active--;
              const next = queue.shift();
              if (next) next();
            });
          } else {
            queue.push(tryAcquire);
          }
        };
        tryAcquire();
      });

    const INTER_CALL_DELAY_MS = 500;

    await Promise.all(
      invoices.map(async (inv) => {
        const release = await acquire();
        try {
          await sleep(INTER_CALL_DELAY_MS + Math.random() * 500);
          const detail = await this.fetchInvoiceDetail(inv);
          const key = `${inv.shdon}|${inv.khhdon}`;
          results.set(key, detail);
        } catch (err) {
          logger.warn('[GdtDirect] fetchDetailsWithConcurrency: single detail failed (non-fatal)', {
            shdon:  inv.shdon,
            khhdon: inv.khhdon,
            err:    err instanceof Error ? err.message : String(err),
          });
        } finally {
          release();
        }
      }),
    );

    logger.info('[GdtDirect] fetchDetailsWithConcurrency complete', {
      requested:   invoices.length,
      fetched:     results.size,
      concurrency: effectiveConcurrency,
    });
    return results;
  }
}
