/**
 * Viettel Telecom — cổng tra cứu hoá đơn bán hàng https://vietteltelecom.vn/hoadondientu
 *
 * PHẠM VI: cổng này chỉ tra được HOÁ ĐƠN DO CHÍNH VIETTEL TELECOM PHÁT HÀNH (cước di động,
 * internet, dịch vụ số) — không phải mọi hoá đơn đi qua nền tảng Viettel S-Invoice. Vì vậy
 * driver tự chặn khi người bán không phải Viettel, tránh bắn request vô ích.
 *
 * API (đọc từ bundle của chính trang, đã gọi thật để xác nhận hợp đồng tham số):
 *   POST https://apigami.viettel.vn/mvt-api/myviettel.php/getSingleSellBillingV2
 *   Tham số nằm trên QUERY STRING, không phải thân request (client của họ dùng axios `params`):
 *     invoiceNo        ký hiệu + số hoá đơn viết liền, vd K24DAA63471710
 *     reservationCode  mã số bí mật in trên hoá đơn
 *     fromDate/toDate  yyyy-MM-dd, khoảng tra tối đa 90 ngày
 *     fileType         pdf
 *   Phản hồi: { errorCode, message, data }
 *     errorCode 0 = tìm thấy · 1 = không tìm thấy (ERR_904068)
 *     4 = sai định dạng ngày / quá 90 ngày · 3 = thiếu tham số
 *
 * KHÔNG có mã xác thực — cần đúng số hoá đơn và mã số bí mật, hai thứ đã có trong hoá đơn.
 *
 * TRẠNG THÁI: hợp đồng tham số, định dạng ngày và các mã lỗi đã kiểm bằng cách gọi thật;
 * riêng hình dạng phản hồi khi TÌM THẤY thì chưa xác nhận được vì chưa có hoá đơn Viettel
 * thật để thử. Vì thế driver để 'unverified' và đọc file theo nhiều dạng có thể.
 */
import { assertPdf } from '../http';
import {
  PortalDriver, PortalInputError, PortalNotFoundError, PortalRequest, PortalStep,
} from '../types';

const API = 'https://apigami.viettel.vn/mvt-api/myviettel.php/getSingleSellBillingV2';

/** MST gốc của Viettel (hoá đơn ghi kèm đuôi chi nhánh, vd 0100109106-011) */
const VIETTEL_MST = '0100109106';

/** Khoảng ngày quanh ngày hoá đơn — cổng chỉ cho tra tối đa 90 ngày */
const WINDOW_DAYS = 20;

interface ViettelResponse {
  errorCode?: number;
  message?:   string;
  data?:      unknown;
}

export const viettelTelecomDriver: PortalDriver = {
  id:     'viettel-telecom',
  name:   'Viettel Telecom',
  status: 'unverified',
  requiresLookupCode: true,
  usesCaptcha: false,

  async begin(req: PortalRequest, http): Promise<PortalStep> {
    const code = (req.lookupCode ?? '').trim();
    if (!code) throw new PortalInputError('Hoá đơn không có mã số bí mật trong XML');

    const seller = (req.sellerTaxCode ?? '').trim();
    if (!seller.startsWith(VIETTEL_MST)) {
      throw new PortalInputError(
        'Cổng tra cứu của Viettel Telecom chỉ tra được hoá đơn do chính Viettel phát hành. ' +
        'Hoá đơn này của người bán khác — dùng cổng tra cứu ghi trên hoá đơn.',
      );
    }

    const { fromDate, toDate } = window(req.invoiceDate);

    // Ký hiệu và số hoá đơn viết liền; cổng thuế tách số ra khỏi phần đệm số 0 nên thử
    // cả dạng đủ 8 chữ số lẫn dạng nguyên văn trước khi kết luận không tìm thấy.
    let lastMessage = '';
    for (const invoiceNo of invoiceNoCandidates(req)) {
      const res = await http.postQuery<ViettelResponse>(API, {
        invoiceNo, reservationCode: code, fromDate, toDate, fileType: 'pdf',
      });

      if (res.errorCode === 0) {
        const pdf = findPdf(res.data);
        if (!pdf) throw new Error('Cổng Viettel trả về kết quả nhưng không kèm file PDF');
        return { kind: 'document', doc: { kind: 'pdf', data: assertPdf(pdf, 'Cổng Viettel') } };
      }
      lastMessage = (res.message ?? '').replace(/\s*Mã hỗ trợ\s*:.*$/i, '').trim();

      // Lỗi tham số/ngày thì thử số hoá đơn khác cũng vô ích — dừng ngay.
      if (res.errorCode === 3 || res.errorCode === 4) break;
    }

    throw new PortalNotFoundError(
      lastMessage || 'Cổng Viettel Telecom không tìm thấy hoá đơn theo số hoá đơn và mã số bí mật này',
    );
  },
};

/** Ký hiệu + số hoá đơn viết liền, thử dạng đệm 8 chữ số trước rồi tới nguyên văn */
function invoiceNoCandidates(req: PortalRequest): string[] {
  const serial = (req.serial ?? '').trim().toUpperCase();
  const raw    = String(req.invoiceNumber ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  const out: string[] = [];
  if (serial && digits) out.push(serial + digits.padStart(8, '0'));
  if (serial && raw && !out.includes(serial + raw)) out.push(serial + raw);
  if (raw && !out.includes(raw)) out.push(raw);
  return out;
}

/** Khoảng ngày yyyy-MM-dd quanh ngày hoá đơn; không có ngày thì lấy 90 ngày gần nhất */
function window(invoiceDate: Date | null): { fromDate: string; toDate: string } {
  const day = 86_400_000;
  const anchor = invoiceDate && !Number.isNaN(invoiceDate.getTime()) ? invoiceDate : new Date();
  const from = new Date(anchor.getTime() - WINDOW_DAYS * day);
  const to   = new Date(Math.min(anchor.getTime() + WINDOW_DAYS * day, Date.now()));
  // Ngày hoá đơn trong tương lai (lệch múi giờ) sẽ cho khoảng rỗng — kéo về đúng thứ tự
  const end = to.getTime() < from.getTime() ? new Date(from.getTime() + WINDOW_DAYS * day) : to;
  return { fromDate: iso(from), toDate: iso(end) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Tìm nội dung PDF trong phản hồi. Chưa xác nhận được cổng đặt file ở khoá nào khi tìm
 * thấy, nên quét đệ quy mọi chuỗi: base64 mở đầu bằng %PDF- là file cần lấy.
 */
function findPdf(data: unknown, depth = 0): Buffer | null {
  if (depth > 4 || data === null || data === undefined) return null;

  if (typeof data === 'string') {
    if (data.length < 100) return null;
    try {
      const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
      if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
    } catch { /* không phải base64 — bỏ qua */ }
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const hit = findPdf(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      const hit = findPdf(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
