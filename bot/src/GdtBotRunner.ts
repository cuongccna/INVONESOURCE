/**
 * BOT-02 — GDT Bot Runner
 *
 * Uses Playwright to crawl hoadondientu.gdt.gov.vn after authentication.
 * Exports XML (preferred) or falls back to Excel download.
 *
 * NOTE: Portal selectors and URLs marked [TODO: inspect portal] must be
 * verified against the live GDT portal before use.
 * Use browser DevTools → Network tab while manually navigating the portal
 * to find the correct filter form URLs and download links.
 */
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { GdtSession } from './gdt-auth.service';
import { GdtXmlParser, RawInvoice } from './parsers/GdtXmlParser';
import { GdtExcelParser } from './parsers/GdtExcelParser';
import { logger } from './logger';

const GDT_BASE = 'https://hoadondientu.gdt.gov.vn';

// [TODO: inspect portal] — replace with actual portal paths after DevTools inspection
const PATHS = {
  outputInvoices: '/tra-cuu-hoa-don/hoa-don-ban-ra',
  inputInvoices:  '/tra-cuu-hoa-don/hoa-don-mua-vao',
  exportXml:      '/tra-cuu-hoa-don/xuat-xml',
  exportExcel:    '/tra-cuu-hoa-don/xuat-excel',
};

// [TODO: inspect portal] — adjust selector names after portal inspection
const SEL = {
  fromDateInput:  'input[name="tuNgay"], #fromDate, input[placeholder*="Từ ngày"]',
  toDateInput:    'input[name="denNgay"], #toDate, input[placeholder*="Đến ngày"]',
  searchButton:   'button.btn-search, button[type="submit"]:has-text("Tìm kiếm")',
  exportXmlBtn:   'button:has-text("Xuất XML"), a:has-text("Tải XML")',
  exportExcelBtn: 'button:has-text("Xuất Excel"), a:has-text("Tải Excel")',
  loadingSpinner: '.loading, .spinner, [class*="loading"]',
};

export class GdtBotRunner {
  private session:   GdtSession;
  private companyId: string;

  constructor(session: GdtSession, companyId: string) {
    this.session   = session;
    this.companyId = companyId;
  }

  /**
   * Crawl invoices for given direction.
   * Returns raw invoice records ready for DB upsert.
   */
  async crawlInvoices(
    direction: 'output' | 'input',
    params: { fromDate: Date; toDate: Date }
  ): Promise<RawInvoice[]> {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

    try {
      const context = await this._restoreSession(browser);
      const page    = await context.newPage();

      const path = direction === 'output' ? PATHS.outputInvoices : PATHS.inputInvoices;
      await page.goto(`${GDT_BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // Fill date range
      const from = this._formatDate(params.fromDate);
      const to   = this._formatDate(params.toDate);

      await _fillDate(page, SEL.fromDateInput, from);
      await _fillDate(page, SEL.toDateInput, to);

      // Click search
      await page.click(SEL.searchButton);
      await _waitForLoad(page);

      // Try XML export first, fall back to Excel
      let invoices: RawInvoice[];
      try {
        invoices = await this._exportXml(page, context, direction);
      } catch (xmlErr) {
        logger.warn('[BotRunner] XML export failed, trying Excel', { xmlErr });
        invoices = await this._exportExcel(page, context, direction);
      }

      logger.info('[BotRunner] Crawled invoices', {
        direction, count: invoices.length,
        from, to, companyId: this.companyId,
      });

      await browser.close();
      return invoices;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _restoreSession(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({
      storageState: this.session.contextState as import('playwright').BrowserContextOptions['storageState'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
               + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
      // Tell GDT server we support compression → responses ~80% smaller,
      // reduces bandwidth on proxy and VPS, and compression-aware traffic
      // is far less likely to be rate-limited or blocked by GDT network engineers.
      extraHTTPHeaders: {
        'Accept-Encoding': 'gzip, deflate, br',
      },
    });
  }

  private async _exportXml(
    page: Page,
    context: BrowserContext,
    direction: 'output' | 'input'
  ): Promise<RawInvoice[]> {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }) as Promise<import('playwright').Download>,
      page.click(SEL.exportXmlBtn),
    ]);

    const buffer = await _downloadToBuffer(download);
    const parser = new GdtXmlParser();
    return parser.parse(buffer, direction);
  }

  private async _exportExcel(
    page: Page,
    context: BrowserContext,
    direction: 'output' | 'input'
  ): Promise<RawInvoice[]> {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }) as Promise<import('playwright').Download>,
      page.click(SEL.exportExcelBtn),
    ]);

    const buffer = await _downloadToBuffer(download);
    const parser = new GdtExcelParser();
    return parser.parse(buffer, direction);
  }

  /** Format date as DD/MM/YYYY for GDT portal inputs */
  private _formatDate(d: Date): string {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  }
}

// ── Util helpers ──────────────────────────────────────────────────────────────

async function _fillDate(page: Page, selector: string, value: string): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
    await page.fill(selector, value);
  } catch {
    logger.warn('[BotRunner] Could not fill date field', { selector, value });
  }
}

async function _waitForLoad(page: Page): Promise<void> {
  try {
    // Wait for spinner to disappear
    await page.waitForSelector(SEL.loadingSpinner, { state: 'hidden', timeout: 30_000 });
  } catch {
    // No spinner, continue
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => { /* ok */ });
  }
}

async function _downloadToBuffer(download: import('playwright').Download): Promise<Buffer> {
  const d = download;
  const stream = await d.createReadStream();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
