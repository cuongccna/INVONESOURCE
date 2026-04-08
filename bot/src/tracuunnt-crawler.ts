/**
 * Tracuunnt Crawler — GHOST-02 companion (bot process)
 *
 * Crawls tracuunnt.gdt.gov.vn to look up Vietnamese company status (MST lookup).
 * Reuses existing bot infrastructure: proxyManager, proxy-tunnel, recipe system.
 *
 * Rate: 1 request / 3 seconds enforced by verification.worker.ts BullMQ limiter.
 * Anti-detection: sticky proxy per session, full browser headers, jitter delays.
 *
 * Fallback: masothue.com JSON API when GDT is unavailable.
 */
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { createTunnelAgent } from './proxy-tunnel';
import { proxyManager } from './proxy-manager';
import { getProfileForSession, getSessionHeaders } from './fingerprint-pool';
import { logger } from './logger';

export interface CompanyLookupResult {
  taxCode:           string;
  company_name?:     string;
  address?:          string;
  legal_rep?:        string;
  registered_date?:  string;   // raw string from page
  dissolved_date?:   string;
  mst_status:        'active' | 'suspended' | 'dissolved' | 'not_found' | 'error';
  source:            'gdt' | 'masothue';
  raw_data?:         Record<string, string>;
}

const GDT_TRACUUNNT_URL = 'http://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp';

/** Jitter between minMs and maxMs */
function jitter(minMs: number, maxMs: number): Promise<void> {
  return new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

export class TracuunntCrawler {
  private sessionId: string;
  private client: AxiosInstance;
  // FIX-3: lưu proxyUrl một lần, tránh gọi nextForSession hai lần khi proxy đã xoay
  private readonly proxyUrl: string | null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.proxyUrl  = proxyManager.nextForSession(sessionId);  // gọi một lần, lưu lại
    this.client    = this.buildClient();                       // dùng this.proxyUrl
  }

  private buildClient(): AxiosInstance {
    const profile  = getProfileForSession(this.sessionId);
    const headers  = getSessionHeaders(profile);

    // Ghi đè một số header cho form scraping
    headers['Content-Type']  = 'application/x-www-form-urlencoded';
    headers['Referer']       = 'http://tracuunnt.gdt.gov.vn/';
    headers['Origin']        = 'http://tracuunnt.gdt.gov.vn';

    const instance = axios.create({ timeout: 15_000, headers, maxRedirects: 3 });

    if (this.proxyUrl) {
      // tracuunnt.gdt.gov.vn là plain HTTP (port 80) — dùng plainHttp:true
      const agent = createTunnelAgent({ proxyUrl: this.proxyUrl, plainHttp: true });
      instance.defaults.httpAgent  = agent;
      instance.defaults.httpsAgent = agent;
    }

    return instance;
  }

  /** Tra cứu một mã số thuế. Thử 2 lần trước khi dùng fallback masothue. */
  async lookup(taxCode: string): Promise<CompanyLookupResult> {
    this.refreshProxyIfNeeded();

    const MAX_GDT_ATTEMPTS = 2;
    for (let attempt = 0; attempt < MAX_GDT_ATTEMPTS; attempt++) {
      await jitter(attempt === 0 ? 2_000 : 4_000, attempt === 0 ? 5_000 : 9_000);
      try {
        const response = await this.client.post(
          GDT_TRACUUNNT_URL,
          new URLSearchParams({ mst: taxCode.trim() }).toString(),
        );
        const html = response.data as string;
        // HTML rỗng hoặc quá ngắn = GDT đang throttle — thử lại
        if (!html || html.trim().length < 200) {
          logger.warn('[TracuunntCrawler] GDT trả về HTML rỗng — thử lại', {
            taxCode, attempt,
          });
          continue;
        }
        return this.parseResponse(taxCode, html);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[TracuunntCrawler] GDT lookup lỗi — thử lại', { taxCode, attempt, msg });
        if (attempt < MAX_GDT_ATTEMPTS - 1) continue;
      }
    }
    // Tất cả lần thử GDT thất bại → chuyển sang masothue
    logger.warn('[TracuunntCrawler] GDT lookup thất bại sau tất cả lần thử — chuyển masothue', { taxCode });
    return this.lookupMasothue(taxCode);
  }

  /** Làm mới proxy nếu slot đã xoay IP (TMProxy ~45 phút) — gọi trước mỗi lookup(). */
  refreshProxyIfNeeded(): void {
    const fresh = proxyManager.nextForSession(this.sessionId);
    if (fresh && fresh !== this.proxyUrl) {
      logger.info('[TracuunntCrawler] Proxy đã được làm mới', {
        sessionId: this.sessionId.slice(0, 8),
        old: (this.proxyUrl ?? 'none').replace(/:([^@:]+)@/, ':****@'),
        new: fresh.replace(/:([^@:]+)@/, ':****@'),
      });
      (this as unknown as { proxyUrl: string | null }).proxyUrl = fresh;
      this.client = this.buildClient();
    }
  }

  private parseResponse(taxCode: string, html: string): CompanyLookupResult {
    const $ = cheerio.load(html);
    const pageText = $.text();

    if (
      pageText.includes('Không tìm thấy') ||
      pageText.includes('không tồn tại') ||
      pageText.includes('Không có dữ liệu')
    ) {
      return { taxCode, mst_status: 'not_found', source: 'gdt' };
    }

    const rows: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $('table tr').each((_: number, row: any) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const key   = $(cells[0]).text().trim().replace(/:$/, '');
        const value = $(cells[1]).text().trim();
        if (key && value) rows[key] = value;
      }
    });

    const company_name    = rows['Tên người nộp thuế'] ?? rows['Tên đơn vị'] ?? '';
    const address         = rows['Địa chỉ'] ?? rows['Địa chỉ trụ sở'] ?? '';
    const legal_rep       = rows['Người đại diện pháp luật'] ?? '';
    const statusRaw       = rows['Tình trạng người nộp thuế'] ?? rows['Trạng thái'] ?? '';
    const registered_date = rows['Ngày bắt đầu hoạt động'] ?? rows['Ngày cấp MST'] ?? '';
    const dissolved_date  = rows['Ngày giải thể'] ?? rows['Ngày thu hồi'] ?? '';

    const mst_status = this.normalizeStatus(statusRaw);

    return {
      taxCode,
      company_name: company_name || undefined,
      address:      address      || undefined,
      legal_rep:    legal_rep    || undefined,
      registered_date: registered_date || undefined,
      dissolved_date:  mst_status === 'dissolved' ? (dissolved_date || undefined) : undefined,
      mst_status,
      source: 'gdt',
      raw_data: rows,
    };
  }

  private async lookupMasothue(taxCode: string): Promise<CompanyLookupResult> {
    // masothue.com là HTTPS fallback — cũng dùng proxy để tránh leak IP thật
    const masothueClient = axios.create({
      headers: { 'User-Agent': getSessionHeaders(getProfileForSession(this.sessionId))['User-Agent'] },
      timeout: 10_000,
      ...(this.proxyUrl ? {
        httpAgent:  createTunnelAgent({ proxyUrl: this.proxyUrl }),
        httpsAgent: createTunnelAgent({ proxyUrl: this.proxyUrl }),
      } : {}),
    });
    try {
      const res = await masothueClient.get(
        `https://masothue.com/Search/Party?s=${encodeURIComponent(taxCode)}`,
      );
      const raw: unknown = res.data;
      if (!raw || (Array.isArray(raw) && raw.length === 0)) {
        return { taxCode, mst_status: 'not_found', source: 'masothue' };
      }
      const company = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown>;
      return {
        taxCode,
        company_name:    String(company['name']      ?? company['ten']           ?? ''),
        address:         String(company['address']   ?? company['diaChi']        ?? ''),
        legal_rep:       String(company['legalRep']  ?? company['nguoiDaiDien']  ?? ''),
        registered_date: String(company['regDate']   ?? ''),
        mst_status:      (company['status'] === '00' || !company['status']) ? 'active' : 'dissolved',
        source:          'masothue',
        raw_data:        company as Record<string, string>,
      };
    } catch {
      return { taxCode, mst_status: 'error', source: 'masothue' };
    }
  }

  private normalizeStatus(raw: string): CompanyLookupResult['mst_status'] {
    const s = raw.toLowerCase();
    if (s.includes('đang hoạt động') || s.includes('active')) return 'active';
    if (s.includes('tạm ngừng'))                               return 'suspended';
    if (s.includes('giải thể') || s.includes('thu hồi'))       return 'dissolved';
    if (s === '') return 'not_found';
    return 'active';
  }
}
