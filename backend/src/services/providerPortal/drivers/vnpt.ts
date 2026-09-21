/**
 * Nền tảng hoá đơn điện tử VNPT (VNPT-Invoice / "Cổng thông tin hóa đơn").
 *
 * ĐIỂM KHÁC BIỆT QUAN TRỌNG: VNPT cấp cho MỖI TÀI KHOẢN HĐĐT một cổng tra cứu riêng —
 * địa chỉ nằm ngay trong thư/hoá đơn người bán gửi, ví dụ:
 *
 *     Ðể xem chi tiết hóa đơn, Quý khách hàng vui lòng truy cập địa chỉ trang portal
 *     tra cứu hóa đơn: https://1800546671-tt78.vnpt-invoice.com.vn
 *     - Mã tra cứu hóa đơn: N2026V1784027764590108530K017313
 *
 * Vì vậy driver KHÔNG gắn cứng máy chủ: gốc địa chỉ lấy từ link của chính hoá đơn
 * (invoices.provider_lookup_url — đọc từ XML hoặc do người dùng dán vào), chỉ khi hoá đơn
 * không có link mới rơi về lookup_api_base trong danh bạ. Cùng cách này áp dụng được cho
 * mọi nhà cung cấp đi theo hướng "một tài khoản một tên miền".
 *
 * LUỒNG (đã gọi thật vào cổng 1800546671-tt78.vnpt-invoice.com.vn ngày 30/08/2026):
 *   1. GET  /HomeNoLogin/SearchByFkey
 *        → cookie ASP.NET_SessionId + __RequestVerificationToken, và trường ẩn cùng tên
 *          trong form (ASP.NET MVC bắt buộc khớp cặp cookie ↔ trường ẩn)
 *   2. GET  /Captcha/Show                → ảnh PNG của đúng phiên đó
 *   3. POST /HomeNoLogin/SearchByFkey    __RequestVerificationToken, isHomepage=true,
 *                                        strFkey=<mã tra cứu>, captch=<mã xác thực>
 *        → 302 về "/"  = mã xác thực sai / không tra được
 *        → 200 HTML    = trang kết quả, hoá đơn dựng trong <div id="ReportViewInv">
 *   4. Lấy `checkCode` trong trang kết quả (trang gọi download('<checkCode>')) rồi:
 *        GET  /Invoice/Download?checkCode=…      → file bản gốc
 *        POST /HomeNoLogin/ajxPreview/  checkCode=… → { str: "<html bản thể hiện>" }
 *
 * ĐÃ KIỂM CHỨNG ĐẾN ĐÂU: các bước 1–3 và hình dạng lỗi đã gọi thật (mã xác thực sai → 302;
 * ajxPreview với chuỗi sai → "Chuỗi tra cứu không đúng định dạng!"; /Invoice/Download với
 * chuỗi sai → thân rỗng). Nhánh THÀNH CÔNG chưa chạy được vì phải có mã xác thực do người
 * dùng nhập, nên driver để status 'unverified' và bọc mọi bước bằng đường lui: không lấy
 * được file thì dựng lại bản thể hiện trong trang kết quả.
 *
 * KHÔNG tự giải mã xác thực: ảnh được đẩy lên giao diện INVONE cho người dùng nhập.
 */
import { safeHost } from '../http';
import {
  PortalCaptchaError, PortalDocument, PortalDriver, PortalHttp, PortalInputError,
  PortalNotFoundError, PortalRequest, PortalStep, portalOrigin,
} from '../types';

const SEARCH_PATH   = '/HomeNoLogin/SearchByFkey';
const CAPTCHA_PATH  = '/Captcha/Show';
const DOWNLOAD_PATH = '/Invoice/Download';
const PREVIEW_PATH  = '/HomeNoLogin/ajxPreview/';

export function createVnptDriver(apiBase: string | null, providerName: string): PortalDriver {
  /** Cổng của chính hoá đơn luôn thắng danh bạ — VNPT cấp mỗi tài khoản một tên miền */
  const originOf = (req: PortalRequest): string => {
    const origin = portalOrigin(req.lookupUrl) ?? portalOrigin(apiBase);
    if (!origin) {
      throw new PortalInputError(
        `Hoá đơn không kèm địa chỉ cổng tra cứu ${providerName}. VNPT cấp mỗi tài khoản hoá ` +
        'đơn một cổng riêng, nên cần dán link tra cứu người bán gửi kèm hoá đơn vào hệ thống.',
      );
    }
    return origin;
  };

  return {
    id:     'vnpt',
    name:   providerName,
    status: 'unverified',
    requiresLookupCode: true,
    usesCaptcha: true,

    async begin(req: PortalRequest, http: PortalHttp): Promise<PortalStep> {
      const code = (req.lookupCode ?? '').trim();
      if (!code) {
        throw new PortalInputError(
          'Hoá đơn không có mã tra cứu — cổng VNPT chỉ tra được bằng "Mã tra cứu hóa đơn" ' +
          'người bán gửi kèm.',
        );
      }
      const origin = originOf(req);

      const page  = await http.getText(`${origin}${SEARCH_PATH}`);
      const token = extractToken(page);
      if (!token) {
        throw new Error(`Cổng ${safeHost(origin)} không trả về trang tra cứu như mong đợi`);
      }

      const img = await http.getBinary(`${origin}${CAPTCHA_PATH}`);
      if (img.byteLength < 200) {
        throw new Error(`Cổng ${safeHost(origin)} không cấp được ảnh mã xác thực`);
      }

      return {
        kind: 'captcha',
        imageDataUrl: `data:${imageMime(img)};base64,${img.toString('base64')}`,
        state: { token, origin },
        hint:  'Nhập đúng các ký tự trong ảnh của cổng VNPT',
      };
    },

    async complete(req, http, state, captchaAnswer): Promise<PortalDocument> {
      const code   = (req.lookupCode ?? '').trim();
      const origin = (state['origin'] ?? '').trim() || originOf(req);
      const token  = (state['token'] ?? '').trim();
      if (!token) {
        throw new PortalCaptchaError('Phiên tra cứu đã hết hạn — bấm lấy mã xác thực mới');
      }

      const res = await http.postFormNoRedirect(`${origin}${SEARCH_PATH}`, {
        __RequestVerificationToken: token,
        isHomepage: 'true',
        strFkey:    code,
        captch:     captchaAnswer,
      }, { Referer: `${origin}${SEARCH_PATH}` });

      // Cổng đá về trang chủ = mã xác thực sai hoặc mã tra cứu không tồn tại.
      // Cho người dùng nhập lại (rẻ và thường đúng) thay vì kết luận là hỏng cổng.
      if (res.status >= 300 && res.status < 400) {
        throw new PortalCaptchaError(
          'Cổng VNPT từ chối lần tra này — mã xác thực sai hoặc mã tra cứu không đúng. ' +
          'Kiểm tra lại mã rồi nhập mã xác thực mới.',
        );
      }
      if (res.status !== 200) {
        throw new Error(`Cổng ${safeHost(origin)} trả về HTTP ${res.status}`);
      }

      const body = res.body;
      const loi  = errorMessage(body);
      if (loi) throw new PortalNotFoundError(`Cổng ${providerName}: ${loi}`);

      const checkCode = extractCheckCode(body);

      // 1. File bản gốc do chính cổng phát hành — tốt nhất
      if (checkCode) {
        const pdf = await tryDownload(http, origin, checkCode);
        if (pdf) return { kind: 'pdf', data: pdf };

        const html = await tryPreview(http, origin, checkCode);
        if (html) return { kind: 'html', html: withBase(html, origin) };
      }

      // 2. Đường lui: bản thể hiện đã nằm sẵn trong trang kết quả
      const inline = extractReportBlock(body);
      if (inline) return { kind: 'html', html: withBase(inline, origin) };

      throw new PortalNotFoundError(
        `Cổng ${providerName} không trả về hoá đơn cho mã tra cứu này. Mở cổng tra cứu để ` +
        'kiểm tra lại mã.',
      );
    },
  };
}

// ─── Đọc trang của cổng ───────────────────────────────────────────────────────

/** Trường ẩn chống giả mạo của ASP.NET MVC, phải khớp với cookie cùng tên */
function extractToken(html: string): string | null {
  const m = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/i.exec(html);
  return m?.[1] ?? null;
}

/**
 * Mã nội bộ của hoá đơn trên cổng. Trang kết quả gắn nó vào các nút tải/xem:
 *   download('<checkCode>') · printInvoice('<checkCode>') · href="…?checkCode=<...>"
 * (mã này KHÁC mã tra cứu — thử gọi thẳng bằng mã tra cứu thì cổng báo
 *  "Chuỗi tra cứu không đúng định dạng!").
 */
function extractCheckCode(html: string): string | null {
  const pats = [
    /\bdownload\(\s*['"]([^'"]{6,})['"]\s*\)/,
    /\bprintInvoice\(\s*['"]([^'"]{6,})['"]\s*\)/,
    /checkCode=([^"'&<\s]{6,})/,
  ];
  for (const p of pats) {
    const m = p.exec(html);
    const v = m?.[1]?.trim();
    if (v && !/^\+|checkCode/.test(v)) return v;
  }
  return null;
}

/** Thông báo lỗi mà cổng in ra trang kết quả (mã sai, hoá đơn đã bị xoá…) */
function errorMessage(html: string): string | null {
  const m =
    /class="[^"]*(?:validation-summary-errors|field-validation-error|alert-danger)[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{5,200})/i
      .exec(html);
  const msg = m?.[1]?.trim();
  return msg && !/required/i.test(msg) ? msg : null;
}

/** Khối chứa bản thể hiện hoá đơn trên trang kết quả của cổng VNPT */
function extractReportBlock(html: string): string | null {
  const start = html.search(/<div[^>]*id="(?:ReportViewInv|container|ViewInvoice)"/i);
  if (start < 0) return null;
  const block = html.slice(start);
  // Cắt tới hết trang là đủ: render.ts tắt JavaScript nên phần thừa không chạy gì,
  // còn cắt đúng thẻ đóng bằng regex trên HTML thật thì không đáng tin.
  const body = block.split(/<footer|<script[^>]*>\s*\(function/i)[0] ?? block;
  return body.trim().length > 400 ? body : null;
}

/** Cho ảnh và CSS tương đối trong mảnh HTML trỏ về đúng cổng khi render PDF */
function withBase(html: string, origin: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${origin}/"></head>` +
         `<body>${html}</body></html>`;
}

function imageMime(buf: Buffer): string {
  const sig = buf.subarray(0, 4).toString('hex');
  if (sig.startsWith('89504e47')) return 'image/png';
  if (sig.startsWith('ffd8ff'))   return 'image/jpeg';
  if (sig.startsWith('47494638')) return 'image/gif';
  return 'image/png';
}

// ─── Lấy file ─────────────────────────────────────────────────────────────────

/**
 * File bản gốc của cổng. Trả null (không ném) khi cổng không dựng được file — vẫn còn
 * đường bản thể hiện HTML phía sau.
 */
async function tryDownload(http: PortalHttp, origin: string, checkCode: string): Promise<Buffer | null> {
  try {
    const buf = await http.getBinary(
      `${origin}${DOWNLOAD_PATH}?checkCode=${encodeURIComponent(checkCode)}`,
      { Referer: `${origin}${SEARCH_PATH}` },
    );
    if (buf.byteLength < 1024) return null;                       // mã sai → thân rỗng
    return buf.subarray(0, 5).toString('latin1') === '%PDF-' ? buf : null;
  } catch {
    return null;
  }
}

/** Bản thể hiện HTML theo đúng mẫu của người bán, do chính cổng dựng */
async function tryPreview(http: PortalHttp, origin: string, checkCode: string): Promise<string | null> {
  try {
    const res = await http.postFormJson<unknown>(`${origin}${PREVIEW_PATH}`, {
      checkCode,
    }, { Referer: `${origin}${SEARCH_PATH}` });

    // Thành công: { str: "<html>" }. Lỗi: cổng trả về đúng một chuỗi thông báo.
    const html = typeof res === 'object' && res !== null
      ? String((res as { str?: unknown }).str ?? '')
      : '';
    return html.trim().length > 400 ? html : null;
  } catch {
    return null;
  }
}
