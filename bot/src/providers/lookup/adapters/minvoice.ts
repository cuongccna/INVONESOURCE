/**
 * Nền tảng M-Invoice (CÔNG TY TNHH HÓA ĐƠN ĐIỆN TỬ M-INVOICE — MST 0106026495)
 *
 * Cổng tra cứu: https://tracuuhoadon.minvoice.com.vn
 * API:  GET {base}/api/Search/SearchInvoice?masothue=&sobaomat=&type=PDF&inchuyendoi=false
 *       → thân phản hồi là PDF (responseType blob trên giao diện của họ)
 *
 * Hợp đồng tham số đã kiểm chứng bằng cách gọi thật:
 *   - Thiếu `type` → HTTP 400 {"errors":{"type":["The type field is required."]}}
 *   - Sai cặp MST/mã → HTTP 500 code 5000 "Thông tin tra cứu không chính xác…"
 *   Tức tên tham số đúng; chưa lấy được PDF thật nên adapter để status 'unverified'.
 *
 * LƯU Ý VỀ TENANT: M-Invoice cấp host riêng cho từng người bán dạng
 * https://<MST>hd.minvoice.com.vn. Cổng trung tâm chỉ tra được hoá đơn nằm trên chính nó —
 * hoá đơn của đại lý (vd NCCA) không tra được ở đây. Vì vậy base URL đọc từ DB
 * (einvoice_providers.lookup_api_base) để chỉnh được mà không phải sửa mã.
 */
import { assertPdf } from '../http';
import { LookupAdapter, LookupInputError, LookupNotFoundError } from '../types';

const DEFAULT_BASE = 'https://tracuuhoadon.minvoice.com.vn';

/** Tạo adapter M-Invoice trỏ tới một host cụ thể (mặc định: cổng trung tâm) */
export function createMinvoiceAdapter(apiBase?: string | null): LookupAdapter {
  const base = (apiBase ?? DEFAULT_BASE).replace(/\/+$/, '');

  return {
    id:     'minvoice',
    name:   'M-Invoice',
    status: 'unverified',
    requiresLookupCode: true,

    async fetchPdf(req, http) {
      const code = (req.lookupCode ?? '').trim();
      const mst  = (req.sellerTaxCode ?? '').trim();
      if (!code) throw new LookupInputError('Hoá đơn không có mã tra cứu trong XML');
      if (!mst)  throw new LookupInputError('Hoá đơn thiếu MST người bán để tra cứu');

      const url =
        `${base}/api/Search/SearchInvoice` +
        `?masothue=${encodeURIComponent(mst)}` +
        `&sobaomat=${encodeURIComponent(code)}` +
        `&type=PDF&inchuyendoi=false`;

      let buf: Buffer;
      try {
        buf = await http.getBinary(url);
      } catch (err) {
        // Cổng trả 500 kèm code 5000 khi cặp MST/mã không tồn tại trên host này —
        // đó là kết luận cuối cùng, không phải cổng hỏng, nên không tính vào circuit breaker.
        const msg = err instanceof Error ? err.message : String(err);
        if (/HTTP 500/.test(msg) || /HTTP 404/.test(msg)) {
          throw new LookupNotFoundError(
            `Cổng M-Invoice không có hoá đơn với MST ${mst} + mã tra cứu này ` +
            '(hoá đơn có thể nằm trên host riêng của người bán)',
          );
        }
        throw err;
      }
      return { kind: 'pdf', data: assertPdf(buf, 'Cổng M-Invoice') };
    },
  };
}

export const minvoiceAdapter = createMinvoiceAdapter();
