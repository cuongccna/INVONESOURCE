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
const PAGE_SIZE = 50;

// Retry config for transient errors
const MAX_RETRIES   = 3;
const RETRY_DELAY   = 3_000; // ms
const REQUEST_TIMEOUT = 30_000;
// Binary downloads (XML ZIP, XLSX) can be large and GDT server is slow to generate them.
// TMProxy and residential proxies have short idle timeouts — give generous room.
const BINARY_TIMEOUT = 120_000; // 2 min — override with recipe.timing.binaryTimeoutMs

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
  // ISO format: 2026-03-01T... or 2026-03-01
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
  const s = String(raw).replace('%', '').trim();
  if (s === 'kct' || s === 'kkktt' || s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : String(n);
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

// ── Map GDT JSON row → RawInvoice ─────────────────────────────────────────────

interface MapInvoiceOpts {
  ttxlyFilter?:     string;
  fields?:          RecipeFields;
  statusMap?:       Record<string, string>;
  xmlAvailableTtxly?: Set<number>;
}

function mapInvoice(
  row:       GdtInvoiceRaw,
  direction: 'output' | 'input',
  opts:      MapInvoiceOpts = {},
): RawInvoice {
  const { ttxlyFilter, fields, statusMap: recipeStatusMap, xmlAvailableTtxly: recipeXmlSet } = opts;
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
  const nestedArr = r[vatNestedPath];
  if (Array.isArray(nestedArr) && nestedArr.length > 0) {
    vatRate = parseVatRate((nestedArr[0] as Record<string, unknown>)['tsuat']);
  }
  // fallback to top-level tsuat
  if (!vatRate) vatRate = parseVatRate(pick(r, ...(fields?.vatRate ?? ['tsuat', 'thueSuat', 'thue_suat'])));

  const xmlSet = recipeXmlSet ?? XML_AVAILABLE_TTXLY;

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
    // XML is only available for coded invoices (ttxly==5).
    // For purchase: check the filter we used; for output: always has XML.
    xml_available:   direction === 'output'
      ? true
      : xmlSet.has(parseInt((ttxlyFilter ?? '').replace('ttxly==', ''), 10)),
  };
}

// ── Main Service ───────────────────────────────────────────────────────────────

export class GdtDirectApiService {
  private token:          string | null = null;
  private captchaService: CaptchaService;
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

  constructor(proxyUrl?: string | null, socks5ProxyUrl?: string | null, recipe?: CrawlerRecipe) {
    this.recipe = recipe ?? null;
    this.captchaService = new CaptchaService();
    const httpAgent = proxyUrl ? createTunnelAgent({ proxyUrl }) : undefined;
    // Pick a random User-Agent per session — rotates on every GdtDirectApiService
    // instantiation (i.e., each BullMQ job) so GDT never sees a fixed UA pattern.
    const ua = randomUserAgent();
    const commonHeaders = {
      'Accept':           'application/json, text/plain, */*',
      'Accept-Language':  'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding':  'gzip, deflate, br',
      'Cache-Control':    'no-cache',
      'User-Agent':       ua,
      'Origin':           'https://hoadondientu.gdt.gov.vn',
      'Referer':          'https://hoadondientu.gdt.gov.vn/',
      'sec-ch-ua':        '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-fetch-site':   'same-origin',
      'sec-fetch-mode':   'cors',
      'sec-fetch-dest':   'empty',
    };
    this.http = axios.create({
      // With proxy: use http:// so axios uses http.request + our httpAgent
      // (our httpAgent.createConnection does tunnel+TLS, so HTTP goes over TLS).
      // Without proxy: use https:// for a normal direct TLS connection.
      baseURL: httpAgent
        ? (this.recipe?.api.baseUrlHttp ?? GDT_API_HTTP)
        : (this.recipe?.api.baseUrl    ?? GDT_API_HTTPS),
      timeout: REQUEST_TIMEOUT,
      headers: commonHeaders,
      ...(httpAgent ? { httpAgent } : {}),
    });
    // SOCKS5 client for binary downloads (XML ZIP / XLSX).
    // Pure TCP relay → no content filtering by proxy → binary always works.
    // When socks5ProxyUrl is null: binaryHttp stays null → _getBinaryWithRetry uses this.http.
    if (socks5ProxyUrl) {
      const socks5Agent = createSocks5TunnelAgent({ proxyUrl: socks5ProxyUrl });
      this.binaryHttp = axios.create({
        baseURL:   this.recipe?.api.baseUrlHttp ?? GDT_API_HTTP,   // http:// so axios uses httpAgent (our SOCKS5 tunnel does TLS)
        timeout:   BINARY_TIMEOUT,
        headers:   commonHeaders,
        httpAgent: socks5Agent,
      });
    }
  }

  /** Returns the recipe currently active in this service instance (or null if using built-in defaults). */
  get activeRecipe(): CrawlerRecipe | null {
    return this.recipe;
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /**
   * Login to GDT portal and store JWT token.
   * Retries up to MAX_RETRIES times on wrong captcha.
   */
  async login(username: string, password: string): Promise<void> {
    let attempts = 0;
    let lastCaptchaId: string | null = null;
    const maxRetries   = this.recipe?.timing.maxRetries    ?? MAX_RETRIES;
    const retryDelayMs = this.recipe?.timing.retryDelayMs  ?? RETRY_DELAY;
    const captchaPath  = this.recipe?.api.endpoints.captcha ?? '/captcha';
    const authPath     = this.recipe?.api.endpoints.auth    ?? '/security-taxpayer/authenticate';

    while (attempts < maxRetries) {
      // Step 1: Get fresh captcha
      const captchaRes = await this.http.get<CaptchaResponse>(captchaPath);
      const { key: ckey, content: svgContent } = captchaRes.data;

      // Step 2: SVG → PNG → base64 → 2captcha
      let cvalue: string;
      try {
        const { default: sharp } = await import('sharp');
        const pngBuffer = await sharp(Buffer.from(svgContent)).png().toBuffer();
        const base64    = pngBuffer.toString('base64');
        const result    = await this.captchaService.solve(base64);
        cvalue          = result.text.trim().toUpperCase();
        lastCaptchaId   = result.captchaId;
        logger.debug('[GdtDirect] Captcha solved', { captchaId: lastCaptchaId, cvalue });
      } catch (err) {
        logger.warn('[GdtDirect] Captcha error', { attempts, err });
        attempts++;
        await sleep(retryDelayMs);
        continue;
      }

      // Step 3: Authenticate
      try {
        const authRes = await this.http.post<AuthResponse>(
          authPath,
          { username, password, cvalue, ckey },
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

  /** Fetch all output invoices (hóa đơn bán ra) for the given period */
  async fetchOutputInvoices(fromDate: Date, toDate: Date): Promise<RawInvoice[]> {
    return this._fetchRangeByMonth('sold', fromDate, toDate);
  }

  /**
   * Fetch all input invoices (hóa đơn mua vào) for the given period.
   *
   * GDT portal has three tabs for purchase invoices:
   *   ttxly==5  →  "Đã cấp mã hóa đơn"         (e-invoice with GDT code)
   *   ttxly==6  →  "Cục Thuế đã nhận không mã"  (received without code)
   *   ttxly==8  →  "Hóa đơn uỷ nhiệm"           (delegated/ủy nhiệm invoices)
   * All three are valid deductible input invoices — we fetch and merge them.
   */
  async fetchInputInvoices(fromDate: Date, toDate: Date): Promise<RawInvoice[]> {
    // Fetch all three types sequentially (not parallel — avoids GDT rate-limit spike)
    const filters = this.recipe?.api.query.purchaseFilters ?? ['ttxly==5', 'ttxly==6', 'ttxly==8'];
    const [f5 = 'ttxly==5', f6 = 'ttxly==6', f8 = 'ttxly==8'] = filters;
    const type5 = await this._fetchRangeByMonth('purchase', fromDate, toDate, f5);
    await humanDelay(1_500, 3_000);
    const type6 = await this._fetchRangeByMonth('purchase', fromDate, toDate, f6);
    await humanDelay(1_500, 3_000);
    const type8 = await this._fetchRangeByMonth('purchase', fromDate, toDate, f8);

    // Merge & deduplicate across all three types.
    // Dedup key: invoice_number + seller_tax_code + invoice_date
    const seen   = new Set<string>();
    const merged: RawInvoice[] = [];
    for (const inv of [...type5, ...type6, ...type8]) {
      const key = `${inv.invoice_number ?? ''}|${inv.seller_tax_code ?? ''}|${inv.invoice_date ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(inv);
      }
    }
    logger.info('[GdtDirect] Purchase invoices merged', {
      ttxly5: type5.length,
      ttxly6: type6.length,
      ttxly8: type8.length,
      merged: merged.length,
    });
    return merged;
  }

  /**
   * Split [fromDate, toDate] into calendar-month windows (GDT max = 1 month)
   * and concatenate results.
   * @param extraFilter  Optional FIQL filter appended to the search string (e.g. 'ttxly==5').
   */
  private async _fetchRangeByMonth(
    endpoint:    'sold' | 'purchase',
    fromDate:    Date,
    toDate:      Date,
    extraFilter?: string,
  ): Promise<RawInvoice[]> {
    const chunks = splitIntoMonths(fromDate, toDate);
    const all: RawInvoice[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const { from, to } = chunks[i]!;
      // Human-like delay BEFORE each chunk (except the first).
      // Mimics an accountant pausing between page navigations (4–8s).
      // Without this, consecutive month requests arrive < 1s apart — GDT detects bot pattern
      // and responds with 429 after ~20 rapid requests.
      if (i > 0) await humanDelay(4_000, 8_000);
      const chunk = await this._fetchAllPages(endpoint, from, to, extraFilter);
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
  }): Promise<GdtInvoiceDetail> {
    if (!this.token) throw new Error('Not authenticated — call login() first');
    const { nbmst, khhdon, shdon, khmshdon = 1 } = params;
    const url = this.recipe?.api.endpoints.detail ?? '/query/invoices/detail';
    logger.debug('[GdtDirect] fetchInvoiceDetail', { nbmst, khhdon, shdon });
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

  private async _fetchAllPages(
    endpoint:    'sold' | 'purchase',
    fromDate:    Date,
    toDate:      Date,
    extraFilter?: string,
  ): Promise<RawInvoice[]> {
    if (!this.token) throw new Error('Not authenticated — call login() first');

    const direction: 'output' | 'input' = endpoint === 'sold' ? 'output' : 'input';
    const pageSize  = this.recipe?.api.pagination.pageSize ?? PAGE_SIZE;
    // Resolve the actual API path for this endpoint type from recipe (with fallback)
    const endpointPath = endpoint === 'sold'
      ? (this.recipe?.api.endpoints.sold     ?? '/query/invoices/sold')
      : (this.recipe?.api.endpoints.purchase ?? '/query/invoices/purchase');
    const from   = formatGdtDate(fromDate);
    const to     = formatGdtDate(toDate);
    // Build FIQL search string.
    // extraFilter is caller-supplied, e.g. 'ttxly==5' or 'ttxly==6'.
    // For sold invoices no extra filter is needed.
    const search = extraFilter
      ? `tdlap=ge=${from};tdlap=le=${to};${extraFilter}`
      : `tdlap=ge=${from};tdlap=le=${to}`;
    const all:   RawInvoice[] = [];
    let   page   = 0;
    let   total  = Infinity;

    logger.info('[GdtDirect] Fetching invoices', { endpoint, from, to, filter: extraFilter ?? 'none' });

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

      const mapped = rows.map(r => mapInvoice(r, direction, {
        ttxlyFilter:      extraFilter,
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

      if (all.length >= total) break;
      page++;
      // Random 0.8-2.5s between pages — mimics human scrolling through results.
      // Fixed delays are a bot fingerprint; randomised intervals are harder to detect.
      await humanDelay(800, 2500);
    }

    logger.info('[GdtDirect] Fetch complete', { endpoint, total: all.length });
    return all;
  }

  /** GET JSON with auto-retry on transient errors (5xx, timeout) */
  private async _getWithRetry<T>(url: string, params: Record<string, unknown>) {
    const maxRetries   = this.recipe?.timing.maxRetries   ?? MAX_RETRIES;
    const retryDelayMs = this.recipe?.timing.retryDelayMs ?? RETRY_DELAY;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.http.get<T>(url, {
          params,
          headers: { Authorization: `Bearer ${this.token}` },
        });
      } catch (err) {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status ?? 0;
          if (status === 401) throw new Error('GDT token expired — re-login required');
          // Log body for 4xx to help diagnose field/format issues
          if (status >= 400 && status < 500) {
            const body = JSON.stringify(err.response?.data ?? '').slice(0, 300);
            logger.error('[GdtDirect] 4xx error', { url, status, params, body });
            throw new Error(`GDT API ${status}: ${body}`);
          }
          if (status >= 500 || !err.response) {
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
}
