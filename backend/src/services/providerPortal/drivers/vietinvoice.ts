/**
 * Viet-Invoice (CÔNG TY CỔ PHẦN ICORP — MST 0106870211)
 *
 * Cổng công khai https://tracuuhoadon.vietinvoice.vn/?lookupCode=<mã>, API nền
 * https://hoadondientu.vietinvoice.vn/api/v1 — không đăng nhập, KHÔNG mã xác thực.
 *
 * Luồng (đã lấy được PDF thật của hoá đơn 1C26TDL-1912):
 *   1. GET /misc/find-by-lookup-code?lookupCode=…    → đối chiếu đúng hoá đơn trước khi tải
 *   2. GET /misc/export-by-lookup-code?lookupCode=…  → { fileURL, fileName }
 *   3. GET fileURL                                    → PDF theo mẫu Viet-Invoice
 *
 * Đối chiếu ở bước 1 là bắt buộc: mã tra cứu trỏ nhầm hoá đơn thì file lưu vào hệ thống
 * sẽ là hoá đơn của người khác.
 */
import { assertPdf } from '../http';
import {
  PortalDriver, PortalInputError, PortalNotFoundError, PortalRequest, PortalStep,
} from '../types';

const API_BASE  = 'https://hoadondientu.vietinvoice.vn/api/v1';
const FILE_BASE = 'https://hoadondientu.vietinvoice.vn';

interface FindResponse {
  result?: string;
  data?: { sellerTaxCode?: string; serial?: string; no?: number } | null;
  message?: string;
}
interface ExportResponse { fileURL?: string; fileName?: string }

/** "1C26TDL" và "C26TDL" là cùng một ký hiệu — khác ở chữ số mẫu hoá đơn đứng đầu */
function serialsMatch(a: string, b: string): boolean {
  const x = a.trim().toUpperCase();
  const y = b.trim().toUpperCase();
  return x === y || x.endsWith(y) || y.endsWith(x);
}

export const vietInvoiceDriver: PortalDriver = {
  id:     'vietinvoice',
  name:   'Viet-Invoice (ICORP)',
  status: 'verified',
  requiresLookupCode: true,
  usesCaptcha: false,

  async begin(req: PortalRequest, http): Promise<PortalStep> {
    const code = (req.lookupCode ?? '').trim();
    if (!code) throw new PortalInputError('Hoá đơn không có mã tra cứu trong XML');

    const found = await http.getJson<FindResponse>(
      `${API_BASE}/misc/find-by-lookup-code?lookupCode=${encodeURIComponent(code)}`,
    );
    if (found.result !== 'success' || !found.data) {
      throw new PortalNotFoundError(
        found.message ?? 'Cổng Viet-Invoice không tìm thấy hoá đơn theo mã tra cứu này',
      );
    }

    const gotMst    = (found.data.sellerTaxCode ?? '').trim();
    const gotSerial = (found.data.serial ?? '').trim();
    const wantMst   = (req.sellerTaxCode ?? '').trim();
    if (wantMst && gotMst && gotMst !== wantMst) {
      throw new PortalNotFoundError(
        `Mã tra cứu trỏ tới hoá đơn của MST ${gotMst}, không khớp người bán ${wantMst}`,
      );
    }
    if (req.serial && gotSerial && !serialsMatch(gotSerial, req.serial)) {
      throw new PortalNotFoundError(
        `Mã tra cứu trỏ tới ký hiệu ${gotSerial}, không khớp ${req.serial}`,
      );
    }
    const wantNo = Number(String(req.invoiceNumber ?? '').replace(/\D/g, ''));
    if (Number.isFinite(wantNo) && wantNo > 0 && typeof found.data.no === 'number'
        && found.data.no !== wantNo) {
      throw new PortalNotFoundError(
        `Mã tra cứu trỏ tới hoá đơn số ${found.data.no}, không khớp số ${wantNo}`,
      );
    }

    const exported = await http.getJson<ExportResponse>(
      `${API_BASE}/misc/export-by-lookup-code?lookupCode=${encodeURIComponent(code)}&typeWebsite=1`,
    );
    const fileUrl = (exported.fileURL ?? '').trim();
    if (!fileUrl) throw new Error('Cổng Viet-Invoice không trả về đường dẫn file PDF');

    const abs = /^https?:\/\//i.test(fileUrl) ? fileUrl : `${FILE_BASE}${fileUrl}`;
    return {
      kind: 'document',
      doc: { kind: 'pdf', data: assertPdf(await http.getBinary(abs), 'Cổng Viet-Invoice') },
    };
  },
};
