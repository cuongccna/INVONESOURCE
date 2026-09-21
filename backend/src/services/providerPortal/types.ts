/**
 * Hợp đồng driver cho việc lấy BẢN GỐC THEO MẪU NHÀ CUNG CẤP trên cổng tra cứu công khai.
 *
 * KHÁC với lớp plugin ở bot (bot/src/providers/lookup): bên đó chạy tự động trong nền và
 * giải mã xác thực bằng dịch vụ 2Captcha. Lớp này chạy ĐỒNG BỘ theo thao tác của người
 * dùng, nên cổng nào bắt nhập mã xác thực thì ảnh được đẩy thẳng lên giao diện cho khách
 * tự nhập — không phụ thuộc dịch vụ giải captcha, và cũng không tốn tiền giải.
 *
 * NGUYÊN TẮC:
 *   1. Driver KHÔNG tự import axios. Mọi request đi qua PortalHttp do service cấp, nhờ đó
 *      timeout, User-Agent, giới hạn kích thước và hộp cookie luôn được áp dụng.
 *   2. Driver KHÔNG đụng database. Service lo lưu file và cập nhật hoá đơn.
 *   3. Driver chỉ ném lỗi; service là nơi duy nhất bắt lỗi và quyết định hiển thị gì.
 *   4. Thiếu dữ liệu hoá đơn (không có mã tra cứu) phải ném PortalInputError — đó là lỗi
 *      của hoá đơn chứ không phải cổng hỏng, nên không được tính vào ngắt mạch.
 */

/** Dữ liệu một lần tra cứu — service gom sẵn từ DB, driver chỉ đọc */
export interface PortalRequest {
  invoiceId:       string;
  companyId:       string;
  /** MST tổ chức cung cấp giải pháp (MSTTCGP) — khoá chọn driver */
  providerTaxCode: string | null;
  /** MST người bán; nhiều cổng bắt nhập kèm mã tra cứu */
  sellerTaxCode:   string | null;
  /** Mã tra cứu / mã số bí mật in trên hoá đơn */
  lookupCode:      string | null;
  /** Link cổng tra cứu đọc từ chính hoá đơn — cổng riêng theo người bán phải dùng cái này */
  lookupUrl:       string | null;
  /** Ký hiệu hoá đơn, vd C26TDL */
  serial:          string;
  /** Số hoá đơn */
  invoiceNumber:   string;
  /** Ngày hoá đơn — vài cổng bắt buộc khoảng ngày để thu hẹp phạm vi tìm */
  invoiceDate:     Date | null;
}

/** Kết quả cuối: PDF sẵn, hoặc HTML bản thể hiện của nhà cung cấp để service render */
export type PortalDocument =
  | { kind: 'pdf';  data: Buffer }
  | { kind: 'html'; html: string };

/**
 * Kết quả một bước.
 *   'document' — xong, không cần người dùng làm gì thêm
 *   'captcha'  — cổng bắt nhập mã xác thực; ảnh đẩy lên giao diện, `state` được service
 *                cất vào phiên để bước sau gọi complete() đúng ngữ cảnh
 */
export type PortalStep =
  | { kind: 'document'; doc: PortalDocument }
  | {
      kind: 'captcha';
      /** Ảnh dạng data URL, nhúng thẳng vào <img src> */
      imageDataUrl: string;
      /** Dữ liệu driver cần nhớ giữa hai bước (khoá phiên của cổng…) */
      state: Record<string, string>;
      /** Gợi ý hiển thị cạnh ô nhập, vd "5 chữ số" */
      hint?: string;
    };

/** Lỗi do dữ liệu hoá đơn — kết luận cuối, không thử lại, không tính lỗi cổng */
export class PortalInputError extends Error {
  readonly isInputError = true;
  constructor(message: string) { super(message); this.name = 'PortalInputError'; }
}

/** Cổng khẳng định không có hoá đơn này — kết luận cuối, không thử lại */
export class PortalNotFoundError extends Error {
  readonly isNotFound = true;
  constructor(message: string) { super(message); this.name = 'PortalNotFoundError'; }
}

/** Mã xác thực sai — cho người dùng nhập lại chứ không coi là cổng hỏng */
export class PortalCaptchaError extends Error {
  readonly isCaptchaError = true;
  constructor(message: string) { super(message); this.name = 'PortalCaptchaError'; }
}

/**
 * Cổng đòi thứ mà hệ thống không được phép tự vượt qua (reCAPTCHA của Google chẳng hạn).
 * Service trả về hướng dẫn mở cổng của nhà cung cấp thay vì cố lách.
 */
export class PortalManualOnlyError extends Error {
  readonly isManualOnly = true;
  constructor(message: string) { super(message); this.name = 'PortalManualOnlyError'; }
}

/** Lớp HTTP hạn chế mà service cấp cho driver */
export interface PortalHttp {
  getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
  getText(url: string, headers?: Record<string, string>): Promise<string>;
  getBinary(url: string, headers?: Record<string, string>): Promise<Buffer>;
  postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  /** POST không thân, tham số nằm trên query — dạng vài cổng dùng axios `params` */
  postQuery<T = unknown>(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<T>;
  /** POST form urlencoded, nhận HTML — dạng cổng ASP.NET dựng trang phía máy chủ */
  postForm(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<string>;
  /** POST form urlencoded, nhận JSON */
  postFormJson<T = unknown>(url: string, fields: Record<string, string>, headers?: Record<string, string>): Promise<T>;
  /**
   * POST form urlencoded, KHÔNG đi theo chuyển hướng và KHÔNG ném lỗi theo mã HTTP.
   *
   * Cổng ASP.NET dựng trang phía máy chủ (VNPT) trả 302 về trang chủ khi mã xác thực sai
   * và 200 kèm trang kết quả khi đúng. Đi theo chuyển hướng thì cả hai đều thành 200 và
   * không còn phân biệt được — nên driver cần thấy đúng mã trạng thái gốc.
   */
  postFormNoRedirect(
    url: string, fields: Record<string, string>, headers?: Record<string, string>,
  ): Promise<{ status: number; location: string | null; body: string }>;
  /** Xuất hộp cookie để cất vào phiên giữa hai bước captcha */
  exportCookies(): Record<string, string>;
}

/** Cấu hình đọc từ einvoice_providers cho driver cần địa chỉ động */
export interface PortalDriverConfig {
  /** einvoice_providers.lookup_api_base */
  apiBase:  string | null;
  /** Tên hiển thị của nhà cung cấp */
  name:     string;
}

/**
 * Ngữ cảnh của CHÍNH HOÁ ĐƠN đang tra, dùng lúc dựng driver.
 *
 * Vì sao cần: ngày càng nhiều nhà cung cấp cấp cho MỖI TÀI KHOẢN HĐĐT một cổng riêng —
 * VNPT là `https://<mã>-tt78.vnpt-invoice.com.vn`, EasyInvoice là `<MST>hd.easyinvoice.com.vn`,
 * nền tảng xcyber chạy song song tracuuhoadon1/tracuuhoadon2. Địa chỉ đúng nằm trong chính
 * hoá đơn (hoặc do người dùng dán vào), KHÔNG nằm trong danh bạ — nên driver phải nhận được
 * link đó thay vì gắn cứng một máy chủ.
 */
export interface PortalDriverContext {
  /** Link tra cứu của hoá đơn: đọc từ XML hoặc do người dùng dán vào */
  lookupUrl: string | null;
}

/** Gốc (scheme + host) của một link tra cứu; null nếu link không dùng được */
export function portalOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export interface PortalDriver {
  /** Định danh driver, khớp cột einvoice_providers.lookup_adapter */
  id:   string;
  /** Tên hiển thị trong thông báo và cột provider_pdf_source */
  name: string;
  /**
   * 'verified'   — đã gọi thật vào cổng và lấy được bản gốc
   * 'unverified' — hợp đồng tham số đã kiểm nhưng chưa chạy trọn vẹn trên hoá đơn thật
   */
  status: 'verified' | 'unverified';
  /** Thiếu mã tra cứu thì service dừng sớm, không tốn request ra ngoài */
  requiresLookupCode: boolean;
  /** true = cổng luôn bắt nhập mã xác thực; giao diện chuẩn bị sẵn ô nhập */
  usesCaptcha: boolean;

  /** Bước 1 — mở phiên. Trả 'document' nếu cổng không bắt captcha. */
  begin(req: PortalRequest, http: PortalHttp): Promise<PortalStep>;

  /** Bước 2 — chỉ gọi khi begin() trả 'captcha'. */
  complete?(
    req: PortalRequest,
    http: PortalHttp,
    state: Record<string, string>,
    captchaAnswer: string,
  ): Promise<PortalDocument>;
}
