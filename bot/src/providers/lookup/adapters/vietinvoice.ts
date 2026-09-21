/**
 * Viet-Invoice (CÔNG TY CỔ PHẦN ICORP — MST 0106870211)
 *
 * Cổng tra cứu công khai: https://tracuuhoadon.vietinvoice.vn/?lookupCode=<mã>
 * API nền: https://hoadondientu.vietinvoice.vn/api/v1  — không cần đăng nhập, không captcha.
 *
 * Luồng (đã gọi thật và lấy được PDF của hoá đơn 1C26TDL-1912 ngày 21/08/2026):
 *   1. GET /misc/find-by-lookup-code?lookupCode=<mã>
 *        → { result: "success", data: { sellerTaxCode, serial, no, ... } }
 *        Dùng để đối chiếu đúng hoá đơn trước khi tải, tránh lưu nhầm file.
 *   2. GET /misc/export-by-lookup-code?lookupCode=<mã>&typeWebsite=1
 *        → { fileURL, fileName }   (fileURL có thể là đường dẫn tương đối)
 *   3. GET fileURL → nội dung PDF theo mẫu Viet-Invoice.
 *
 * Tên file cổng trả về đúng bằng tên người dùng tải tay từ trình duyệt
 * (vd invoice_0106870211_2j7vtq.pdf), tức đây chính là bản gốc nhà cung cấp phát hành.
 */
import { assertPdf } from '../http';
import { LookupAdapter, LookupInputError, LookupNotFoundError } from '../types';

const API_BASE  = 'https://hoadondientu.vietinvoice.vn/api/v1';
const FILE_BASE = 'https://hoadondientu.vietinvoice.vn';

interface FindResponse {
  result?: string;
  data?: {
    sellerTaxCode?: string;
    serial?:        string;
    no?:            number;
  } | null;
  message?: string;
}

interface ExportResponse {
  fileURL?:  string;
  fileName?: string;
}

/** "1C26TDL" và "C26TDL" là cùng một ký hiệu — khác nhau ở chữ số mẫu hoá đơn đứng đầu */
function serialsMatch(a: string, b: string): boolean {
  const x = a.trim().toUpperCase();
  const y = b.trim().toUpperCase();
  return x === y || x.endsWith(y) || y.endsWith(x);
}

export const vietInvoiceAdapter: LookupAdapter = {
  id:     'vietinvoice',
  name:   'Viet-Invoice (ICORP)',
  status: 'verified',
  requiresLookupCode: true,

  async fetchPdf(req, http) {
    const code = (req.lookupCode ?? '').trim();
    if (!code) throw new LookupInputError('Hoá đơn không có mã tra cứu trong XML');

    // ── 1. Đối chiếu đúng hoá đơn ────────────────────────────────────────────
    const found = await http.getJson<FindResponse>(
      `${API_BASE}/misc/find-by-lookup-code?lookupCode=${encodeURIComponent(code)}`,
    );
    if (found.result !== 'success' || !found.data) {
      throw new LookupNotFoundError(
        found.message ?? 'Cổng Viet-Invoice không tìm thấy hoá đơn theo mã tra cứu này',
      );
    }

    // Cổng trả serial/mst có khoảng trắng đệm — so sánh sau khi trim.
    const gotMst    = (found.data.sellerTaxCode ?? '').trim();
    const gotSerial = (found.data.serial ?? '').trim();
    const wantMst   = (req.sellerTaxCode ?? '').trim();
    if (wantMst && gotMst && gotMst !== wantMst) {
      throw new LookupNotFoundError(
        `Mã tra cứu trỏ tới hoá đơn của MST ${gotMst}, không khớp người bán ${wantMst}`,
      );
    }
    // Ký hiệu: cổng nhà cung cấp ghi đủ "1C26TDL" (kèm chữ số mẫu hoá đơn ở đầu), còn dữ
    // liệu cổng thuế tách chữ số đó ra trường riêng nên chỉ còn "C26TDL". So khớp theo phần
    // đuôi để không báo lệch oan.
    if (req.serial && gotSerial && !serialsMatch(gotSerial, req.serial)) {
      throw new LookupNotFoundError(
        `Mã tra cứu trỏ tới ký hiệu ${gotSerial}, không khớp ${req.serial}`,
      );
    }

    // Số hoá đơn là dấu hiệu chắc chắn nhất — lệch số là lấy nhầm hoá đơn.
    const wantNo = Number(String(req.invoiceNumber ?? '').replace(/\D/g, ''));
    if (Number.isFinite(wantNo) && wantNo > 0 && typeof found.data.no === 'number'
        && found.data.no !== wantNo) {
      throw new LookupNotFoundError(
        `Mã tra cứu trỏ tới hoá đơn số ${found.data.no}, không khớp số ${wantNo}`,
      );
    }

    // ── 2. Xin link file ─────────────────────────────────────────────────────
    const exported = await http.getJson<ExportResponse>(
      `${API_BASE}/misc/export-by-lookup-code?lookupCode=${encodeURIComponent(code)}&typeWebsite=1`,
    );
    const fileUrl = (exported.fileURL ?? '').trim();
    if (!fileUrl) throw new Error('Cổng Viet-Invoice không trả về đường dẫn file PDF');

    // ── 3. Tải PDF ───────────────────────────────────────────────────────────
    const abs = /^https?:\/\//i.test(fileUrl) ? fileUrl : `${FILE_BASE}${fileUrl}`;
    return { kind: 'pdf', data: assertPdf(await http.getBinary(abs), 'Cổng Viet-Invoice') };
  },
};
