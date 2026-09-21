/**
 * CompanyVerificationService — trạng thái MST đối tác
 *
 * Backend KHÔNG bao giờ tự gọi ra cổng thuế: mọi request đi qua bot
 * (process invone-verify-worker) để bắt buộc dùng proxy + 2Captcha và
 * không làm lộ IP server. Backend chỉ:
 *   - đọc cache company_verification_cache
 *   - đẩy job vào BullMQ queue 'company-verification'
 *
 * Chiến lược hiển thị: stale-while-revalidate — luôn trả dữ liệu đang có
 * (kèm cờ is_stale) và song song đẩy job làm mới, để màn hình hoá đơn không
 * bao giờ phải chờ mạng cổng thuế.
 */
import { pool } from '../db/pool';

export type MstStatus =
  | 'active' | 'suspended' | 'inactive_at_address' | 'pending_dissolution'
  | 'dissolved' | 'moved' | 'not_found' | 'error' | 'pending';

export interface CompanyInfo {
  taxCode:          string;
  company_name?:    string;
  company_name_en?: string;
  legal_rep?:       string;
  address?:         string;
  province_code?:   string;
  tax_authority?:   string;
  registered_date?: Date;
  dissolved_date?:  Date;
  mst_status:       MstStatus;
  mst_status_raw?:  string;
  business_type?:   string;
  industry_code?:   string;
  source:           'gdt' | 'masothue' | 'cache' | 'error';
  raw_data?:        unknown;
  verified_at:      Date;
  expires_at?:      Date;
  is_stale?:        boolean;
}

const VN_TAX_CODE_RE = /^\d{10}(-\d{3})?$/;
const QUEUE_NAME     = 'company-verification';
/** Cửa sổ chống trùng job tra cứu (ms) */
const DEDUPE_WINDOW_MS = 10 * 60_000;

/** Nhãn tiếng Việt dùng chung cho API + UI */
export const MST_STATUS_LABEL: Record<MstStatus, string> = {
  active:              'Đang hoạt động',
  suspended:           'Tạm ngừng kinh doanh',
  inactive_at_address: 'Không hoạt động tại địa chỉ đăng ký',
  pending_dissolution: 'Đang làm thủ tục đóng MST',
  dissolved:           'Đã đóng MST / giải thể',
  moved:               'Chuyển địa điểm',
  not_found:           'Không tìm thấy MST',
  error:               'Chưa tra cứu được',
  pending:             'Đang tra cứu…',
};

/** Mức rủi ro khấu trừ VAT tương ứng từng trạng thái */
export const MST_STATUS_RISK: Record<MstStatus, 'none' | 'low' | 'medium' | 'high' | 'critical'> = {
  active:              'none',
  moved:               'low',
  suspended:           'high',
  pending_dissolution: 'high',
  inactive_at_address: 'critical',
  dissolved:           'critical',
  not_found:           'critical',
  error:               'low',
  pending:             'low',
};

interface CacheRow {
  tax_code:        string;
  company_name:    string | null;
  company_name_en: string | null;
  legal_rep:       string | null;
  address:         string | null;
  province_code:   string | null;
  tax_authority:   string | null;
  registered_date: Date | null;
  dissolved_date:  Date | null;
  mst_status:      MstStatus;
  mst_status_raw:  string | null;
  business_type:   string | null;
  industry_code:   string | null;
  source:          string | null;
  raw_data:        unknown;
  verified_at:     Date;
  expires_at:      Date;
}

const SELECT_COLS = `
  tax_code, company_name, company_name_en, legal_rep, address, province_code,
  tax_authority, registered_date, dissolved_date, mst_status, mst_status_raw,
  business_type, industry_code, source, raw_data, verified_at, expires_at`;

export class CompanyVerificationService {

  /**
   * Trạng thái một MST. Luôn trả ngay dữ liệu cache (kể cả đã hết hạn),
   * và đẩy job làm mới nếu hết hạn hoặc forceRefresh.
   */
  async verify(taxCode: string, forceRefresh = false, companyId?: string): Promise<CompanyInfo> {
    const mst = taxCode.trim();
    if (!VN_TAX_CODE_RE.test(mst)) {
      return { taxCode: mst, mst_status: 'not_found', source: 'gdt', verified_at: new Date() };
    }

    const cached = await this.getFromCache(mst, true);

    if (!cached || cached.is_stale || forceRefresh) {
      await this.enqueue([mst], companyId, forceRefresh);
    }

    return cached ?? {
      taxCode: mst, mst_status: 'pending', source: 'cache',
      verified_at: new Date(), is_stale: true,
    };
  }

  /**
   * Tra cache hàng loạt — dùng cho danh sách hoá đơn (1 query cho cả trang).
   * Trả về Map<taxCode, CompanyInfo>; MST chưa có trong cache sẽ không có key.
   */
  async getStatusMap(taxCodes: string[]): Promise<Map<string, CompanyInfo>> {
    const valid = [...new Set(taxCodes.filter(t => t && VN_TAX_CODE_RE.test(t.trim())).map(t => t.trim()))];
    const map = new Map<string, CompanyInfo>();
    if (valid.length === 0) return map;

    const { rows } = await pool.query<CacheRow>(
      `SELECT ${SELECT_COLS} FROM company_verification_cache WHERE tax_code = ANY($1::text[])`,
      [valid],
    );
    for (const row of rows) map.set(row.tax_code, toInfo(row));
    return map;
  }

  /**
   * Đẩy job tra cứu. jobId = mã số thuế ⇒ BullMQ tự chống trùng, nhiều user
   * mở cùng lúc cũng chỉ tạo 1 job.
   */
  async enqueue(taxCodes: string[], companyId?: string, forceRefresh = false): Promise<number> {
    const valid = [...new Set(taxCodes.filter(t => t && VN_TAX_CODE_RE.test(t.trim())).map(t => t.trim()))];
    if (valid.length === 0) return 0;

    try {
      const { Queue } = await import('bullmq');
      const { env }   = await import('../config/env');
      const queue = new Queue(QUEUE_NAME, { connection: { url: env.REDIS_URL } as never });
      try {
        await queue.addBulk(valid.map(taxCode => ({
          name: 'verify-single',
          data: {
            type: 'verify-single' as const,
            taxCode,
            companyId: companyId ?? '00000000-0000-0000-0000-000000000000',
            forceRefresh,
          },
          opts: {
            // Chống trùng theo cửa sổ 10 phút: nhiều user mở cùng lúc chỉ tạo 1 job,
            // nhưng lần tra sau (cửa sổ khác) vẫn đẩy được job mới.
            // Ràng buộc jobId của BullMQ: không được toàn chữ số và không chứa dấu ':'
            // ⇒ dùng tiền tố 'mst-' và phân tách bằng '-'.
            jobId: forceRefresh
              ? `mst-${taxCode}-force-${Date.now()}`
              : `mst-${taxCode}-${Math.floor(Date.now() / DEDUPE_WINDOW_MS)}`,
            removeOnComplete: 500,
            removeOnFail: 200,
          },
        })));
      } finally {
        await queue.close();
      }
      return valid.length;
    } catch (err) {
      console.error('[CompanyVerify] Không đẩy được job tra cứu:', err);
      return 0;
    }
  }

  /**
   * Dùng cho danh sách hoá đơn: lấy trạng thái các MST đang hiển thị và
   * âm thầm đẩy job cho những MST thiếu / hết hạn (giới hạn để khỏi đốt captcha).
   */
  async getStatusMapAndRefresh(
    taxCodes: string[],
    companyId?: string,
    maxEnqueue = 25,
  ): Promise<Map<string, CompanyInfo>> {
    const map = await this.getStatusMap(taxCodes);
    const needRefresh = [...new Set(taxCodes.filter(t => t && VN_TAX_CODE_RE.test(t.trim())).map(t => t.trim()))]
      .filter(t => {
        const info = map.get(t);
        return !info || info.is_stale;
      })
      .slice(0, maxEnqueue);

    if (needRefresh.length > 0) {
      void this.enqueue(needRefresh, companyId).catch(() => undefined);
    }
    return map;
  }

  /** So khớp tên công ty trên HĐ với tên đăng ký thuế (0–1) */
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

  /**
   * Cross-check DKKD (Bộ KH&ĐT) — tắt vĩnh viễn ở backend để không lộ IP server.
   * Nếu cần, phải triển khai trong bot với proxy.
   */
  async lookupFromDkkd(_taxCode: string): Promise<'active' | 'dissolved' | 'suspended' | 'not_found' | null> {
    return null;
  }

  // ─── DB helpers ─────────────────────────────────────────────────────────────

  /**
   * @param includeStale true → trả cả bản ghi hết hạn (kèm is_stale=true)
   */
  async getFromCache(taxCode: string, includeStale = false): Promise<CompanyInfo | null> {
    const { rows } = await pool.query<CacheRow>(
      `SELECT ${SELECT_COLS} FROM company_verification_cache WHERE tax_code = $1`,
      [taxCode.trim()],
    );
    const row = rows[0];
    if (!row) return null;
    const info = toInfo(row);
    if (info.is_stale && !includeStale) return null;
    return info;
  }
}

function toInfo(row: CacheRow): CompanyInfo {
  return {
    taxCode:         row.tax_code,
    company_name:    row.company_name    ?? undefined,
    company_name_en: row.company_name_en ?? undefined,
    legal_rep:       row.legal_rep       ?? undefined,
    address:         row.address         ?? undefined,
    province_code:   row.province_code   ?? undefined,
    tax_authority:   row.tax_authority   ?? undefined,
    registered_date: row.registered_date ?? undefined,
    dissolved_date:  row.dissolved_date  ?? undefined,
    mst_status:      row.mst_status,
    mst_status_raw:  row.mst_status_raw  ?? undefined,
    business_type:   row.business_type   ?? undefined,
    industry_code:   row.industry_code   ?? undefined,
    source:          'cache',
    raw_data:        row.raw_data,
    verified_at:     row.verified_at,
    expires_at:      row.expires_at,
    is_stale:        new Date(row.expires_at) < new Date(),
  };
}

export const companyVerificationService = new CompanyVerificationService();
