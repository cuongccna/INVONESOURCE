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

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.client = this.buildClient();
  }

  private buildClient(): AxiosInstance {
    const proxyUrl = proxyManager.nextForSession(this.sessionId);
    const profile  = getProfileForSession(this.sessionId);
    const headers  = getSessionHeaders(profile);

    // Override some headers for form-based scraping
    headers['Content-Type']  = 'application/x-www-form-urlencoded';
    headers['Referer']       = 'http://tracuunnt.gdt.gov.vn/';
    headers['Origin']        = 'http://tracuunnt.gdt.gov.vn';

    const instance = axios.create({
      timeout: 15_000,
      headers,
      maxRedirects: 3,
    });

    if (proxyUrl) {
      const agent = createTunnelAgent({ proxyUrl });
      instance.defaults.httpAgent  = agent;
      instance.defaults.httpsAgent = agent;
    }

    return instance;
  }

  /** Look up a single tax code. Returns parsed company info. */
  async lookup(taxCode: string): Promise<CompanyLookupResult> {
    // Human-like jitter: 2–5 seconds before request
    await jitter(2_000, 5_000);

    try {
      const response = await this.client.post(
        GDT_TRACUUNNT_URL,
        new URLSearchParams({ mst: taxCode.trim() }).toString(),
      );
      return this.parseResponse(taxCode, response.data as string);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[TracuunntCrawler] GDT lookup failed for ${taxCode}: ${msg} — falling back to masothue`);
      return this.lookupMasothue(taxCode);
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
    $('table tr').each((_, row) => {
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
    try {
      const res = await axios.get(
        `https://masothue.com/Search/Party?s=${encodeURIComponent(taxCode)}`,
        {
          headers: { 'User-Agent': getSessionHeaders(getProfileForSession(this.sessionId))['User-Agent'] },
          timeout: 10_000,
        },
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
