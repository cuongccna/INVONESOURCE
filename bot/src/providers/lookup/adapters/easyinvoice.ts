/**
 * EasyInvoice — SoftDreams (CÔNG TY CỔ PHẦN ĐẦU TƯ CÔNG NGHỆ VÀ THƯƠNG MẠI SOFTDREAMS,
 * MST 0105987432)
 *
 * Mỗi người bán có CỔNG RIÊNG dạng http://<MST người bán>hd.easyinvoice.com.vn — địa chỉ
 * này in ngay trong hoá đơn ở trường TTKhac "PortalLink", nên adapter dùng req.lookupUrl
 * chứ không gắn cứng host nào.
 *
 * Luồng (đã chạy thật với hoá đơn C26TGJ-3213, mã 2I2I8GLZM):
 *   1. GET  /Search/Index      → mở session, nhận cookie
 *   2. GET  /Captcha/Show      → ảnh captcha PNG gắn với session đó
 *   3. Giải captcha (2Captcha)
 *   4. POST /Search/Search     FKey=<mã tra cứu>&Capcha=<lời giải>
 *      → trang kết quả có ô ẩn InvData chứa JSON, trường "str" là HTML bản thể hiện
 *        đầy đủ theo mẫu của nhà cung cấp.
 *   5. Trả HTML đó cho runner render thành PDF.
 *
 * Captcha 4–6 ký tự, không phân biệt hoa thường.
 */
import { LookupAdapter, LookupInputError, LookupNotFoundError } from '../types';

/** Cổng dựng trang phía máy chủ nên nhận HTML, không phải PDF sẵn */
export const easyInvoiceAdapter: LookupAdapter = {
  id:     'easyinvoice',
  name:   'EasyInvoice (SoftDreams)',
  status: 'verified',
  requiresLookupCode: true,
  needsCaptcha: true,

  async fetchPdf(req, http) {
    const code = (req.lookupCode ?? '').trim();
    if (!code) throw new LookupInputError('Hoá đơn không có mã tra cứu trong XML');

    // Cổng riêng của người bán nằm ngay trong hoá đơn; không có thì chịu, vì mỗi
    // người bán một tên miền khác nhau, không suy ra được.
    const host = (req.lookupUrl ?? '').trim().replace(/\/+$/, '');
    if (!host) {
      throw new LookupInputError(
        'Hoá đơn không ghi địa chỉ cổng tra cứu (PortalLink) nên không biết vào cổng nào',
      );
    }

    // 1. Mở session
    await http.getText(`${host}/Search/Index`);

    // 2 + 3. Ảnh captcha của đúng session này, rồi giải
    const img = await http.getBinary(`${host}/Captcha/Show`, { Referer: `${host}/Search/Index` } as never);
    const answer = await http.solveCaptcha(img.toString('base64'), { minLen: 4, maxLen: 6 });

    // 4. Tra cứu
    const html = await http.postForm(
      `${host}/Search/Search`,
      { FKey: code, Capcha: answer, ListInv: '0', InvData: "''", msg: '', typeSearch: '' },
      { headers: { Referer: `${host}/Search/Index` } },
    );

    const invHtml = extractInvoiceHtml(html);
    if (!invHtml) {
      // Trang trả về form rỗng = captcha sai hoặc không có hoá đơn. Phân biệt bằng
      // việc mã tra cứu có xuất hiện trong trang kết quả hay không.
      if (!html.includes(code)) {
        throw new Error('Cổng EasyInvoice từ chối — nhiều khả năng captcha giải sai, sẽ thử lại sau');
      }
      throw new LookupNotFoundError('Cổng EasyInvoice không trả về bản thể hiện cho mã tra cứu này');
    }
    return { kind: 'html', html: invHtml };
  },
};

/**
 * Bóc HTML bản thể hiện trong ô ẩn InvData của trang kết quả.
 * Giá trị là JSON đã được HTML-escape hai lần, trong đó trường "str" là HTML hoá đơn.
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
