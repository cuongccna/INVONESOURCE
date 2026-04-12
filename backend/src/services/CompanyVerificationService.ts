/**
 * CompanyVerificationService — GHOST-02
 *
 * Looks up Vietnamese company info from official government sources to detect
 * ghost/inactive companies that could invalidate input VAT deductions.
 *
 * Priority: cache → tracuunnt.gdt.gov.vn (HTTP form POST) → masothue.com (fallback)
 *
 * Cache TTL: 30 days (company status rarely changes)
 * Rate limit: enforced by verification.worker.ts in the bot process.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Element as DomElement } from 'domhandler';
import { pool } from '../db/pool';
import { tmproxyHelper } from './TmproxyHelper';

export interface CompanyInfo {
  taxCode:          string;
  company_name?:    string;
  company_name_en?: string;
  legal_rep?:       string;
  address?:         string;
  province_code?:   string;
  registered_date?: Date;
  dissolved_date?:  Date;
  mst_status:       'active' | 'suspended' | 'dissolved' | 'not_found' | 'error' | 'pending';
  business_type?:   string;
  industry_code?:   string;
  source:           'gdt' | 'masothue' | 'cache';
  raw_data?:        unknown;
  verified_at:      Date;
}

const GDT_LOOKUP_URL = 'http://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp';
const SCRAPE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer':         'http://tracuunnt.gdt.gov.vn/',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type':    'application/x-www-form-urlencoded',
};

const VN_TAX_CODE_RE = /^\d{10}(-\d{3})?$/;

export class CompanyVerificationService {

  /**
   * Returns company info, checking the 30-day cache first.
   * If forceRefresh=true, bypasses cache and re-fetches.
   */
  async verify(taxCode: string, forceRefresh = false): Promise<CompanyInfo> {
    if (!VN_TAX_CODE_RE.test(taxCode.trim())) {
      return { taxCode, mst_status: 'not_found', source: 'gdt', verified_at: new Date() };
    }

    if (!forceRefresh) {
      const cached = await this.getFromCache(taxCode);
      if (cached) return cached;
    }

    const info = await this.lookupFromGdt(taxCode);
    await this.saveToCache(info);
    return info;
  }

  /** Lookup company status via GDT tracuunnt HTML scrape */
  private async lookupFromGdt(taxCode: string): Promise<CompanyInfo> {
    try {
      // Use residential proxy when TMPROXY_API_KEYS is configured to avoid
      // the server's real IP being blocked by GDT rate limiting.
      const proxy = await tmproxyHelper.getProxyConfig();
      const response = await axios.post(
        GDT_LOOKUP_URL,
        new URLSearchParams({ mst: taxCode.trim() }).toString(),
        { headers: SCRAPE_HEADERS, timeout: 15_000, ...(proxy ? { proxy } : {}) },
      );

      const $ = cheerio.load(response.data as string);
      const pageText = $.text();

      if (
        pageText.includes('Không tìm thấy') ||
        pageText.includes('không tồn tại') ||
        pageText.includes('Không có dữ liệu')
      ) {
        return { taxCode, mst_status: 'not_found', source: 'gdt', verified_at: new Date() };
      }

      // Parse response table (structure: <td>Nhãn:</td><td>Giá trị</td>)
      const rows: Record<string, string> = {};
      $('table tr').each((_: number, row: DomElement) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const key   = $(cells[0]).text().trim().replace(/:$/, '');
          const value = $(cells[1]).text().trim();
          if (key && value) rows[key] = value;
        }
      });

      const name      = rows['Tên người nộp thuế'] ?? rows['Tên đơn vị'] ?? '';
      const address   = rows['Địa chỉ'] ?? rows['Địa chỉ trụ sở'] ?? '';
      const statusRaw = rows['Tình trạng người nộp thuế'] ?? rows['Trạng thái'] ?? '';
      const regDate   = rows['Ngày bắt đầu hoạt động'] ?? rows['Ngày cấp MST'] ?? '';
      const dissDate  = rows['Ngày giải thể'] ?? rows['Ngày thu hồi'] ?? '';

      const mst_status = this.normalizeStatus(statusRaw);

      return {
        taxCode,
        company_name:    name,
        address,
        mst_status,
        registered_date: this.parseVnDate(regDate),
        dissolved_date:  mst_status === 'dissolved' ? this.parseVnDate(dissDate) : undefined,
        source:          'gdt',
        raw_data:        rows,
        verified_at:     new Date(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[CompanyVerify] GDT lookup failed for ${taxCode}: ${msg} — falling back to masothue`);
      return this.lookupFromMasothue(taxCode);
    }
  }

  /** Fallback: masothue.com aggregator */
  private async lookupFromMasothue(taxCode: string): Promise<CompanyInfo> {
    try {
      const res = await axios.get(
        `https://masothue.com/Search/Party?s=${encodeURIComponent(taxCode)}`,
        { headers: { 'User-Agent': SCRAPE_HEADERS['User-Agent'], Accept: 'application/json' }, timeout: 10_000 },
      );
      const raw: unknown = res.data;
      if (!raw || (Array.isArray(raw) && raw.length === 0)) {
        return { taxCode, mst_status: 'not_found', source: 'masothue', verified_at: new Date() };
      }
      const company = Array.isArray(raw) ? raw[0] : raw as Record<string, unknown>;
      return {
        taxCode,
        company_name:    String(company['name'] ?? company['ten'] ?? ''),
        address:         String(company['address'] ?? company['diaChi'] ?? ''),
        legal_rep:       String(company['legalRep'] ?? company['nguoiDaiDien'] ?? ''),
        mst_status:      (company['status'] === '00' || !company['status']) ? 'active' : 'dissolved',
        registered_date: this.parseVnDate(String(company['regDate'] ?? '')),
        source:          'masothue',
        raw_data:        company,
        verified_at:     new Date(),
      };
    } catch {
      return { taxCode, mst_status: 'error', source: 'masothue', verified_at: new Date() };
    }
  }

  /**
   * Compute word-overlap similarity between two Vietnamese company names.
   * Returns 0–1 (1 = identical, 0 = no overlap).
   * Normalises prefixes like "Công ty TNHH", "Cổ phần", "CP"…
   */
  compareNames(invoiceName: string, gdtName: string): number {
    const normalize = (s: string): string[] =>
      s
        .toLowerCase()
        .replace(/công ty|tnhh|cổ phần|cp\b|co\.|ltd\.?|joint stock|hd\b|,|\./gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(w => w.length > 2);

    const a = normalize(invoiceName);
    const b = normalize(gdtName);
    if (a.length === 0 || b.length === 0) return 0;
    const common = a.filter(w => b.includes(w)).length;
    return common / Math.max(a.length, b.length);
  }

  // ─── DB helpers ─────────────────────────────────────────────────────────────

  async getFromCache(taxCode: string): Promise<CompanyInfo | null> {
    const res = await pool.query<CompanyInfo & { expires_at: Date }>(
      `SELECT tax_code AS "taxCode", company_name, company_name_en, legal_rep, address,
              province_code, registered_date, dissolved_date, mst_status,
              business_type, industry_code, source, raw_data, verified_at, expires_at
       FROM company_verification_cache WHERE tax_code = $1`,
      [taxCode],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) return null; // expired
    return { ...row, source: 'cache' };
  }

  async saveToCache(info: CompanyInfo): Promise<void> {
    await pool.query(
      `INSERT INTO company_verification_cache
         (tax_code, company_name, company_name_en, legal_rep, address,
          province_code, registered_date, dissolved_date, mst_status,
          business_type, industry_code, source, raw_data, verified_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW()+INTERVAL '30 days')
       ON CONFLICT (tax_code) DO UPDATE SET
         company_name    = EXCLUDED.company_name,
         company_name_en = EXCLUDED.company_name_en,
         legal_rep       = EXCLUDED.legal_rep,
         address         = EXCLUDED.address,
         mst_status      = EXCLUDED.mst_status,
         registered_date = EXCLUDED.registered_date,
         dissolved_date  = EXCLUDED.dissolved_date,
         source          = EXCLUDED.source,
         raw_data        = EXCLUDED.raw_data,
         verified_at     = NOW(),
         expires_at      = NOW() + INTERVAL '30 days'`,
      [
        info.taxCode, info.company_name ?? null, info.company_name_en ?? null,
        info.legal_rep ?? null, info.address ?? null, info.province_code ?? null,
        info.registered_date ?? null, info.dissolved_date ?? null, info.mst_status,
        info.business_type ?? null, info.industry_code ?? null, info.source,
        info.raw_data ? JSON.stringify(info.raw_data) : null,
      ],
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private normalizeStatus(raw: string): CompanyInfo['mst_status'] {
    const s = raw.toLowerCase();
    if (s.includes('đang hoạt động') || s.includes('active')) return 'active';
    if (s.includes('tạm ngừng'))                               return 'suspended';
    if (s.includes('giải thể') || s.includes('thu hồi') || s.includes('chấm dứt')) return 'dissolved';
    if (s === '') return 'pending';
    return 'active'; // default if status text is unrecognised
  }

  private parseVnDate(str: string): Date | undefined {
    if (!str) return undefined;
    const m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (!m) return undefined;
    return new Date(`${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`);
  }
}

export const companyVerificationService = new CompanyVerificationService();
