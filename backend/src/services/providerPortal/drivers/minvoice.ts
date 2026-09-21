/**
 * Nền tảng M-Invoice — dùng cho chính M-Invoice (MST 0106026495) và các đại lý phát hành
 * trên nền tảng này, trong đó có NCCA / NCInvoice (MST 0106166781).
 *
 * Cổng tra cứu của NCInvoice (http://tracuuhoadon.hddt-nc.vn) là giao diện React gọi thẳng
 * https://tracuuhoadon.minvoice.com.vn/api/ — đã kiểm bằng cách đọc bundle của chính cổng
 * (ApiDefine.SearchInvoice.GetPdf = "Search/SearchInvoice"), nên hai bên dùng chung driver.
 *
 * API:  GET {base}/api/Search/SearchInvoice?masothue=&sobaomat=&type=PDF&inchuyendoi=false
 *       → thân phản hồi chính là PDF
 *
 * Hợp đồng tham số đã kiểm bằng cách gọi thật:
 *   - Thiếu `type`     → HTTP 400 {"errors":{"type":["The type field is required."]}}
 *   - Sai MST/mã       → HTTP 500 code 5000 "Thông tin tra cứu không chính xác…"
 *
 * KHÔNG có mã xác thực — cổng chỉ cần MST người bán + mã bảo mật, hai thứ hệ thống đã có
 * sẵn trong hoá đơn, nên tra được thẳng không cần người dùng làm gì.
 *
 * LƯU Ý TENANT: M-Invoice cấp host riêng cho một số người bán (https://<MST>hd.minvoice.com.vn).
 * Base URL đọc từ DB để chỉnh được mà không phải sửa mã.
 */
import { assertPdf } from '../http';
import {
  PortalDriver, PortalInputError, PortalNotFoundError, PortalRequest, PortalStep,
} from '../types';

const DEFAULT_BASE = 'https://tracuuhoadon.minvoice.com.vn';

export function createMinvoiceDriver(apiBase: string | null, providerName: string): PortalDriver {
  const base = (apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');

  return {
    id:     'minvoice',
    name:   providerName,
    status: 'unverified',
    requiresLookupCode: true,
    usesCaptcha: false,

    async begin(req: PortalRequest, http): Promise<PortalStep> {
      const code = (req.lookupCode ?? '').trim();
      const mst  = (req.sellerTaxCode ?? '').trim().split('-')[0] ?? '';
      if (!code) throw new PortalInputError('Hoá đơn không có mã tra cứu trong XML');
      if (!mst)  throw new PortalInputError('Hoá đơn thiếu MST người bán để tra cứu');

      const url =
        `${base}/api/Search/SearchInvoice` +
        `?masothue=${encodeURIComponent(mst)}` +
        `&sobaomat=${encodeURIComponent(code)}` +
        `&type=PDF&inchuyendoi=false`;

      let buf: Buffer;
      try {
        buf = await http.getBinary(url);
      } catch (err) {
        // 500 kèm code 5000 = cặp MST/mã không tồn tại trên host này. Đó là kết luận cuối
        // cùng chứ không phải cổng hỏng, nên không được tính vào ngắt mạch.
        const msg = err instanceof Error ? err.message : String(err);
        if (/HTTP 500/.test(msg) || /HTTP 404/.test(msg)) {
          throw new PortalNotFoundError(
            `Cổng ${providerName} không có hoá đơn với MST ${mst} và mã tra cứu này ` +
            '(hoá đơn có thể nằm trên host riêng của người bán)',
          );
        }
        throw err;
      }
      return { kind: 'document', doc: { kind: 'pdf', data: assertPdf(buf, `Cổng ${providerName}`) } };
    },
  };
}
