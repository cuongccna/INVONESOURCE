/**
 * Nền tảng xcyber (CyberLotus) — dùng chung cho NewCA, CyberBill/FastCA và các cổng
 * white-label khác dựng trên cùng bộ mã ASP.NET Boilerplate "hddt".
 *
 * Mỗi thương hiệu có một máy chủ API riêng, địa chỉ nằm trong appconfig của trang tra cứu:
 *   tracuuhoadon.newca.vn   → https://mspapp.xcyber.vn
 *   tracuu.cyberbill.vn     → https://bill1app.xcyber.vn   (redirect tracuuhoadon1.xcyber.vn)
 * Vì vậy base URL đọc từ einvoice_providers.lookup_api_base, không gắn cứng.
 *
 * LUỒNG (đã gọi thật ngày 29/08/2026 trên cổng NewCA, mã 25UZ7XX3AN7S → lấy được bản
 * thể hiện HTML có logo NEWCA của hoá đơn CÔNG TY CỔ PHẦN NEWCA):
 *   1. POST /api/services/hddt/TraCuuHoaDon/RefreshCaptcha  {}
 *        → { result: { key, image: "data:image/jpeg;base64,…" } }
 *   2. Người dùng nhìn ảnh và tự nhập mã xác thực
 *   3. POST /api/services/hddt/TraCuuHoaDon/TraCuu
 *        { key, captcha, doanhNghiep_MST, maSoBiMat }
 *        → { result: { status, message, html, base64, fileData, key } }
 *          status 1 = tìm thấy · status 2 = mã xác thực sai hoặc không có hoá đơn
 *          html   = bản thể hiện theo mẫu nhà cung cấp
 *          base64 = XML hoá đơn (không phải PDF)
 *   4. POST /api/services/hddt/TraCuuHoaDon/DownloadPdf
 *        { key: <key mới từ bước 3>, doanhNghiep_MST, maSoBiMat }
 *        → { result: { status, base64 } } — PDF sẵn, nếu phiên còn hiệu lực
 *
 * Cổng chấp nhận doanhNghiep_MST rỗng (đã kiểm), nhưng vẫn gửi MST người bán khi có để
 * thu hẹp phạm vi tìm; hỏng thì thử lại một lần với MST rỗng.
 */
import { assertPdf } from '../http';
import {
  PortalCaptchaError, PortalDocument, PortalDriver, PortalHttp, PortalInputError,
  PortalNotFoundError, PortalRequest, PortalStep, portalOrigin,
} from '../types';

interface XcyberResult {
  status?:  number;
  message?: string | null;
  html?:    string | null;
  key?:     string | null;
  image?:   string | null;
  base64?:  string | null;
}
interface XcyberEnvelope { result?: XcyberResult | null; error?: { message?: string } | null }

const DEFAULT_BASE = 'https://mspapp.xcyber.vn';
const API = '/api/services/hddt/TraCuuHoaDon';

/** Cổng báo "Mã xác thực không hợp lệ" khi gõ sai — phân biệt với "không có hoá đơn" */
function isCaptchaMessage(msg: string): boolean {
  return /x[aá]c th[uự]c|captcha|capcha/i.test(msg);
}

/**
 * MÁY CHỦ NÀO GIỮ HOÁ ĐƠN NÀY.
 *
 * Nền tảng xcyber chạy nhiều bản song song, mỗi bản một kho dữ liệu riêng — hỏi nhầm máy
 * chủ thì cổng trả "không có hoá đơn" dù mã hoàn toàn đúng. Trang tra cứu Angular của mỗi
 * bản khai địa chỉ API của chính nó trong /assets/appconfig.production.json (đã kiểm
 * 30/08/2026):
 *
 *     tracuuhoadon1.xcyber.vn → https://bill1app.xcyber.vn
 *     tracuuhoadon2.xcyber.vn → https://bill2app.xcyber.vn
 *     tracuu.cyberbill.vn     → https://bill1app.xcyber.vn
 *
 * Nên thay vì chờ có người thêm từng bản vào danh bạ, driver đọc thẳng file cấu hình của
 * cổng in trong hoá đơn. Không đọc được thì quay về lookup_api_base như cũ.
 */
const CONFIG_PATHS = ['/assets/appconfig.production.json', '/assets/appconfig.json'];
const DISCOVERY_TTL_MS = 60 * 60_000;
const discovered = new Map<string, { at: number; base: string | null }>();

async function discoverApiBase(http: PortalHttp, lookupUrl: string | null): Promise<string | null> {
  const origin = portalOrigin(lookupUrl);
  if (!origin) return null;

  const hit = discovered.get(origin);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.base;

  let found: string | null = null;
  for (const p of CONFIG_PATHS) {
    try {
      const cfgJson = await http.getJson<{ remoteServiceBaseUrl?: unknown }>(`${origin}${p}`);
      const url = String(cfgJson?.remoteServiceBaseUrl ?? '').trim();
      if (/^https?:\/\/[a-z0-9.-]+/i.test(url)) { found = url.replace(/\/+$/, ''); break; }
    } catch {
      // Cổng không phải bản Angular này (hoặc trả trang HTML) — thử đường dẫn kế tiếp
    }
  }
  discovered.set(origin, { at: Date.now(), base: found });
  return found;
}

export function createXcyberDriver(apiBase: string | null, providerName: string): PortalDriver {
  const fallbackBase = (apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');

  return {
    id:     'xcyber',
    name:   providerName,
    status: 'verified',
    requiresLookupCode: true,
    usesCaptcha: true,

    async begin(req: PortalRequest, http: PortalHttp): Promise<PortalStep> {
      const code = (req.lookupCode ?? '').trim();
      if (!code) throw new PortalInputError('Hoá đơn không có mã tra cứu trong XML');

      const base = (await discoverApiBase(http, req.lookupUrl)) ?? fallbackBase;
      const env = await http.postJson<XcyberEnvelope>(`${base}${API}/RefreshCaptcha`, {});
      const key   = (env.result?.key   ?? '').trim();
      const image = (env.result?.image ?? '').trim();
      if (!key || !image.startsWith('data:image')) {
        throw new Error(`Cổng ${providerName} không cấp được mã xác thực`);
      }
      return {
        kind: 'captcha',
        imageDataUrl: image,
        // Ghim luôn máy chủ đã cấp ảnh: mã xác thực gắn với phiên của CHÍNH máy chủ đó
        state: { key, base },
        hint: 'Nhập đúng các ký tự trong ảnh (không phân biệt hoa thường)',
      };
    },

    async complete(req, http, state, captchaAnswer): Promise<PortalDocument> {
      const code = (req.lookupCode ?? '').trim();
      const key  = (state['key'] ?? '').trim();
      const base = (state['base'] ?? '').trim() || fallbackBase;
      if (!key) throw new PortalCaptchaError('Phiên tra cứu đã hết hạn — bấm lấy mã xác thực mới');

      // MST người bán của cổng thuế có thể kèm đuôi chi nhánh (0100109106-011);
      // cổng tra cứu chỉ nhận phần gốc.
      const mst = (req.sellerTaxCode ?? '').trim().split('-')[0] ?? '';

      let res = await traCuu(http, base, key, captchaAnswer, mst, code);

      // Sai cặp MST/mã nhưng captcha đúng: thử lại một lần không kèm MST, vì vài cổng
      // lưu MST khác với dữ liệu cổng thuế (chi nhánh, MST cũ sau sáp nhập).
      if (res.status !== 1 && mst && !isCaptchaMessage(res.message ?? '') && res.key) {
        res = await traCuu(http, base, res.key, captchaAnswer, '', code);
      }

      if (res.status !== 1) {
        const msg = (res.message ?? '').trim();
        if (isCaptchaMessage(msg) || !msg) {
          throw new PortalCaptchaError(
            msg || `Cổng ${providerName} từ chối mã xác thực — vui lòng nhập lại`,
          );
        }
        throw new PortalNotFoundError(`Cổng ${providerName}: ${msg}`);
      }

      // Ưu tiên PDF sẵn của cổng; phiên hết hạn thì quay về bản thể hiện HTML.
      const pdf = await tryDownloadPdf(http, base, res.key ?? key, mst, code);
      if (pdf) return { kind: 'pdf', data: pdf };

      const html = (res.html ?? '').trim();
      if (html.length < 200) {
        throw new Error(`Cổng ${providerName} không trả về bản thể hiện của hoá đơn`);
      }
      return { kind: 'html', html };
    },
  };
}

async function traCuu(
  http: PortalHttp, base: string, key: string,
  captcha: string, mst: string, code: string,
): Promise<XcyberResult> {
  const env = await http.postJson<XcyberEnvelope>(`${base}${API}/TraCuu`, {
    key, captcha, doanhNghiep_MST: mst, maSoBiMat: code,
  });
  return env.result ?? { status: 2, message: env.error?.message ?? null };
}

/**
 * PDF sẵn của cổng. Trả null (không ném) khi phiên hết hạn hoặc cổng không dựng được PDF —
 * bản thể hiện HTML ở bước trước đã đủ để dựng file cho người dùng.
 */
async function tryDownloadPdf(
  http: PortalHttp, base: string, key: string, mst: string, code: string,
): Promise<Buffer | null> {
  try {
    const env = await http.postJson<XcyberEnvelope>(`${base}${API}/DownloadPdf`, {
      key, doanhNghiep_MST: mst, maSoBiMat: code,
    });
    const b64 = (env.result?.base64 ?? '').trim();
    if (env.result?.status !== 1 || !b64) return null;
    return assertPdf(Buffer.from(b64, 'base64'), 'Cổng tra cứu');
  } catch {
    return null;
  }
}
