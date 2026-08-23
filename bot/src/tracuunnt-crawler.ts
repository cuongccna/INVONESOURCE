/**
 * Tracuunnt Crawler — tra cứu trạng thái MST từ cổng chính thức của Cục Thuế
 *
 * Nguồn: https://tracuunnt.gdt.gov.vn/tcnnt/mstdn.jsp
 *
 * LUỒNG THỰC TẾ (đã kiểm chứng 2026-08 qua proxy VN + 2Captcha):
 *   1. GET  /tcnnt/mstdn.jsp            → nhận cookie JSESSIONID + TS…
 *   2. GET  /tcnnt/captcha.png?uid=     → ảnh PNG ~1.1KB gắn với session cookie
 *   3. 2Captcha giải ảnh (5 ký tự chữ+số thường)
 *   4. POST /tcnnt/mstdn.jsp  { cm, mst, fullname, address, cmt, captcha }
 *   5. Parse <table class="ta_border"> — 6 cột:
 *        STT | MST | Tên NNT | Địa chỉ | Cơ quan thuế quản lý | Trạng thái MST
 *      Kết quả gồm cả MST chi nhánh (dạng 0106870211-001).
 *
 * LƯU Ý KỸ THUẬT:
 *   - Cổng đã ép HTTPS: gọi HTTP port 80 chỉ nhận 302 → Location https://…
 *     (đây là lý do phiên bản cũ luôn thất bại và rơi về masothue).
 *   - Chain chứng chỉ của tracuunnt thiếu intermediate → phải dùng
 *     createTunnelAgent (rejectUnauthorized=false mặc định).
 *   - BẮT BUỘC đi qua proxy — không bao giờ gọi trực tiếp bằng IP server.
 *
 * Rate limit: 1 request / 3 giây do verification.worker.ts (BullMQ limiter) giữ.
 */
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { createTunnelAgent } from './proxy-tunnel';
import { staticProxyPool } from './static-proxy-pool';
import { proxyManager } from './proxy-manager';
import { pool } from './db';
import { getProfileForSession, getSessionHeaders } from './fingerprint-pool';
import { CaptchaService } from './captcha.service';
import { logger } from './logger';

/** Trạng thái MST đã chuẩn hoá — khớp CHECK constraint của company_verification_cache */
export type MstStatus =
  | 'active'                // NNT đang hoạt động
  | 'suspended'             // Tạm nghỉ kinh doanh có thời hạn
  | 'inactive_at_address'   // Không hoạt động tại địa chỉ đã đăng ký  ← rủi ro khấu trừ cao nhất
  | 'pending_dissolution'   // Đang làm thủ tục chấm dứt hiệu lực MST
  | 'dissolved'             // Đã chấm dứt hiệu lực MST / giải thể / phá sản
  | 'moved'                 // Chuyển địa điểm / chuyển cơ quan thuế quản lý
  | 'not_found'             // Không tìm thấy MST
  | 'error'                 // Lỗi kỹ thuật (proxy, captcha, timeout…)
  | 'pending';              // Chưa tra cứu

export interface CompanyBranch {
  taxCode:      string;
  company_name: string;
  address:      string;
  mst_status:   MstStatus;
}

export interface CompanyLookupResult {
  taxCode:         string;
  company_name?:   string;
  address?:        string;
  legal_rep?:      string;
  tax_authority?:  string;      // Cơ quan thuế quản lý
  mst_status:      MstStatus;
  mst_status_raw?: string;      // nguyên văn từ cổng thuế
  source:          'gdt' | 'error';
  error_code?:     'NO_PROXY' | 'NO_CAPTCHA_KEY' | 'CAPTCHA_FAILED' | 'NETWORK' | 'PARSE';
  error_message?:  string;
  branches?:       CompanyBranch[];
  check_ms?:       number;
  raw_data?:       Record<string, unknown>;
}

const HOST      = 'tracuunnt.gdt.gov.vn';
// http:// + cổng 443 rõ ràng — bắt buộc khi dùng createTunnelAgent (xem proxy-tunnel.ts)
const BASE_URL  = `http://${HOST}:443/tcnnt`;
const FORM_PATH = '/mstdn.jsp';
const CAPTCHA_PATH = '/captcha.png?uid=';

const MAX_CAPTCHA_ATTEMPTS = 4;   // mỗi lần giải lại captcha mới (2Captcha hoàn tiền khi sai)
const MAX_PROXY_TRIES      = 5;   // số proxy khác nhau thử trước khi bỏ cuộc
/**
 * Hard timeout cho một lượt tra (bao gồm cả thời gian 2Captcha giải ảnh).
 * BẮT BUỘC: proxy dân cư có thể "nuốt" TCP mà không bao giờ trả lời — khi đó
 * request không giữ handle nào, event loop rỗng và tiến trình thoát im lặng.
 */
const ATTEMPT_TIMEOUT_MS   = 45_000;

/** Jitter giữa minMs và maxMs — giả lập thao tác người dùng */
function jitter(minMs: number, maxMs: number): Promise<void> {
  return new Promise(r => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

function maskProxy(url: string): string {
  return url.replace(/:([^@:]+)@/, ':****@');
}

/**
 * Proxy vừa lỗi (407 / TCP timeout) bị "treo" trong khoảng COOLDOWN để vòng quét
 * kế tiếp không phí thời gian gọi lại đúng IP chết đó.
 */
const PROXY_COOLDOWN_MS = 10 * 60_000;
const proxyCooldown = new Map<string, number>();

function isProxyOnCooldown(url: string): boolean {
  const until = proxyCooldown.get(url);
  if (!until) return false;
  if (Date.now() > until) { proxyCooldown.delete(url); return false; }
  return true;
}

function coolDownProxy(url: string): void {
  proxyCooldown.set(url, Date.now() + PROXY_COOLDOWN_MS);
}

/** Chạy promise với hard timeout — giữ event loop sống bằng timer riêng */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hard timeout ${ms}ms: ${label}`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

export class TracuunntCrawler {
  private readonly sessionId: string;
  private readonly captcha: CaptchaService | null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    let captcha: CaptchaService | null = null;
    try {
      captcha = new CaptchaService();
    } catch {
      captcha = null;   // thiếu TWO_CAPTCHA_API_KEY → xử lý ở lookup()
    }
    this.captcha = captcha;
  }

  /**
   * Danh sách proxy khả dụng, ưu tiên IP còn khoẻ.
   *
   * Pool proxy dân cư có tỉ lệ chết cao (407 / TCP blackhole) nên thứ tự thử
   * quyết định tốc độ: proxy pass health-check gần nhất được thử trước, proxy
   * vừa lỗi bị bỏ qua trong 10 phút.
   */
  private async proxyCandidates(): Promise<string[]> {
    let urls: string[] = [];
    try {
      const { rows } = await pool.query<{ url: string }>(
        `SELECT protocol || '://' ||
                CASE WHEN username IS NULL OR username = '' THEN ''
                     ELSE username || ':' || COALESCE(password, '') || '@' END ||
                host || ':' || port AS url
           FROM static_proxies
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY (last_health_status IS TRUE) DESC,
                   (gdt_check_status IN ('ok','reachable')) DESC,
                   last_health_check DESC NULLS LAST`,
      );
      urls = rows.map(r => r.url);
    } catch (err) {
      logger.warn('[Tracuunnt] Không đọc được static_proxies — dùng pool mặc định', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (urls.length === 0) {
      try {
        urls = await staticProxyPool.listActiveUrls();
      } catch { /* bỏ qua — xử lý ở dưới */ }
    }
    if (urls.length === 0) {
      const envUrl = proxyManager.nextForSession(this.sessionId);
      if (envUrl) urls = [envUrl];
    }
    if (urls.length === 0) return [];

    const fresh = urls.filter(u => !isProxyOnCooldown(u));
    const usable = fresh.length > 0 ? fresh : urls;   // tất cả đang cooldown → vẫn phải thử

    // Xoay theo hash sessionId để 2 lần tra liên tiếp không dùng cùng 1 IP
    const offset = Math.abs(hashCode(this.sessionId + Date.now())) % usable.length;
    return [...usable.slice(offset), ...usable.slice(0, offset)];
  }

  private buildClient(proxyUrl: string): AxiosInstance {
    const profile = getProfileForSession(this.sessionId);
    const headers = getSessionHeaders(profile);
    headers['Referer'] = `https://${HOST}/tcnnt/mstdn.jsp`;
    headers['Origin']  = `https://${HOST}`;
    delete headers['Accept-Encoding'];   // tránh brotli lỗi trên tunnel socket

    const agent = createTunnelAgent({ proxyUrl });
    return axios.create({
      baseURL:        BASE_URL,
      timeout:        20_000,
      headers,
      httpAgent:      agent,
      maxRedirects:   0,
      validateStatus: () => true,
      proxy:          false,
    });
  }

  /**
   * Tra cứu một mã số thuế.
   *
   * QUY TẮC BẢO VỆ: không có proxy → dừng ngay, KHÔNG gọi trực tiếp bằng IP server.
   */
  async lookup(taxCode: string): Promise<CompanyLookupResult> {
    const started = Date.now();
    const mst = taxCode.trim();

    if (!this.captcha) {
      logger.error('[Tracuunnt] Thiếu TWO_CAPTCHA_API_KEY — bỏ qua chu kỳ tra cứu');
      return {
        taxCode: mst, mst_status: 'error', source: 'error',
        error_code: 'NO_CAPTCHA_KEY', error_message: 'Chưa cấu hình TWO_CAPTCHA_API_KEY',
      };
    }

    const proxies = await this.proxyCandidates();
    if (proxies.length === 0) {
      logger.error('[Tracuunnt] HARD STOP — không có proxy khả dụng, không tra cứu bằng IP trực tiếp', { taxCode: mst });
      return {
        taxCode: mst, mst_status: 'error', source: 'error',
        error_code: 'NO_PROXY', error_message: 'Không có proxy khả dụng',
      };
    }

    let lastError = 'unknown';
    const tries = Math.min(MAX_PROXY_TRIES, proxies.length);

    for (let p = 0; p < tries; p++) {
      const proxyUrl = proxies[p]!;
      const client   = this.buildClient(proxyUrl);

      for (let attempt = 0; attempt < MAX_CAPTCHA_ATTEMPTS; attempt++) {
        try {
          const result = await raceTimeout(
            this.attempt(client, mst),
            ATTEMPT_TIMEOUT_MS,
            `tracuunnt ${mst} qua ${maskProxy(proxyUrl)}`,
          );
          if (result) {
            result.check_ms = Date.now() - started;
            logger.info('[Tracuunnt] Tra cứu thành công', {
              taxCode: mst, status: result.mst_status,
              proxy: maskProxy(proxyUrl), ms: result.check_ms,
            });
            return result;
          }
          lastError = 'captcha sai hoặc trang trả về không có bảng kết quả';
          await jitter(1_500, 3_500);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          logger.warn('[Tracuunnt] Lần thử thất bại', {
            taxCode: mst, proxy: maskProxy(proxyUrl), attempt, error: lastError,
          });
          coolDownProxy(proxyUrl);
          break;   // lỗi mạng/proxy → đổi proxy khác thay vì lặp lại captcha
        }
      }
    }

    logger.error('[Tracuunnt] Tra cứu thất bại sau tất cả lần thử', { taxCode: mst, error: lastError });
    return {
      taxCode: mst, mst_status: 'error', source: 'error',
      error_code: lastError.includes('captcha') ? 'CAPTCHA_FAILED' : 'NETWORK',
      error_message: lastError,
      check_ms: Date.now() - started,
    };
  }

  /** Một lượt: lấy cookie → giải captcha → POST → parse. null nếu captcha sai. */
  private async attempt(client: AxiosInstance, mst: string): Promise<CompanyLookupResult | null> {
    // Cookie jar: WAF BigIP của cổng thuế xoay cookie TS… sau mỗi response.
    // Gửi lại cookie cũ sẽ bị coi là phiên khác → captcha luôn báo sai.
    const jar = new Map<string, string>();

    // 1. Lấy form + cookie phiên
    const form = await client.get(FORM_PATH);
    if (form.status !== 200) throw new Error(`GET form HTTP ${form.status}`);
    mergeCookies(jar, form.headers['set-cookie']);
    if (jar.size === 0) throw new Error('Không nhận được cookie phiên');

    await jitter(600, 1_600);   // người thật cần thời gian nhìn form

    // 2. Ảnh captcha (gắn với cookie phiên)
    const img = await client.get(CAPTCHA_PATH, {
      responseType: 'arraybuffer',
      headers: { Cookie: cookieHeader(jar) },
    });
    if (img.status !== 200) throw new Error(`GET captcha HTTP ${img.status}`);
    mergeCookies(jar, img.headers['set-cookie']);
    const imgBuf = Buffer.from(img.data as ArrayBuffer);
    if (imgBuf.length < 200) throw new Error('Ảnh captcha rỗng');

    // 3. Giải captcha
    // Captcha của cổng NNT: đúng 5 ký tự chữ+số, không phân biệt hoa thường
    const { text, captchaId } = await this.captcha!.solve(imgBuf.toString('base64'), {
      minLen: 5, maxLen: 5, numeric: 0, regsense: 0,
    });
    logger.debug('[Tracuunnt] Captcha đã giải', { captchaId, text });

    // 4. Gửi form
    const body = new URLSearchParams({
      cm: 'cm', mst, fullname: '', address: '', cmt: '', captcha: text.trim(),
    }).toString();

    const res = await client.post(FORM_PATH, body, {
      headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (res.status !== 200) throw new Error(`POST HTTP ${res.status}`);

    const html = String(res.data ?? '');
    logger.debug('[Tracuunnt] Đã POST form', {
      taxCode: mst, htmlLen: html.length, hasTable: html.includes('ta_border'),
    });
    const parsed = this.parseResult(mst, html);

    if (!parsed) {
      // Không có bảng kết quả → gần như chắc chắn captcha sai → báo hoàn tiền
      await this.captcha!.reportBad(captchaId).catch(() => undefined);
      return null;
    }
    return parsed;
  }

  /**
   * Parse bảng kết quả.
   * Trả về null nếu trang không chứa bảng (captcha sai / trang lỗi).
   */
  private parseResult(mst: string, html: string): CompanyLookupResult | null {
    const $ = cheerio.load(html);
    const table = $('table.ta_border').first();

    if (table.length === 0) {
      // Không tìm thấy MST là kết quả hợp lệ, khác với captcha sai
      const text = $.text().replace(/\s+/g, ' ');
      if (text.includes('Không tìm thấy người nộp thuế') || text.includes('không có dữ liệu')) {
        return { taxCode: mst, mst_status: 'not_found', source: 'gdt' };
      }
      // Ghi lại thông báo lỗi của cổng thuế để phân biệt captcha sai / bị chặn
      const notice = $('p[style*="red"], .error, .alert').text().replace(/\s+/g, ' ').trim();
      logger.debug('[Tracuunnt] Không có bảng kết quả', {
        taxCode: mst, notice: notice.slice(0, 200), len: html.length,
      });
      return null;   // gần như luôn là "Vui lòng nhập đúng mã xác nhận!" → giải captcha lại
    }

    const rows: CompanyBranch[] = [];
    const meta: Record<string, { tax_authority: string; status_raw: string }> = {};

    table.find('tr').each((_i, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 6) return;    // bỏ hàng tiêu đề <th>
      const rowTaxCode = $(cells[1]).text().trim();
      if (!rowTaxCode) return;
      const statusRaw = $(cells[5]).text().trim();
      rows.push({
        taxCode:      rowTaxCode,
        company_name: $(cells[2]).text().trim(),
        address:      $(cells[3]).text().trim().replace(/\s+/g, ' '),
        mst_status:   normalizeStatus(statusRaw),
      });
      meta[rowTaxCode] = {
        tax_authority: $(cells[4]).text().trim(),
        status_raw:    statusRaw,
      };
    });

    if (rows.length === 0) {
      return { taxCode: mst, mst_status: 'not_found', source: 'gdt' };
    }

    // Ưu tiên dòng khớp chính xác MST đã tra; nếu không có thì lấy dòng đầu
    const exact = rows.find(r => r.taxCode === mst) ?? rows[0]!;
    const m     = meta[exact.taxCode];

    return {
      taxCode:        mst,
      company_name:   exact.company_name || undefined,
      address:        exact.address      || undefined,
      tax_authority:  m?.tax_authority   || undefined,
      mst_status:     exact.mst_status,
      mst_status_raw: m?.status_raw      || undefined,
      source:         'gdt',
      // Tập đoàn lớn có thể có hàng trăm chi nhánh — chỉ giữ 50 dòng đầu cho gọn
      branches:       rows.filter(r => r.taxCode !== exact.taxCode).slice(0, 50),
      raw_data:       { rows, queried: mst },
    };
  }
}

/**
 * Chuẩn hoá "Trạng thái MST" của cổng thuế về enum nội bộ.
 * Nguyên văn các trạng thái do Cục Thuế dùng (Điều 4 TT105/2020).
 */
export function normalizeStatus(raw: string): MstStatus {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return 'pending';

  if (s.includes('không hoạt động tại địa chỉ')) return 'inactive_at_address';
  if (s.includes('tạm nghỉ') || s.includes('tạm ngừng'))              return 'suspended';
  if (s.includes('đang làm thủ tục') || s.includes('chờ làm thủ tục')) return 'pending_dissolution';
  if (s.includes('chuyển địa điểm') || s.includes('chuyển cơ quan'))   return 'moved';
  if (
    s.includes('chấm dứt hiệu lực') || s.includes('giải thể') ||
    s.includes('phá sản')           || s.includes('thu hồi')  ||
    s.includes('đã đóng mst')       || s.includes('ngừng hoạt động')
  ) return 'dissolved';
  if (s.includes('đang hoạt động')) return 'active';

  logger.warn('[Tracuunnt] Trạng thái MST chưa biết — mặc định pending', { raw });
  return 'pending';
}

/** Nạp Set-Cookie của một response vào cookie jar (ghi đè cookie trùng tên) */
function mergeCookies(jar: Map<string, string>, setCookie: unknown): void {
  if (!Array.isArray(setCookie)) return;
  for (const raw of setCookie) {
    const pair = String(raw).split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

/** Sinh header Cookie từ jar */
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}
