/**
 * EFY iHoaDon — CÔNG TY CỔ PHẦN CÔNG NGHỆ TIN HỌC EFY VIỆT NAM (MST 0102519041)
 *
 * Trang tra cứu http://tracuu.ihoadon.vn chuyển hướng về https://ihoadon.vn/kiem-tra/.
 * Biểu mẫu cần ĐÚNG HAI thứ mà hệ thống đã có sẵn trong hoá đơn:
 *   - Số hoá đơn      (ng-model certificate_id)
 *   - Mã tra cứu      (ng-model signature)
 *
 * API (đọc từ checkService của chính trang, đã gọi thật để xác nhận endpoint sống):
 *   POST https://ihoadon.vn/kiem-tra/check
 *        certificate_id=<số HĐ>&signature=<mã tra cứu>&gRecaptchaResponse=
 *   → sai mã: {"code":"VE001","status":"error","message":"Mã xác minh không đúng"}
 *   → đúng:   {status:"success", files:[…{base64_content}…], invoice:{…}}
 *
 * VỀ MÃ XÁC THỰC: cổng KHÔNG bắt reCAPTCHA cho lần tra bình thường — chỉ bật khi phía
 * cổng thấy bất thường, lúc đó phản hồi kèm require_captcha=1. reCAPTCHA của Google gắn
 * với tên miền của họ nên không thể đưa cho người dùng nhập trong giao diện INVONE, và
 * hệ thống cũng không được phép tự vượt qua. Gặp trường hợp đó thì báo người dùng mở
 * thẳng cổng EFY — đã có sẵn link mở đúng hoá đơn (?mtc=<mã>&shd=<số HĐ>).
 */
import {
  PortalDriver, PortalInputError, PortalManualOnlyError, PortalNotFoundError,
  PortalRequest, PortalStep,
} from '../types';

const CHECK_URL = 'https://ihoadon.vn/kiem-tra/check';

/** Link mở thẳng hoá đơn trên cổng EFY — tham số đọc từ $stateParams của trang */
export function efyDeepLink(code: string, invoiceNumber: string): string {
  return `https://ihoadon.vn/kiem-tra/?mtc=${encodeURIComponent(code)}` +
         `&shd=${encodeURIComponent(invoiceNumber)}`;
}

interface EfyFile { base64_content?: string; file_name?: string; type?: string }
interface EfyResponse {
  status?:  string;
  code?:    string;
  message?: string;
  require_captcha?: number;
  files?:   EfyFile[];
}

export const efyDriver: PortalDriver = {
  id:     'efy',
  name:   'EFY iHoaDon',
  status: 'unverified',
  requiresLookupCode: true,
  usesCaptcha: false,

  async begin(req: PortalRequest, http): Promise<PortalStep> {
    const code = (req.lookupCode ?? '').trim();
    const soHd = String(req.invoiceNumber ?? '').trim();
    if (!code) throw new PortalInputError('Hoá đơn không có mã tra cứu trong XML');
    if (!soHd) throw new PortalInputError('Hoá đơn thiếu số hoá đơn để tra cứu trên cổng EFY');

    const res = await http.postFormJson<EfyResponse>(CHECK_URL, {
      certificate_id: soHd,
      signature:      code,
      gRecaptchaResponse: '',
    }, { Referer: 'https://ihoadon.vn/kiem-tra/' });

    if (res.require_captcha === 1) {
      throw new PortalManualOnlyError(
        'Cổng EFY đang yêu cầu xác thực reCAPTCHA của Google — loại mã này chỉ nhập được ' +
        'trên chính trang của EFY. Bấm "Mở cổng tra cứu" để lấy bản gốc.',
      );
    }
    if (res.status !== 'success') {
      throw new PortalNotFoundError(
        (res.message ?? '').trim() || 'Cổng EFY không tìm thấy hoá đơn theo số hoá đơn và mã tra cứu này',
      );
    }

    const pdf = firstPdf(res.files);
    if (!pdf) throw new Error('Cổng EFY trả về kết quả nhưng không kèm file PDF bản thể hiện');
    return { kind: 'document', doc: { kind: 'pdf', data: pdf } };
  },
};

/** Cổng trả nhiều file (XML ký số, PDF, phụ lục) — lấy đúng file có dấu hiệu PDF */
function firstPdf(files: EfyFile[] | undefined): Buffer | null {
  for (const f of files ?? []) {
    const b64 = (f.base64_content ?? '').trim();
    if (!b64) continue;
    const buf = Buffer.from(b64, 'base64');
    if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
  }
  return null;
}
