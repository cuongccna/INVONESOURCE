/**
 * Hợp đồng cho plugin lấy bản gốc PDF trên CỔNG TRA CỨU CÔNG KHAI của nhà cung cấp HĐĐT.
 *
 * KHÁC với provider-invoice.service.ts: bên đó gọi API nhà cung cấp bằng TÀI KHOẢN của
 * chính doanh nghiệp, nên chỉ dùng được cho hoá đơn ĐẦU RA. Plugin ở đây đi cổng tra cứu
 * công khai bằng "Mã tra cứu" in trên hoá đơn, nên lấy được cả hoá đơn ĐẦU VÀO —
 * đúng thứ người dùng cần khi muốn xem bản có logo của nhà cung cấp.
 *
 * NGUYÊN TẮC THIẾT KẾ — plugin không được làm gãy app:
 *   1. Adapter KHÔNG tự import axios/fetch. Mọi request đi qua LookupHttp do runner cấp,
 *      nhờ đó timeout, User-Agent và giới hạn kích thước luôn được áp dụng.
 *   2. Adapter chỉ ném lỗi; runner là nơi duy nhất bắt lỗi, đếm hỏng, ngắt mạch.
 *   3. Adapter KHÔNG đụng vào database. Runner ghi kết quả.
 *   4. Thiếu dữ liệu đầu vào (không có mã tra cứu) phải ném InputError — lỗi của hoá đơn,
 *      không phải cổng hỏng, nên không được tính vào circuit breaker.
 */

/** Dữ liệu một lần tra cứu — runner gom sẵn từ DB, adapter chỉ đọc */
export interface LookupRequest {
  invoiceId:       string;
  companyId:       string;
  /** MST tổ chức cung cấp giải pháp (MSTTCGP) — khoá chọn adapter */
  providerTaxCode: string | null;
  /** MST người bán, nhiều cổng bắt nhập kèm mã tra cứu */
  sellerTaxCode:   string | null;
  /** Mã tra cứu / mã số bí mật in trên hoá đơn */
  lookupCode:      string | null;
  /** Link tra cứu đọc từ chính hoá đơn — cổng riêng theo người bán thì phải dùng cái này */
  lookupUrl:       string | null;
  /** Ký hiệu hoá đơn, vd C26TDL */
  serial:          string;
  /** Số hoá đơn */
  invoiceNumber:   string;
}

/** Lỗi do dữ liệu hoá đơn, KHÔNG tính vào circuit breaker của cổng */
export class LookupInputError extends Error {
  readonly isInputError = true;
  constructor(message: string) {
    super(message);
    this.name = 'LookupInputError';
  }
}

/** Cổng trả lời rõ ràng là "không có hoá đơn này" — dừng hẳn, không retry */
export class LookupNotFoundError extends Error {
  readonly isNotFound = true;
  constructor(message: string) {
    super(message);
    this.name = 'LookupNotFoundError';
  }
}

/**
 * Lớp HTTP hạn chế mà runner cấp cho adapter.
 * Không có method ghi (POST tuỳ cổng mới mở) — tra cứu là thao tác chỉ đọc.
 */
export interface LookupHttp {
  /** GET trả JSON đã parse; ném lỗi nếu HTTP không phải 2xx */
  getJson<T = unknown>(url: string, opts?: { headers?: Record<string, string> }): Promise<T>;
  /** GET trả nội dung nhị phân (PDF); ném lỗi nếu quá kích thước cho phép */
  getBinary(url: string, opts?: { headers?: Record<string, string> }): Promise<Buffer>;
  /** GET trả nội dung văn bản (HTML của cổng dựng sẵn trên máy chủ) */
  getText(url: string, opts?: { headers?: Record<string, string> }): Promise<string>;
  /** POST JSON trả JSON — chỉ dùng khi cổng bắt buộc POST cho thao tác tra cứu */
  postJson<T = unknown>(url: string, body: unknown, opts?: { headers?: Record<string, string> }): Promise<T>;
  /** POST form urlencoded trả HTML — dạng cổng ASP.NET dựng trang phía máy chủ */
  postForm(url: string, fields: Record<string, string>, opts?: { headers?: Record<string, string> }): Promise<string>;
  /**
   * Giải captcha ảnh (qua 2Captcha). Ném lỗi nếu chưa cấu hình khoá dịch vụ.
   * Runner cung cấp để adapter không phải tự biết dùng dịch vụ nào.
   */
  solveCaptcha(imageBase64: string, hints?: { minLen?: number; maxLen?: number }): Promise<string>;
}

/**
 * Kết quả adapter trả về.
 *
 * Nhiều cổng không đưa PDF sẵn mà dựng HTML bản thể hiện (đúng mẫu, đúng logo của họ);
 * runner sẽ render HTML đó thành PDF bằng Chromium — cùng cách đang dùng cho gói của
 * cổng thuế, nên kết quả đồng nhất.
 */
export type LookupDocument =
  | { kind: 'pdf';  data: Buffer }
  | { kind: 'html'; html: string };

export interface LookupAdapter {
  /** Định danh plugin, khớp cột einvoice_providers.lookup_adapter */
  id:   string;
  /** Tên hiển thị trong log và cột provider_pdf_source */
  name: string;
  /**
   * Trạng thái kiểm chứng của plugin:
   *   'verified'   — đã gọi thật vào cổng và lấy được PDF
   *   'unverified' — viết theo tài liệu/quan sát, CHƯA chạy thật ⇒ mặc định tắt trong DB
   */
  status: 'verified' | 'unverified';
  /** Có bắt buộc mã tra cứu không — thiếu thì runner bỏ qua sớm, không tốn request */
  requiresLookupCode: boolean;
  /** true = adapter cần giải captcha, runner bỏ qua sớm nếu chưa cấu hình 2Captcha */
  needsCaptcha?: boolean;
  /** Lấy bản gốc; ném lỗi nếu không lấy được. Runner lo phần còn lại. */
  fetchPdf(req: LookupRequest, http: LookupHttp): Promise<LookupDocument>;
}
