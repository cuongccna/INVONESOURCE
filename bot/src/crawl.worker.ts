/**
 * PROMPT 3 — Smart Crawl Worker (production-hardened)
 *
 * BullMQ Worker optimised for 100,000+ concurrent tenants.
 * Uses config-driven GDT endpoints, concurrent detail fetching,
 * network error classification, and anti-detection measures.
 *
 * Two queues:
 *   invoice-sync-high  — user_request, concurrency=10
 *   invoice-sync-batch — cron/auto,    concurrency=3
 */

import { Worker, Queue, Job, UnrecoverableError } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import axios, { type AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';

import { pool }                   from './db';
import { logger }                 from './logger';
import { decryptCredentials }     from './encryption.service';
import { createTunnelAgent }      from './proxy-tunnel';
import { CaptchaService }        from './captcha.service';

import {
  gdtConfigRepo,
  splitIntoMonthWindows,
  buildSearchParam,
  calculateJobTimeout,
  resolveField,
  type GdtConfig,
  type MonthWindow,
} from './gdt-config';

import {
  classifyBatch,
  generateTaxSummary,
  type ClassifiedInvoice,
} from './invoice-classifier';

import { InvoiceCacheService }         from './invoice-cache';
import { GdtSessionPool, UA_PROFILES } from './session-pool';
import type { PooledSession, UAProfile } from './session-pool';
import { GdtCircuitBreaker, isNetworkLevelError, isGdtRateLimit } from './circuit-breaker';
import { TmproxyManager }             from './proxy-manager-v2';
import { Semaphore, AdaptiveDelayManager } from './adaptive-rate-limiter';

// ─── Environment ─────────────────────────────────────────────────────────────

const REDIS_URL     = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const REDIS_CONN    = { url: REDIS_URL } as ConnectionOptions;

// ─── Shared Singletons ──────────────────────────────────────────────────────

const redis          = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
const invoiceCache   = new InvoiceCacheService(redis);
const sessionPool    = new GdtSessionPool(redis);
const proxyManager   = new TmproxyManager();
const adaptiveDelay  = new AdaptiveDelayManager();
const captchaService = new CaptchaService();

// ─── Job Types ───────────────────────────────────────────────────────────────

export interface SyncJobData {
  jobId: string;
  tenantId: string;
  encryptedCredentials: string;
  direction: 'purchase' | 'sold' | 'both';
  fromDate: string;      // YYYY-MM-DD
  toDate: string;        // YYYY-MM-DD
  license: 'free' | 'pro' | 'enterprise';
  priority: 'high' | 'normal' | 'low';
  triggeredBy: 'user_request' | 'cron' | 'manual';
  volumeEstimate?: { outEst: number; inEst: number };
}

// ─── Queues ──────────────────────────────────────────────────────────────────

export const highQueue = new Queue<SyncJobData>('invoice-sync-high', {
  connection: REDIS_CONN,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 200,
    removeOnFail: 100,
  },
});

export const batchQueue = new Queue<SyncJobData>('invoice-sync-batch', {
  connection: REDIS_CONN,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 120_000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Notification queue — tells backend to send push notifications after sync
const notifQueue = new Queue('sync-notifications', { connection: REDIS_CONN });

// ─── Redis Lock ──────────────────────────────────────────────────────────────

const LOCK_PREFIX = 'inv:lock:';
const LOCK_TTL    = 600; // 10 min

const RELEASE_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else return 0 end
`;

async function acquireLock(tenantId: string, direction: string): Promise<string | null> {
  const token = uuidv4();
  const key   = `${LOCK_PREFIX}${tenantId}:${direction}`;
  const ok    = await redis.set(key, token, 'EX', LOCK_TTL, 'NX');
  return ok === 'OK' ? token : null;
}

async function releaseLock(tenantId: string, direction: string, token: string): Promise<void> {
  await redis.eval(RELEASE_LOCK_LUA, 1, `${LOCK_PREFIX}${tenantId}:${direction}`, token);
}

// ─── GDT HTTP Client ─────────────────────────────────────────────────────────

/** Header "action" values — URL-encoded Vietnamese */
const ACTIONS = {
  searchPurchase: encodeURIComponent('Tìm kiếm (hóa đơn mua vào)'),
  searchSold:     encodeURIComponent('Tìm kiếm (hóa đơn bán ra)'),
  detailPurchase: encodeURIComponent('Xem hóa đơn (hóa đơn mua vào)'),
  detailSold:     encodeURIComponent('Xem hóa đơn (hóa đơn bán ra)'),
};

/** Page size pool — rotate to avoid detection pattern */
const PAGE_SIZES = [15, 20, 25, 50];

function pickPageSize(): number {
  return PAGE_SIZES[Math.floor(Math.random() * PAGE_SIZES.length)];
}

/**
 * Create an axios instance configured for GDT API.
 *
 * - UA profile consistency (1 session = 1 profile)
 * - Per-endpoint timeout via request interceptor
 * - Correct headers matching browser behavior
 */
function createGdtClient(
  session: PooledSession,
  config: GdtConfig,
  proxyUrl?: string,
): AxiosInstance {
  const ua = session.uaProfile;

  const headers: Record<string, string> = {
    'Authorization':    `Bearer ${session.accessToken}`,
    'Cookie':           session.sessionCookie,
    'accept':           'application/json, text/plain, */*',
    'accept-language':  'vi',
    'connection':       'keep-alive',
    'end-point':        '/tra-cuu/tra-cuu-hoa-don',
    'host':             'hoadondientu.gdt.gov.vn:30000',
    'origin':           'https://hoadondientu.gdt.gov.vn',
    'referer':          'https://hoadondientu.gdt.gov.vn/',
    'sec-fetch-dest':   'empty',
    'sec-fetch-mode':   'cors',
    'sec-fetch-site':   'same-site',
    'sec-ch-ua':        ua.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent':       ua.ua,
  };

  const axiosConfig: Record<string, unknown> = {
    baseURL: config.api.baseUrl,
    headers,
    timeout: config.timing.requestTimeoutMs,
    maxRedirects: 0,
    // FIQL search params must NOT be encoded
    paramsSerializer: (params: Record<string, string>) => {
      return Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    },
  };

  // Proxy support
  if (proxyUrl) {
    const agent = createTunnelAgent({ proxyUrl });
    axiosConfig['httpAgent'] = agent;
    // Use http:// base to let our tunnel agent handle TLS
    axiosConfig['baseURL'] = config.api.baseUrl.replace('https://', 'http://');
  }

  const client = axios.create(axiosConfig);

  // Request interceptor: per-endpoint timeout
  client.interceptors.request.use((reqConfig) => {
    const url = reqConfig.url ?? '';
    const path = url.startsWith('/') ? url.split('?')[0] : new URL(url, config.api.baseUrl).pathname;
    reqConfig.timeout = config.api.endpointTimeouts[path] ?? config.timing.requestTimeoutMs;
    return reqConfig;
  });

  return client;
}

// ─── Network Error Helpers ───────────────────────────────────────────────────

const MAX_PROXY_SWAP_RETRIES = 2;

/**
 * Execute a request with automatic proxy swap on network errors.
 *
 * If the proxy dies mid-request, mark it failed, get a new one,
 * recreate the client, and retry. Does NOT count against maxRetries.
 */
async function requestWithProxySwap<T>(
  fn: (client: AxiosInstance) => Promise<T>,
  session: PooledSession,
  config: GdtConfig,
  label: string,
): Promise<T> {
  let currentProxy = session.proxyUrl;

  for (let attempt = 0; attempt <= MAX_PROXY_SWAP_RETRIES; attempt++) {
    const client = createGdtClient(session, config, currentProxy ?? undefined);

    try {
      return await fn(client);
    } catch (err) {
      if (isNetworkLevelError(err) && attempt < MAX_PROXY_SWAP_RETRIES) {
        logger.warn(`Proxy swap retry ${attempt + 1}/${MAX_PROXY_SWAP_RETRIES} for ${label}`, {
          tenantId: session.tenantId,
          proxy: currentProxy ? redactProxy(currentProxy) : 'direct',
        });

        if (currentProxy) {
          proxyManager.markFailed(currentProxy);
        }
        currentProxy = proxyManager.next();
        continue;
      }
      throw err;
    }
  }

  throw new Error(`requestWithProxySwap exhausted retries for ${label}`);
}

// ─── Anti-Detection Helpers ──────────────────────────────────────────────────

let requestCounter = 0;
const BREAK_EVERY_MIN = 15;
const BREAK_EVERY_MAX = 25;
let nextBreak = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN));

/**
 * Human-like jittered delay with ±30% variance.
 */
function jitteredDelay(baseMs: number, maxMs: number): Promise<void> {
  const ms = baseMs + Math.random() * (maxMs - baseMs);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Simulate read time: sleep(500 + items * 50 + jitter(±200))ms
 */
function simulateReadTime(itemCount: number): Promise<void> {
  const base = 500 + itemCount * 50;
  const jitter = (Math.random() - 0.5) * 400; // ±200ms
  return new Promise(r => setTimeout(r, Math.max(200, base + jitter)));
}

/**
 * Check if we should take a "user break" (30-90s pause every 15-25 requests).
 */
async function maybeUserBreak(): Promise<void> {
  requestCounter++;
  if (requestCounter >= nextBreak) {
    const pauseMs = 30_000 + Math.random() * 60_000; // 30-90s
    logger.debug('Simulating user break', { requests: requestCounter, pauseMs: Math.round(pauseMs) });
    await new Promise(r => setTimeout(r, pauseMs));
    requestCounter = 0;
    nextBreak = BREAK_EVERY_MIN + Math.floor(Math.random() * (BREAK_EVERY_MAX - BREAK_EVERY_MIN));
  }
}

// ─── Concurrent Detail Fetching ──────────────────────────────────────────────

interface InvoiceListItem {
  id: string;
  [key: string]: unknown;
}

/**
 * Fetch invoice details concurrently using a semaphore.
 *
 * Concurrency:
 *   isSco = false → 3 concurrent (faster endpoint)
 *   isSco = true  → 2 concurrent (slower sco endpoint)
 *
 * Performance: 30 invoices / 3 concurrent ≈ 100s vs 300s sequential (67% reduction)
 */
async function fetchDetailsWithConcurrency(
  session: PooledSession,
  invoices: InvoiceListItem[],
  config: GdtConfig,
  isSco: boolean,
  direction: 'purchase' | 'sold',
): Promise<Map<string, Record<string, unknown>>> {
  const concurrency = isSco ? 2 : 3;
  const endpoint    = isSco ? config.api.endpoints.detailSco : config.api.endpoints.detail;
  const actionHeader = direction === 'purchase' ? ACTIONS.detailPurchase : ACTIONS.detailSold;
  const sem = new Semaphore(concurrency);
  const results = new Map<string, Record<string, unknown>>();

  await Promise.all(invoices.map(async (inv) => {
    const release = await sem.acquire();
    try {
      await jitteredDelay(500, 1000);

      const detail = await requestWithProxySwap(
        async (client) => {
          const start = Date.now();
          const res = await client.get(endpoint, {
            params: { id: inv.id },
            headers: { action: actionHeader },
          });
          adaptiveDelay.recordResponseTime(endpoint, Date.now() - start);
          return res.data as Record<string, unknown>;
        },
        session,
        config,
        `detail:${inv.id}`,
      );

      results.set(String(inv.id), detail);
      await maybeUserBreak();
    } catch (err) {
      logger.warn('Detail fetch failed — skipping (no line items)', {
        id: inv.id,
        error: (err as Error).message,
      });
      // Do NOT throw — continue with other invoices
    } finally {
      release();
    }
  }));

  return results;
}

// ─── List Fetching ───────────────────────────────────────────────────────────

interface FetchListResult {
  items: Record<string, unknown>[];
  totalCount: number;
}

/**
 * Fetch paginated invoice list from a GDT endpoint.
 */
async function fetchInvoiceList(
  session: PooledSession,
  config: GdtConfig,
  endpoint: string,
  searchParam: string,
  direction: 'purchase' | 'sold',
): Promise<FetchListResult> {
  const pageSize    = pickPageSize();
  const totalHeader = config.api.pagination.totalHeader;
  const actionHeader = direction === 'purchase' ? ACTIONS.searchPurchase : ACTIONS.searchSold;

  const allItems: Record<string, unknown>[] = [];
  let totalCount = 0;
  let page       = config.api.pagination.zeroBased ? 0 : 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await requestWithProxySwap(
      async (client) => {
        const start = Date.now();
        const res = await client.get(endpoint, {
          params: { search: searchParam, size: pageSize, page },
          headers: { action: actionHeader },
        });
        adaptiveDelay.recordResponseTime(endpoint, Date.now() - start);

        const items = (Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
        const total = parseInt(String(res.headers[totalHeader.toLowerCase()] ?? '0'), 10);
        return { items, total };
      },
      session,
      config,
      `list:${endpoint}:page=${page}`,
    );

    allItems.push(...result.items);
    totalCount = result.total || allItems.length;

    await simulateReadTime(result.items.length);

    if (result.items.length < pageSize || allItems.length >= totalCount) break;
    page++;

    await adaptiveDelay.delay(endpoint);
    await maybeUserBreak();
  }

  return { items: allItems, totalCount };
}

// ─── GDT Login ───────────────────────────────────────────────────────────────

/**
 * Authenticate with GDT: solve captcha + POST to auth endpoint.
 * Returns a PooledSession.
 */
async function loginGdt(
  tenantId: string,
  username: string,
  password: string,
  config: GdtConfig,
  proxyUrl: string | null,
): Promise<PooledSession> {
  const uaProfile = UA_PROFILES[Math.floor(Math.random() * UA_PROFILES.length)];
  const maxRetries = config.timing.maxRetries;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fetch captcha
    const captchaEndpoint = config.api.baseUrl + config.api.endpoints.captcha;

    const headers: Record<string, string> = {
      'user-agent': uaProfile.ua,
      'sec-ch-ua': uaProfile.secChUa,
    };
    const axiosConfig: Record<string, unknown> = { headers, timeout: 15_000 };
    if (proxyUrl) {
      axiosConfig['httpAgent'] = createTunnelAgent({ proxyUrl });
    }

    const captchaRes = await axios.get(captchaEndpoint, {
      ...axiosConfig,
      responseType: 'arraybuffer',
    });

    const captchaBase64 = Buffer.from(captchaRes.data as ArrayBuffer).toString('base64');

    // Extract captcha key from response headers
    const captchaKey = String(captchaRes.headers['captcha-key'] ?? captchaRes.headers['x-captcha-key'] ?? '');

    // Solve captcha via 2Captcha
    const { text: captchaText } = await captchaService.solve(captchaBase64);

    // Authenticate
    const authEndpoint = config.api.baseUrl + config.api.endpoints.auth;
    const authPayload = {
      username,
      password,
      cvalue: captchaText,
      ckey: captchaKey,
    };

    try {
      const authRes = await axios.post(authEndpoint, authPayload, {
        ...axiosConfig,
        headers: {
          ...headers,
          'content-type': 'application/json',
          'accept': 'application/json, text/plain, */*',
        },
      });

      const token = String(authRes.data?.token ?? authRes.data?.access_token ?? '');
      if (!token) {
        throw new Error('No token in auth response');
      }

      const setCookies = (authRes.headers['set-cookie'] ?? []) as string[];
      const sessionCookie = GdtSessionPool.extractSessionCookie(setCookies);
      const expiresAt = GdtSessionPool.parseJwtExpiry(token);

      const session: PooledSession = {
        tenantId,
        accessToken: token,
        sessionCookie,
        expiresAt,
        proxyUrl,
        uaProfile,
        requestCount: 0,
        createdAt: Date.now(),
      };

      await sessionPool.store(session);
      await sessionPool.recordLoginAt(tenantId);

      logger.info('GDT login successful', {
        tenantId,
        expiresIn: Math.round((expiresAt - Date.now()) / 60_000) + 'm',
      });

      return session;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const data = (err as { response?: { data?: unknown } }).response?.data;
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data ?? '');

      // Wrong captcha → retry
      if (dataStr.includes('captcha') || dataStr.includes('Mã xác nhận không đúng')) {
        logger.warn('Wrong captcha, retrying', { attempt: attempt + 1 });
        continue;
      }

      // Invalid credentials → unrecoverable
      if (msg.includes('Tên đăng nhập') || dataStr.includes('Tên đăng nhập') ||
          (err as { response?: { status?: number } }).response?.status === 401) {
        throw new UnrecoverableError(
          `Invalid GDT credentials for ${username} — deactivating bot`,
        );
      }

      throw err;
    }
  }

  throw new Error('Captcha solve exhausted all retries');
}

// ─── DB Upsert ───────────────────────────────────────────────────────────────

/**
 * Batch upsert classified invoices to DB.
 * Uses unnest for efficient multi-row insert (100 records/batch).
 */
async function batchUpsertInvoices(
  tenantId: string,
  invoices: ClassifiedInvoice[],
): Promise<number> {
  if (invoices.length === 0) return 0;

  const BATCH_SIZE = 100;
  let totalUpserted = 0;

  for (let i = 0; i < invoices.length; i += BATCH_SIZE) {
    const batch = invoices.slice(i, i + BATCH_SIZE);

    const ids: string[]       = [];
    const companyIds: string[] = [];
    const directions: string[] = [];
    const serials: string[]    = [];
    const invoiceNums: string[] = [];
    const issuedDates: string[] = [];
    const statuses: string[]   = [];
    const sellerTaxes: string[] = [];
    const sellerNames: string[] = [];
    const buyerTaxes: string[]  = [];
    const buyerNames: string[]  = [];
    const subtotals: string[]   = [];
    const vatAmounts: string[]  = [];
    const totals: string[]      = [];
    const vatRates: string[]    = [];
    const rawDatas: string[]    = [];
    const sources: string[]     = [];
    const gdtIds: string[]      = [];

    for (const inv of batch) {
      ids.push(uuidv4());
      companyIds.push(tenantId);
      directions.push(inv.direction === 'sold' ? 'output' : 'input');
      serials.push(inv.serial);
      invoiceNums.push(String(inv.invoiceNum));
      issuedDates.push(inv.issuedDate);
      statuses.push(inv.status);
      sellerTaxes.push(inv.sellerTax);
      sellerNames.push(inv.sellerName);
      buyerTaxes.push(inv.buyerTax);
      buyerNames.push(inv.buyerName);
      subtotals.push(String(inv.subtotal));
      vatAmounts.push(String(inv.vatAmount));
      totals.push(String(inv.total));
      vatRates.push(inv.vatRates.length > 0 ? String(inv.vatRates[0].rate) : '');
      rawDatas.push(JSON.stringify(inv.rawData));
      sources.push('gdt_bot');
      gdtIds.push(inv.id);
    }

    const result = await pool.query(
      `INSERT INTO invoices (
        id, company_id, direction, serial_number, invoice_number,
        invoice_date, status, seller_tax_code, seller_name,
        buyer_tax_code, buyer_name, total_before_tax, vat_amount,
        total_amount, vat_rate, raw_data, source, gdt_invoice_id, gdt_validated
      )
      SELECT * FROM unnest(
        $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[],
        $6::date[], $7::text[], $8::text[], $9::text[],
        $10::text[], $11::text[], $12::numeric[], $13::numeric[],
        $14::numeric[], $15::text[], $16::jsonb[], $17::text[], $18::text[],
        ARRAY_FILL(true, ARRAY[$19])::boolean[]
      )
      ON CONFLICT (company_id, serial_number, invoice_number, seller_tax_code, direction)
      DO UPDATE SET
        status = EXCLUDED.status,
        total_before_tax = EXCLUDED.total_before_tax,
        vat_amount = EXCLUDED.vat_amount,
        total_amount = EXCLUDED.total_amount,
        raw_data = EXCLUDED.raw_data,
        gdt_validated = true,
        updated_at = NOW()`,
      [
        ids, companyIds, directions, serials, invoiceNums,
        issuedDates, statuses, sellerTaxes, sellerNames,
        buyerTaxes, buyerNames, subtotals, vatAmounts,
        totals, vatRates, rawDatas, sources, gdtIds,
        batch.length,
      ],
    );

    totalUpserted += result.rowCount ?? 0;
  }

  return totalUpserted;
}

// ─── Main Processor ──────────────────────────────────────────────────────────

/**
 * Process a single sync job.
 *
 * Steps:
 *  1. (5%)   Load GdtConfig
 *  2. (8%)   Validate license + split into month windows
 *  3. (10%)  Acquire sync lock
 *  4. (12%)  Set dynamic timeout
 *  5. (15%)  Get session (cached or login)
 *  6. (18%)  Circuit breaker check
 *  7. (20%)  Proxy health check
 *  8. (25-85%) Process each month window
 *  9. (90%)  Warm cache
 * 10. (95%)  Update sync cursor
 * 11. (100%) Release lock, emit completion
 */
async function processSyncJob(job: Job<SyncJobData>): Promise<Record<string, unknown>> {
  const data = job.data;
  const { tenantId, encryptedCredentials, direction, fromDate, toDate, license, triggeredBy } = data;
  let lockToken: string | null = null;
  const lockDir = direction === 'both' ? 'both' : direction;

  try {
    // ── Step 1: Load config (5%) ──
    await job.updateProgress(5);
    const config = await gdtConfigRepo.loadActive();

    // ── Step 2: Validate & split (8%) ──
    await job.updateProgress(8);
    const directions: Array<'purchase' | 'sold'> = direction === 'both'
      ? ['sold', 'purchase']
      : [direction];

    const windows = splitIntoMonthWindows({ fromDate, toDate, license });
    logger.info('Month windows created', {
      tenantId,
      windowCount: windows.length,
      license,
      directions,
    });

    // ── Step 3: Acquire lock (10%) ──
    await job.updateProgress(10);
    lockToken = await acquireLock(tenantId, lockDir);
    if (!lockToken) {
      logger.info('Sync already in progress, skipping', { tenantId });
      return { skipped: true, reason: 'already_syncing' };
    }

    // ── Step 4: Dynamic timeout (12%) ──
    await job.updateProgress(12);
    if (data.volumeEstimate) {
      calculateJobTimeout(data.volumeEstimate);
    }

    // ── Step 5: Get/create session (15%) ──
    await job.updateProgress(15);
    const { username, password } = decryptCredentials(encryptedCredentials);

    // Check session cache
    let session = await sessionPool.get(tenantId);
    const isSessionReuse = !!session;

    if (!session) {
      // Check login cooldown
      const jobType = triggeredBy === 'cron' ? 'scheduled' : 'manual';
      const cooldown = await sessionPool.getCooldownMs(tenantId, jobType, false);
      if (cooldown > 0) {
        logger.info('Login cooldown active', { tenantId, cooldownSec: Math.round(cooldown / 1000) });
        // Re-queue after cooldown
        await releaseLock(tenantId, lockDir, lockToken);
        lockToken = null;
        throw new Error(`Login cooldown: ${Math.round(cooldown / 1000)}s remaining`);
      }

      // Get proxy
      const proxyUrl = proxyManager.next();

      // Login
      session = await loginGdt(tenantId, username, password, config, proxyUrl);
    }

    // ── Step 6: Circuit breaker (18%) ──
    await job.updateProgress(18);
    const cb = new GdtCircuitBreaker(redis, tenantId);
    const allowed = await cb.canRequest();
    if (!allowed) {
      logger.info('Circuit breaker OPEN, skipping', { tenantId });
      return { skipped: true, reason: 'circuit_breaker_open' };
    }

    // ── Step 7: Proxy health check (20%) ──
    await job.updateProgress(20);
    if (session.proxyUrl) {
      const health = await proxyManager.proxyHttpHealthCheck(session.proxyUrl);
      if (!health.ok) {
        logger.warn('Proxy health check failed, getting new proxy', {
          tenantId,
          error: health.error,
        });
        proxyManager.markFailed(session.proxyUrl);
        const newProxy = proxyManager.next();
        // Re-login with new proxy
        session = await loginGdt(tenantId, username, password, config, newProxy);
      }
    }

    // ── Step 8: Process month windows (25-85%) ──
    let totalClassified: ClassifiedInvoice[] = [];
    const progressPerWindow = 60 / (windows.length * directions.length);
    let progressCurrent = 25;

    for (const dir of directions) {
      for (const window of windows) {
        logger.info('Processing window', { tenantId, direction: dir, label: window.label });

        // 8a. Fetch /query/ list
        const queryEndpoint = dir === 'sold'
          ? config.api.endpoints.sold
          : config.api.endpoints.purchase;

        let queryItems: Record<string, unknown>[] = [];

        if (dir === 'purchase') {
          // Loop purchase filters
          for (const filter of config.api.query.purchaseFilters) {
            const searchParam = buildSearchParam(window, filter);
            const result = await fetchInvoiceList(session, config, queryEndpoint, searchParam, dir);
            queryItems.push(...result.items);
          }
        } else {
          const searchParam = buildSearchParam(window);
          const result = await fetchInvoiceList(session, config, queryEndpoint, searchParam, dir);
          queryItems = result.items;
        }

        // Classify /query/ results
        const queryClassified = classifyBatch(queryItems, config, dir, false);

        // 8b. Fetch /sco-query/ list
        const scoEndpoint = dir === 'sold'
          ? config.api.endpoints.soldSco
          : config.api.endpoints.purchaseSco;
        const scoSearchParam = buildSearchParam(window);
        const scoResult = await fetchInvoiceList(session, config, scoEndpoint, scoSearchParam, dir);
        const scoClassified = classifyBatch(scoResult.items, config, dir, true);

        // Merge all classified
        const windowInvoices = [...queryClassified.classified, ...scoClassified.classified];

        // 8c. Fetch details for invoices missing line items
        const needDetail = windowInvoices
          .filter(inv => !inv.hasLineItems)
          .map(inv => ({ id: inv.id, ...inv.rawData } as InvoiceListItem));

        if (needDetail.length > 0) {
          // Fetch details for /query/ items
          const queryNeedDetail = needDetail.filter(
            item => !scoClassified.classified.some(s => s.id === item.id),
          );
          const scoNeedDetail = needDetail.filter(
            item => scoClassified.classified.some(s => s.id === item.id),
          );

          if (queryNeedDetail.length > 0) {
            const details = await fetchDetailsWithConcurrency(
              session, queryNeedDetail, config, false, dir,
            );
            mergeDetails(windowInvoices, details, config, dir);
          }
          if (scoNeedDetail.length > 0) {
            const details = await fetchDetailsWithConcurrency(
              session, scoNeedDetail, config, true, dir,
            );
            mergeDetails(windowInvoices, details, config, dir);
          }
        }

        // 8d. Upsert to DB
        const upserted = await batchUpsertInvoices(tenantId, windowInvoices);
        logger.info('Window upserted', {
          tenantId,
          label: window.label,
          direction: dir,
          total: windowInvoices.length,
          upserted,
        });

        // 8e. Invalidate cache for this month
        const yyyymm = extractYYYYMM(window);
        if (yyyymm) {
          await invoiceCache.invalidateMonth(tenantId, dir, yyyymm);
        }

        totalClassified.push(...windowInvoices);

        // 8f. Adaptive delay between months
        const delayMs = adaptiveDelay.getDelay(queryEndpoint);
        await jitteredDelay(delayMs * 0.7, delayMs * 1.3);

        progressCurrent += progressPerWindow;
        await job.updateProgress(Math.min(85, Math.round(progressCurrent)));

        // Record success in circuit breaker
        await cb.recordSuccess();
      }
    }

    // Record sync activity
    await sessionPool.recordSyncAt(tenantId);

    // ── Step 9: Warm cache (90%) ──
    await job.updateProgress(90);
    await invoiceCache.warmCache(tenantId);

    // ── Step 10: Update sync cursor (95%) ──
    await job.updateProgress(95);
    await pool.query(
      `UPDATE companies SET last_sync_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [tenantId],
    );

    // ── Step 11: Complete (100%) ──
    await job.updateProgress(100);

    // Emit completion notification
    const summary = generateTaxSummary(totalClassified);
    await notifQueue.add('sync-completed', {
      companyId: tenantId,
      summary,
      triggeredBy,
    }).catch(() => {});

    logger.info('Sync completed', {
      tenantId,
      totalInvoices: totalClassified.length,
      usable: summary.usableCount,
      cancelled: summary.cancelledCount,
    });

    return {
      success: true,
      totalInvoices: totalClassified.length,
      summary,
    };

  } catch (err) {
    // Circuit breaker recording
    if (!(err instanceof UnrecoverableError)) {
      const cb = new GdtCircuitBreaker(redis, tenantId);
      await cb.recordFailure(err);
    }

    // Handle specific errors
    if (err instanceof UnrecoverableError) {
      // Deactivate bot credentials
      await pool.query(
        `UPDATE company_gdt_credentials SET is_active = false, updated_at = NOW() WHERE company_id = $1`,
        [tenantId],
      ).catch(() => {});
    }

    throw err;
  } finally {
    // Release lock
    if (lockToken) {
      await releaseLock(tenantId, lockDir, lockToken);
    }
  }
}

// ─── Detail Merge Helper ─────────────────────────────────────────────────────

function mergeDetails(
  invoices: ClassifiedInvoice[],
  details: Map<string, Record<string, unknown>>,
  config: GdtConfig,
  direction: 'purchase' | 'sold',
): void {
  for (const inv of invoices) {
    const detail = details.get(inv.id);
    if (!detail) continue;

    // Re-classify with detail data to get line items
    const hdhhdvu = detail['hdhhdvu'];
    if (Array.isArray(hdhhdvu) && hdhhdvu.length > 0) {
      inv.rawData['hdhhdvu'] = hdhhdvu;
      // Re-parse line items
      const items = hdhhdvu as Record<string, unknown>[];
      inv.lineItems = items.map((item, index) => {
        const stt = Number(item['stt'] ?? index + 1);
        const tsuat = Number(item['tsuat'] ?? 0);
        return {
          id: String(item['id'] ?? `item-${index}`),
          stt,
          name: String(item['ten'] ?? ''),
          unit: String(item['dvtinh'] ?? ''),
          qty: Number(item['sluong'] ?? 0),
          price: Number(item['dgia'] ?? 0),
          amount: Number(item['thtien'] ?? 0),
          vatRate: tsuat,
          vatRateLabel: String(item['ltsuat'] ?? (tsuat > 0 ? `${tsuat * 100}%` : 'KCT')),
          vatAmount: extractLineItemVat(item),
        };
      });
      inv.hasLineItems = true;
    }

    // Update VAT rates from detail if available
    const nestedPath = config.fields.vatRateNestedPath;
    if (typeof nestedPath === 'string' && detail[nestedPath]) {
      const nested = detail[nestedPath];
      if (Array.isArray(nested)) {
        inv.vatRates = nested.map((entry: Record<string, unknown>) => ({
          rate: String(entry['tsuat'] ?? entry['ltsuat'] ?? ''),
          amount: Number(entry['thtien'] ?? 0),
          taxAmount: Number(entry['tthue'] ?? 0),
        }));
      }
    }
  }
}

function extractLineItemVat(item: Record<string, unknown>): number {
  const ttkhac = item['ttkhac'];
  if (!Array.isArray(ttkhac)) return 0;
  for (const entry of ttkhac) {
    const fieldName = String((entry as Record<string, unknown>)['ttruong'] ?? '');
    if (fieldName === 'TThue' || fieldName === 'Tiền thuế') {
      return Number((entry as Record<string, unknown>)['dlieu'] ?? 0);
    }
  }
  return 0;
}

function extractYYYYMM(window: MonthWindow): string | null {
  // fromDate format: DD/MM/YYYYThh:mm:ss
  const match = window.fromDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}${match[2]}`;
}

function redactProxy(url: string): string {
  return url.replace(/:([^@:]+)@/, ':****@');
}

// ─── Workers ─────────────────────────────────────────────────────────────────

let highWorker: Worker<SyncJobData> | null = null;
let batchWorker: Worker<SyncJobData> | null = null;

/**
 * Start the crawl workers.
 */
export async function startWorkers(): Promise<void> {
  // Initialize proxy manager
  await proxyManager.init();

  highWorker = new Worker<SyncJobData>(
    'invoice-sync-high',
    async (job) => processSyncJob(job),
    {
      connection: REDIS_CONN,
      concurrency: 10,
    },
  );

  batchWorker = new Worker<SyncJobData>(
    'invoice-sync-batch',
    async (job) => processSyncJob(job),
    {
      connection: REDIS_CONN,
      concurrency: 3,
    },
  );

  // Error handlers
  for (const [name, worker] of [['high', highWorker], ['batch', batchWorker]] as const) {
    worker.on('completed', (job) => {
      logger.info(`[${name}] Job completed`, { jobId: job.id, tenantId: job.data.tenantId });
    });
    worker.on('failed', (job, err) => {
      logger.error(`[${name}] Job failed`, {
        jobId: job?.id,
        tenantId: job?.data.tenantId,
        error: err.message,
      });
    });
    worker.on('error', (err) => {
      logger.error(`[${name}] Worker error`, { error: err.message });
    });
  }

  logger.info('Crawl workers started', { high: 10, batch: 3 });
}

/**
 * Graceful shutdown: close workers, flush pending operations.
 */
export async function stopWorkers(): Promise<void> {
  logger.info('Shutting down crawl workers...');

  if (highWorker) await highWorker.close();
  if (batchWorker) await batchWorker.close();

  proxyManager.shutdown();
  await redis.quit();

  logger.info('Crawl workers stopped');
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  void stopWorkers().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  void stopWorkers().then(() => process.exit(0));
});
