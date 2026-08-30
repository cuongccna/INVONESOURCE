/**
 * EasyInvoice — SoftDreams (MST 0105987432)
 *
 * Mỗi người bán có CỔNG RIÊNG dạng http://<MST người bán>hd.easyinvoice.com.vn; địa chỉ này
 * in ngay trong hoá đơn ở trường TTKhac "PortalLink", nên driver dùng req.lookupUrl chứ
 * không gắn cứng host.
 *
 * Luồng (đã chạy thật với hoá đơn C26TGJ-3213, mã 2I2I8GLZM):
 *   1. GET  /Search/Index   → mở phiên, nhận cookie
 *   2. GET  /Captcha/Show   → ảnh mã xác thực gắn với phiên đó → đẩy lên cho người dùng nhập
 *   3. POST /Search/Search  FKey=<mã>&Capcha=<lời giải>
 *        → trang kết quả có ô ẩn InvData chứa JSON, trường "str" là HTML bản thể hiện
 *
 * Ảnh captcha và lần POST phải cùng một phiên, nên hộp cookie được cất vào phiên tra cứu
 * giữa hai bước.
 */
import {
  PortalCaptchaError, PortalDocument, PortalDriver, PortalHttp, PortalInputError,
  PortalNotFoundError, PortalRequest, PortalStep,
} from '../types';

/** Lấy gốc cổng từ link in trong hoá đơn (link có thể kèm đường dẫn hoặc tham số) */
function portalRoot(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export const easyInvoiceDriver: PortalDriver = {
  id:     'easyinvoice',
  name:   'EasyInvoice (SoftDreams)',
  status: 'verified',
  requiresLookupCode: true,
  usesCaptcha: true,

  async begin(req: PortalRequest, http: PortalHttp): Promise<PortalStep> {
    const code = (req.lookupCode ?? '').trim();
    if (!code) throw new PortalInputError('Hoá đơn không có mã tra cứu trong XML');

    // Mỗi người bán một tên miền khác nhau, không suy ra được — bắt buộc lấy từ hoá đơn.
    const host = portalRoot(req.lookupUrl ?? '');
    if (!host) {
      throw new PortalInputError(
        'Hoá đơn không ghi địa chỉ cổng tra cứu (PortalLink) nên không biết vào cổng nào',
      );
    }

    await http.getText(`${host}/Search/Index`);
    const img = await http.getBinary(`${host}/Captcha/Show`, { Referer: `${host}/Search/Index` });

    return {
      kind: 'captcha',
      imageDataUrl: `data:image/png;base64,${img.toString('base64')}`,
      state: { host },
      hint: 'Nhập 4–6 ký tự trong ảnh (không phân biệt hoa thường)',
    };
  },

  async complete(req, http, state, captchaAnswer): Promise<PortalDocument> {
    const code = (req.lookupCode ?? '').trim();
    const host = (state['host'] ?? '').trim();
    if (!host) throw new PortalCaptchaError('Phiên tra cứu đã hết hạn — bấm lấy mã xác thực mới');

    const html = await http.postForm(
      `${host}/Search/Search`,
      { FKey: code, Capcha: captchaAnswer, ListInv: '0', InvData: "''", msg: '', typeSearch: '' },
      { Referer: `${host}/Search/Index` },
    );

    const invHtml = extractInvoiceHtml(html);
    if (!invHtml) {
      // Trang trả về form rỗng = mã xác thực sai hoặc không có hoá đơn. Phân biệt bằng
      // việc mã tra cứu có được cổng giữ lại trong trang kết quả hay không.
      if (!html.includes(code)) {
        throw new PortalCaptchaError('Cổng EasyInvoice từ chối mã xác thực — vui lòng nhập lại');
      }
      throw new PortalNotFoundError('Cổng EasyInvoice không có bản thể hiện cho mã tra cứu này');
    }
    return { kind: 'html', html: invHtml };
  },
};

/**
 * Bóc HTML bản thể hiện trong ô ẩn InvData của trang kết quả.
 * Giá trị là JSON đã HTML-escape, trong đó trường "str" là HTML hoá đơn.
 */
function extractInvoiceHtml(page: string): string | null {
  const m = /<input[^>]*\bid="InvData"[^>]*\bvalue="([\s\S]*?)"\s*\/?>/.exec(page)
         ?? /<input[^>]*\bname="InvData"[^>]*\bvalue="([\s\S]*?)"\s*\/?>/.exec(page);
  const raw = m?.[1];
  if (!raw || raw.length < 200) return null;   // "''" = chưa tra được gì

  try {
    const json = JSON.parse(unescapeHtml(raw)) as { str?: string };
    const html = (json.str ?? '').trim();
    return html.length > 200 ? html : null;
  } catch {
    return null;
  }
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
