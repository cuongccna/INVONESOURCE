/**
 * PROMPT 1 — GDT Config + Field Resolver + Quarter Splitter + Dynamic Job Timeout
 *
 * Config-driven GDT crawl configuration. When GDT changes endpoints or field names,
 * update the config in DB (gdt_configs table) — zero code deploy needed.
 */

import { pool } from './db';
import { logger } from './logger';

// ─── PART 1: GdtConfig Interface ────────────────────────────────────────────

export interface GdtEndpointTimeouts {
  [path: string]: number;
}

export interface GdtApiConfig {
  baseUrl: string;
  endpoints: {
    auth: string;
    sold: string;
    soldSco: string;
    purchase: string;
    purchaseSco: string;
    detail: string;
    detailSco: string;
    captcha: string;
    [key: string]: string;
  };
  endpointTimeouts: GdtEndpointTimeouts;
  pagination: {
    pageSize: number;
    zeroBased: boolean;
    totalHeader: string;
  };
  query: {
    purchaseFilters: string[];
    xmlAvailableTtxly: number[];
  };
}

export interface GdtFieldAliases {
  date: string[];
  total: string[];
  serial: string[];
  status: string[];
  ttxly: string[];
  vatRate: string[];
  buyerTax: string[];
  subtotal: string[];
  buyerName: string[];
  sellerTax: string[];
  vatAmount: string[];
  invoiceNum: string[];
  sellerName: string[];
  invoiceType: string[];
  vatRateNestedPath: string;
  [key: string]: string[] | string;
}

export interface GdtTimingConfig {
  requestTimeoutMs: number;
  binaryTimeoutMs: number;
  retryDelayMs: number;
  maxRetries: number;
}

export interface GdtConfig {
  api: GdtApiConfig;
  fields: GdtFieldAliases;
  statusMap: Record<string, string>;
  ttxlyMap: Record<string, string>;
  timing: GdtTimingConfig;
}

// ─── Default Config (embedded fallback) ──────────────────────────────────────

export const DEFAULT_GDT_CONFIG: GdtConfig = {
  api: {
    baseUrl: 'https://hoadondientu.gdt.gov.vn:30000',
    endpoints: {
      auth:        '/security-taxpayer/authenticate',
      sold:        '/query/invoices/sold',
      soldSco:     '/sco-query/invoices/sold',
      purchase:    '/query/invoices/purchase',
      purchaseSco: '/sco-query/invoices/purchase',
      detail:      '/query/invoices/detail',
      detailSco:   '/sco-query/invoices/detail',
      captcha:     '/captcha',
    },
    endpointTimeouts: {
      '/query/invoices/sold':            30_000,
      '/query/invoices/purchase':        30_000,
      '/query/invoices/detail':          45_000,
      '/sco-query/invoices/sold':        60_000,
      '/sco-query/invoices/purchase':    60_000,
      '/sco-query/invoices/detail':      60_000,
      '/captcha':                        15_000,
      '/security-taxpayer/authenticate': 20_000,
    },
    pagination: {
      pageSize: 50,
      zeroBased: true,
      totalHeader: 'X-Total-Count',
    },
    query: {
      purchaseFilters: ['ttxly==5', 'ttxly==6', 'ttxly==8'],
      xmlAvailableTtxly: [5],
    },
  },
  fields: {
    date:        ['tdlap', 'ngayLap', 'ngay_lap'],
    total:       ['tgtttbso', 'tongThanhToan', 'tongTien'],
    serial:      ['khhdon', 'kyHieuHoaDon'],
    status:      ['tthai', 'tthdon', 'trangThai'],
    ttxly:       ['ttxly'],
    vatRate:     ['tsuat', 'thueSuat'],
    buyerTax:    ['nmmst', 'mnmst', 'mstNguoiMua'],
    subtotal:    ['tgtcthue', 'tienHangChuaThue'],
    buyerName:   ['nmten', 'tenNguoiMua'],
    sellerTax:   ['nbmst', 'msttcgp', 'mstNguoiBan'],
    vatAmount:   ['tgtthue', 'tienThue'],
    invoiceNum:  ['shdon', 'soHoaDon'],
    sellerName:  ['nbten', 'tenNguoiBan'],
    invoiceType: ['thdon', 'loaiHD'],
    vatRateNestedPath: 'thttltsuat',
  },
  statusMap: {
    '1': 'valid',
    '3': 'cancelled',
    '4': 'replaced_original',
    '5': 'replaced',
    '6': 'adjusted',
  },
  ttxlyMap: {
    '5': 'co_ma',
    '6': 'khong_ma',
    '8': 'may_tinh_tien',
  },
  timing: {
    requestTimeoutMs: 30_000,
    binaryTimeoutMs:  60_000,
    retryDelayMs:     3_000,
    maxRetries:       3,
  },
};

// ─── PART 2: Field Resolver ──────────────────────────────────────────────────

/**
 * Resolve a value from a raw object using a list of field aliases.
 * Returns the first non-null/non-undefined value found.
 */
export function resolveField(
  obj: Record<string, unknown>,
  aliases: string[],
): unknown {
  for (const alias of aliases) {
    const val = obj[alias];
    if (val !== null && val !== undefined) return val;
  }
  return undefined;
}

/**
 * Resolve a field and coerce to number. Returns 0 if not found or NaN.
 */
export function resolveNumber(
  obj: Record<string, unknown>,
  aliases: string[],
): number {
  const val = resolveField(obj, aliases);
  if (val === null || val === undefined) return 0;
  const n = Number(val);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Resolve a field and coerce to string. Returns '' if not found.
 */
export function resolveString(
  obj: Record<string, unknown>,
  aliases: string[],
): string {
  const val = resolveField(obj, aliases);
  if (val === null || val === undefined) return '';
  return String(val);
}

export interface NormalizedInvoice {
  invoiceNum: number;
  serial: string;
  sellerTax: string;
  sellerName: string;
  buyerTax: string;
  buyerName: string;
  issuedDate: string;
  status: string;
  processType: string;
  subtotal: number;
  vatAmount: number;
  total: number;
  invoiceType: string;
  vatRates: unknown[];
  rawData: Record<string, unknown>;
}

/**
 * Normalize a raw GDT invoice object using config field aliases.
 * NEVER hardcodes field names — all resolved from config.
 */
export function normalizeInvoice(
  raw: Record<string, unknown>,
  config: GdtConfig,
): NormalizedInvoice {
  const f = config.fields;
  const statusRaw = String(resolveField(raw, f.status as string[]) ?? '');
  const ttxlyRaw = String(resolveField(raw, f.ttxly as string[]) ?? '');

  // Parse VAT rates from nested path
  const vatRates: unknown[] = [];
  const nestedPath = f.vatRateNestedPath;
  if (typeof nestedPath === 'string' && raw[nestedPath]) {
    const nested = raw[nestedPath];
    if (Array.isArray(nested)) {
      vatRates.push(...nested);
    }
  }

  return {
    invoiceNum: resolveNumber(raw, f.invoiceNum as string[]),
    serial: resolveString(raw, f.serial as string[]),
    sellerTax: resolveString(raw, f.sellerTax as string[]),
    sellerName: resolveString(raw, f.sellerName as string[]),
    buyerTax: resolveString(raw, f.buyerTax as string[]),
    buyerName: resolveString(raw, f.buyerName as string[]),
    issuedDate: resolveString(raw, f.date as string[]),
    status: config.statusMap[statusRaw] ?? statusRaw,
    processType: config.ttxlyMap[ttxlyRaw] ?? ttxlyRaw,
    subtotal: resolveNumber(raw, f.subtotal as string[]),
    vatAmount: resolveNumber(raw, f.vatAmount as string[]),
    total: resolveNumber(raw, f.total as string[]),
    invoiceType: resolveString(raw, f.invoiceType as string[]),
    vatRates,
    rawData: raw,
  };
}

// ─── PART 3: Quarter Splitter ────────────────────────────────────────────────

export type LicenseTier = 'free' | 'pro' | 'enterprise';

const MAX_DAYS: Record<LicenseTier, number> = {
  free:       92,   // 1 quý
  pro:        92,
  enterprise: 184,  // 2 quý
};

export interface MonthWindow {
  fromDate: string;   // GDT format: DD/MM/YYYYThh:mm:ss
  toDate: string;     // GDT format: DD/MM/YYYYThh:mm:ss
  label: string;      // "Tháng 1/2026"
}

/**
 * Parse a date string in YYYY-MM-DD format to Date (UTC).
 */
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Format a date to GDT format DD/MM/YYYYThh:mm:ss
 */
function toGdtDate(d: Date, endOfDay: boolean): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const time = endOfDay ? '23:59:59' : '00:00:00';
  return `${dd}/${mm}/${yyyy}T${time}`;
}

/**
 * Get the last day of a given month.
 */
function lastDayOfMonth(year: number, month: number): Date {
  return new Date(year, month, 0); // month is 1-based here: new Date(2026, 1, 0) = Jan 31
}

/**
 * Split a date range into calendar month windows, enforcing license limits.
 *
 * GDT limits: 1 request per month. License limits total range:
 *   free/pro:    max 92 days  (1 quarter)
 *   enterprise:  max 184 days (2 quarters)
 */
export function splitIntoMonthWindows(params: {
  fromDate: string;   // YYYY-MM-DD
  toDate: string;     // YYYY-MM-DD
  license: LicenseTier;
}): MonthWindow[] {
  const { fromDate, toDate, license } = params;
  const start = parseDate(fromDate);
  const end = parseDate(toDate);

  if (start > end) {
    throw new Error('Ngày bắt đầu phải trước ngày kết thúc');
  }

  const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 3600 * 24));
  const maxDays = MAX_DAYS[license];

  if (diffDays > maxDays) {
    throw new Error(
      `Gói ${license} chỉ cho phép tối đa ${maxDays} ngày (${Math.floor(maxDays / 30)} tháng). ` +
      `Khoảng thời gian yêu cầu: ${diffDays} ngày. Vui lòng thu hẹp phạm vi hoặc nâng cấp gói.`
    );
  }

  const windows: MonthWindow[] = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth(); // 0-based

    // Window start = cursor (first month may not be 1st)
    const windowStart = new Date(cursor);

    // Window end = min(end-of-month, toDate)
    const monthEnd = lastDayOfMonth(year, month + 1); // month+1 because lastDayOfMonth expects 1-based
    const windowEnd = monthEnd > end ? new Date(end) : monthEnd;

    windows.push({
      fromDate: toGdtDate(windowStart, false),
      toDate: toGdtDate(windowEnd, true),
      label: `Tháng ${month + 1}/${year}`,
    });

    // Move cursor to first day of next month
    cursor = new Date(year, month + 1, 1);
  }

  return windows;
}

/**
 * Build a GDT search parameter string for a given month window.
 *
 * @example
 *   buildSearchParam(window, 'ttxly==5')
 *   → "tdlap=ge=15/01/2026T00:00:00;tdlap=le=31/01/2026T23:59:59;ttxly==5"
 *
 *   buildSearchParam(window)  // sold — no ttxly filter
 *   → "tdlap=ge=15/01/2026T00:00:00;tdlap=le=31/01/2026T23:59:59"
 */
export function buildSearchParam(
  window: MonthWindow,
  ttxlyFilter?: string,
): string {
  let param = `tdlap=ge=${window.fromDate};tdlap=le=${window.toDate}`;
  if (ttxlyFilter) {
    param += `;${ttxlyFilter}`;
  }
  return param;
}

// ─── PART 4: Dynamic Job Timeout ─────────────────────────────────────────────

/**
 * Calculate BullMQ job timeout based on estimated invoice volume.
 *
 * Benchmark from production:
 *   Login + captcha:    ~16s fixed
 *   List fetch:         ~1s/page (50 invoices/page)
 *   Detail /query/:     ~9s/invoice
 *   Detail /sco-query/: ~12s/invoice (slower)
 *   Buffer retry:       60s
 *
 * Returns timeout in ms, clamped between 3 minutes and 30 minutes.
 */
export function calculateJobTimeout(estimate: {
  outEst: number;
  inEst: number;
}): number {
  const total = estimate.outEst + estimate.inEst;

  const estimated =
    16_000 +                           // login + captcha
    Math.ceil(total / 50) * 1_000 +    // list pages
    total * 12_000 +                   // detail fetch (worst case sco)
    60_000;                            // retry buffer

  const clamped = Math.min(Math.max(estimated, 3 * 60_000), 30 * 60_000);

  const minutes = Math.round(clamped / 60_000 * 10) / 10;
  logger.info(`Dynamic timeout set: ${minutes}m for ${total} invoices`, {
    outEst: estimate.outEst,
    inEst: estimate.inEst,
    timeoutMs: clamped,
  });

  return clamped;
}

// ─── PART 5: Config Repository ──────────────────────────────────────────────

const CONFIG_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

/**
 * Validate a GdtConfig object. Returns a list of errors (empty = valid).
 */
export function validateGdtConfig(c: unknown): string[] {
  const errors: string[] = [];
  if (!c || typeof c !== 'object') {
    errors.push('Config must be a non-null object');
    return errors;
  }

  const cfg = c as Record<string, unknown>;

  // Check top-level keys
  for (const key of ['api', 'fields', 'statusMap', 'ttxlyMap', 'timing']) {
    if (!(key in cfg)) errors.push(`Missing top-level key: ${key}`);
  }
  if (errors.length > 0) return errors;

  const api = cfg['api'] as Record<string, unknown>;
  if (!api['baseUrl']) errors.push('api.baseUrl is required');
  if (!api['endpoints'] || typeof api['endpoints'] !== 'object') {
    errors.push('api.endpoints must be an object');
  } else {
    const ep = api['endpoints'] as Record<string, unknown>;
    for (const req of ['auth', 'sold', 'purchase', 'detail', 'captcha']) {
      if (!ep[req]) errors.push(`api.endpoints.${req} is required`);
    }
  }

  if (!api['pagination'] || typeof api['pagination'] !== 'object') {
    errors.push('api.pagination must be an object');
  }

  const fields = cfg['fields'] as Record<string, unknown>;
  for (const req of ['date', 'total', 'serial', 'status', 'sellerTax', 'buyerTax', 'invoiceNum']) {
    if (!fields[req]) errors.push(`fields.${req} is required`);
  }

  const timing = cfg['timing'] as Record<string, unknown>;
  if (typeof timing['requestTimeoutMs'] !== 'number') errors.push('timing.requestTimeoutMs must be a number');
  if (typeof timing['maxRetries'] !== 'number') errors.push('timing.maxRetries must be a number');

  return errors;
}

/**
 * GDT Config Repository — loads config from DB with 5-minute in-memory cache.
 *
 * Usage:
 *   const config = await gdtConfigRepo.loadActive();
 *   // ... update config in DB ...
 *   gdtConfigRepo.reload(); // clear cache
 */
export class GdtConfigRepository {
  private cache: GdtConfig | null = null;
  private cacheExpiry = 0;

  /**
   * Load the active GDT config. Uses in-memory cache (5 min TTL)
   * to avoid hitting DB on every request.
   *
   * Falls back to DEFAULT_GDT_CONFIG if no active config in DB.
   */
  async loadActive(): Promise<GdtConfig> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    try {
      const { rows } = await pool.query<{ config: GdtConfig }>(
        'SELECT config FROM gdt_configs WHERE is_active = true ORDER BY version DESC LIMIT 1',
      );

      if (rows.length > 0) {
        const cfg = rows[0].config;
        const valErrors = validateGdtConfig(cfg);
        if (valErrors.length > 0) {
          logger.warn('Active GDT config has validation errors, falling back to default', {
            errors: valErrors,
          });
          this.cache = DEFAULT_GDT_CONFIG;
        } else {
          this.cache = cfg;
          logger.info('GDT config loaded from DB', { version: (rows[0] as Record<string, unknown>)['version'] });
        }
      } else {
        logger.info('No active GDT config in DB, using default');
        this.cache = DEFAULT_GDT_CONFIG;
      }
    } catch (err) {
      logger.warn('Failed to load GDT config from DB, using default', { error: (err as Error).message });
      this.cache = DEFAULT_GDT_CONFIG;
    }

    this.cacheExpiry = Date.now() + CONFIG_CACHE_TTL_MS;
    return this.cache;
  }

  /**
   * Clear the in-memory cache. Next loadActive() will re-read from DB.
   */
  reload(): void {
    this.cache = null;
    this.cacheExpiry = 0;
    logger.info('GDT config cache cleared');
  }
}

/** Singleton config repository */
export const gdtConfigRepo = new GdtConfigRepository();
