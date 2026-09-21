/**
 * EInvoiceProviderService — nhà cung cấp HĐĐT và đường lấy bản gốc của họ
 *
 * PHÂN BIỆT 3 THỨ (rất hay bị nhầm):
 *   1. XML ký số            — bản gốc hợp pháp, có chữ ký người bán + chữ ký cấp mã CQT.
 *                             Hệ thống tải trực tiếp từ cổng thuế.
 *   2. Bản thể hiện cổng Thuế — PDF do INVONE render từ invoice.html trong gói ZIP của
 *                             hoadondientu.gdt.gov.vn. Đúng dữ liệu, nhưng là MẪU CỦA CỔNG THUẾ.
 *   3. Bản của nhà cung cấp  — PDF theo mẫu riêng của Viettel / MISA / VNPT / EFY…
 *                             KHÔNG có trong dữ liệu cổng thuế; chỉ lấy được trên cổng tra cứu
 *                             của chính nhà cung cấp bằng "Mã tra cứu"/"Mã số bí mật",
 *                             hoặc qua API nhà cung cấp khi công ty đã cấu hình kết nối.
 *
 * Service này cung cấp thông tin cho (3): nhà cung cấp là ai, mã tra cứu là gì,
 * mở cổng nào để tải bản gốc theo mẫu nhà cung cấp.
 */
import { pool } from '../db/pool';
import { providerPortalService, PortalCapability } from './providerPortal';

export interface ProviderInfo {
  tax_code:   string;
  name:       string;
  short_name: string | null;
  portal_url: string | null;
  code_label: string;
  note:       string | null;
  /** Mẫu link mở thẳng hoá đơn trên cổng, vd https://…/?lookupCode={code} */
  lookup_url_template: string | null;
  /** true = có trong danh bạ đã kiểm chứng; false = chỉ suy ra tên từ cache tra cứu MST */
  known:      boolean;
}

export interface OriginalSources {
  provider:       ProviderInfo | null;
  lookup_code:    string | null;
  lookup_label:   string | null;
  /** Cổng tra cứu lấy từ chính hoá đơn (ưu tiên) hoặc từ danh bạ nhà cung cấp */
  lookup_url:     string | null;
  seller_tax_code: string | null;
  seller_name:    string | null;
  invoice_label:  string;
  /** Bản thể hiện do cổng thuế phát hành (INVONE render từ gói ZIP của GDT) */
  gdt_representation: {
    pdf_status: string;
    has_pdf:    boolean;
    pdf_size:   number | null;
    xml_status: string;
    has_xml:    boolean;
    xml_size:   number | null;
  };
  /** Bản PDF theo mẫu riêng của nhà cung cấp (lấy qua API của họ) */
  provider_pdf: {
    status:       string;
    has_pdf:      boolean;
    size:         number | null;
    source:       string | null;
    error:        string | null;
    /** Nhà cung cấp này có adapter tự động trong hệ thống không */
    automatable:  boolean;
    /** Công ty đã cấu hình tài khoản nhà cung cấp chưa */
    connected:    boolean;
  };
  /**
   * Tra cứu ngay trên cổng công khai của nhà cung cấp bằng mã tra cứu in trong hoá đơn.
   * Không cần tài khoản nên chạy được cả hoá đơn đầu vào; cổng nào bắt mã xác thực thì
   * giao diện hiện ảnh cho người dùng nhập.
   */
  portal_lookup: PortalCapability;
}

/**
 * MST nhà cung cấp có adapter tải PDF qua API bằng TÀI KHOẢN của công ty
 * (khớp bot/src/provider-invoice.service.ts). Chỉ áp dụng cho hoá đơn đầu ra.
 *
 * Đường thứ hai — tải qua CỔNG TRA CỨU CÔNG KHAI bằng mã tra cứu — không cần tài khoản
 * và chạy được cả hoá đơn đầu vào; đường đó bật/tắt trong einvoice_providers.lookup_enabled
 * nên đọc từ DB chứ không liệt kê ở đây.
 */
const AUTOMATABLE_PROVIDERS: Record<string, 'viettel' | 'misa' | 'bkav'> = {
  '0100109106': 'viettel',
};

/**
 * Đọc toàn bộ cặp (tên trường, giá trị) trong khối <TTKhac> của XML hoá đơn.
 *
 * Thứ tự các thẻ con KHÔNG cố định giữa các nhà cung cấp — có nơi ghi
 * <TTruong>…</TTruong><KDLieu>…</KDLieu><DLieu>…</DLieu>, có nơi đảo ngược. Vì vậy đọc
 * theo từng khối <TTin> rồi bóc riêng hai thẻ, thay vì khớp cả chuỗi theo một thứ tự.
 */
function ttKhacEntries(xml: string): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  const blockRe = /<TTin>([\s\S]*?)<\/TTin>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1] ?? '';
    const field = /<TTruong>([^<]*)<\/TTruong>/.exec(block)?.[1]?.trim() ?? '';
    const value = /<DLieu>([^<]*)<\/DLieu>/.exec(block)?.[1]?.trim() ?? '';
    if (field && value) out.push({ field, value });
  }
  return out;
}

/** Bỏ dấu tiếng Việt + ký tự ngăn cách để so tên trường bất kể cách viết */
function normalizeFieldName(s: string): string {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Tên trường chứa MÃ tra cứu — đã đối chiếu dữ liệu hoá đơn thật đang lưu:
 *   "Mã tra cứu" (M-Invoice, Win Tech)  "MaTraCuu" (CyberLotus)
 *   "Mã số bí mật" (Viettel)           "Fkey" (SoftDreams / EasyInvoice)
 */
const LOOKUP_CODE_FIELDS: Record<string, string> = {
  matracuu:    'Mã tra cứu',
  masobimat:   'Mã số bí mật',
  masobaomat:  'Mã số bảo mật',
  mabaomat:    'Mã bảo mật',
  fkey:        'Mã tra cứu',
  lookupcode:  'Mã tra cứu',
  searchcode:  'Mã tra cứu',
  secretcode:  'Mã số bí mật',
};

/** Tên trường chứa ĐƯỜNG LINK tra cứu — "PortalLink" là dạng hay gặp nhất */
const LOOKUP_URL_FIELDS = new Set([
  'portallink', 'portalurl', 'linktracuu', 'linktracuunguoiban',
  'websitetracuu', 'diachitracuu', 'duongdantracuu', 'tracuutai', 'website',
]);

/** Trích mã tra cứu của nhà cung cấp trong TTKhac của XML */
export function extractLookupCode(xml: string | null): { code: string | null; label: string | null } {
  if (!xml) return { code: null, label: null };

  for (const { field, value } of ttKhacEntries(xml)) {
    const label = LOOKUP_CODE_FIELDS[normalizeFieldName(field)];
    // Loại giá trị là URL: đó là link tra cứu, không phải mã
    if (label && !/^https?:\/\//i.test(value)) return { code: value, label };
  }
  return { code: null, label: null };
}

/**
 * Trích ĐƯỜNG LINK tra cứu đi kèm trong file hoá đơn.
 *
 * Gần như hoá đơn nào cũng ghi cổng tra cứu của nhà cung cấp trong <TTKhac>, cạnh mã
 * tra cứu — và đây là nguồn CHÍNH XÁC NHẤT, hơn cả danh bạ, vì nhiều nhà cung cấp chạy
 * cổng riêng theo tỉnh hoặc theo từng khách hàng lớn.
 *
 * Thứ tự ưu tiên:
 *   1. Trường có tên gợi ý tra cứu ("Website tra cứu", "Tra cứu tại", "Link tra cứu"…)
 *   2. URL bất kỳ trong TTKhac — hoá đơn hiếm khi nhét URL nào khác vào đây
 */
export function extractLookupUrl(xml: string | null): string | null {
  if (!xml) return null;

  /** Chuẩn hoá về URL dùng được; chấp nhận cả dạng ghi thiếu http:// */
  const clean = (raw: string): string | null => {
    const v = raw.trim().replace(/[.,;)]+$/, '');
    if (/^https?:\/\/\S+$/i.test(v)) return v;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) return `https://${v}`;
    return null;
  };

  const entries = ttKhacEntries(xml);

  // 1. Trường có tên nói rõ là link tra cứu
  for (const { field, value } of entries) {
    if (LOOKUP_URL_FIELDS.has(normalizeFieldName(field))) {
      const u = clean(value);
      if (u) return u;
    }
  }

  // 2. URL bất kỳ trong TTKhac — hoá đơn hiếm khi nhét URL nào khác vào đây
  for (const { value } of entries) {
    if (/^https?:\/\//i.test(value)) {
      const u = clean(value);
      if (u) return u;
    }
  }
  return null;
}

/**
 * MST TỔ CHỨC CUNG CẤP GIẢI PHÁP hoá đơn điện tử — thẻ <MSTTCGP> trong XML hoá đơn.
 *
 * ĐÂY MỚI LÀ ĐƠN VỊ CÓ CỔNG TRA CỨU, không phải trường tvandnkntt mà cổng thuế trả về.
 * tvandnkntt là tổ chức T-VAN nhận/truyền/lưu trữ dữ liệu tới cơ quan thuế — hai bên
 * thường khác nhau. Đối chiếu dữ liệu thật:
 *
 *   MSTTCGP 0106870211 (ICORP / Viet-Invoice) — tvandnkntt 0312303803 (Win Tech)
 *   MSTTCGP 0106166781 (NCCA)                 — tvandnkntt 0106026495 (M-Invoice)
 *
 * Ngoài ra tvandnkntt hay rỗng trong dữ liệu cổng thuế, còn MSTTCGP thì luôn có trong
 * XML — nên tra theo MSTTCGP nhận diện được nhiều hoá đơn hơn hẳn.
 */
export function extractSolutionProviderTaxCode(xml: string | null): string | null {
  if (!xml) return null;
  const m = /<MSTTCGP>\s*([0-9-]{10,15})\s*<\/MSTTCGP>/.exec(xml);
  return m?.[1]?.trim() || null;
}

/** Tên miền của một URL, chữ thường, bỏ "www." — dùng để tra danh bạ nhà cung cấp */
export function urlDomain(url: string | null): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([^/:?#]+)/i.exec(url.trim());
  return m?.[1] ? m[1].toLowerCase().replace(/^www\./, '') : null;
}

/**
 * Đọc LINK + MÃ TRA CỨU từ đoạn chữ người dùng dán vào.
 *
 * VÌ SAO CẦN: hoá đơn KHÔNG MÃ của cơ quan thuế (Viettel, EFY, VNPT…) không có bản gốc
 * trên hệ thống GDT, nên hệ thống không có XML để trích mã. Thứ duy nhất tồn tại là đoạn
 * chữ người bán gửi kèm hoá đơn qua email, đúng dạng:
 *
 *   Ðể xem chi tiết hóa đơn, Quý khách hàng vui lòng truy cập địa chỉ trang portal tra cứu
 *   hóa đơn: https://1800546671-tt78.vnpt-invoice.com.vn
 *   - Mã tra cứu hóa đơn: N2026V1784027764590108530K017313
 *
 * Dán nguyên đoạn đó vào là đủ để hệ thống biết cổng nào và mã nào — không bắt người dùng
 * tự tách từng phần.
 */
export function parsePastedLookupInfo(text: string): { url: string | null; code: string | null } {
  const src = String(text ?? '').slice(0, 4000);

  // ── Link ──────────────────────────────────────────────────────────────────
  const urlMatch = /https?:\/\/[^\s<>"')]+/i.exec(src);
  let url = urlMatch?.[0]?.replace(/[.,;:)\]]+$/, '') ?? null;
  if (url && !/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(url)) url = null;

  // ── Mã ────────────────────────────────────────────────────────────────────
  // Ưu tiên mã đứng ngay sau nhãn quen thuộc; nhãn viết kiểu gì cũng bắt được.
  const labelled =
    /(?:m[ãa]\s*(?:tra\s*c[ứu]u|s[ốo]\s*b[íi]\s*m[ậa]t|s[ốo]\s*b[ảa]o\s*m[ậa]t|b[ảa]o\s*m[ậa]t|nh[ậa]n\s*h[óo]a\s*đ[ơo]n|x[áa]c\s*th[ựu]c\s*h[óo]a\s*đ[ơo]n)|fkey|lookup\s*code|search\s*code)[^\n:：]*[:：]?\s*([A-Za-z0-9._-]{6,64})/i
      .exec(src);
  let code = labelled?.[1] ?? null;

  // Không có nhãn: lấy chuỗi chữ-số dài nhất KHÔNG nằm trong link (mã tra cứu bao giờ
  // cũng dài và trộn chữ với số, khác hẳn số hoá đơn hay MST).
  if (!code) {
    const outside = url ? src.split(url).join(' ') : src;
    const cands = (outside.match(/\b[A-Za-z0-9]{8,64}\b/g) ?? [])
      .filter(t => /[A-Za-z]/.test(t) && /[0-9]/.test(t));
    code = cands.sort((a, b) => b.length - a.length)[0] ?? null;
  }

  return { url, code: code?.trim() || null };
}

export class EInvoiceProviderService {

  /**
   * Thông tin nhà cung cấp theo MST đơn vị cung cấp giải pháp (tvandnkntt).
   * Chưa có trong danh bạ thì lấy tên từ cache tra cứu MST để vẫn hiển thị được.
   */
  async resolve(taxCode: string | null): Promise<ProviderInfo | null> {
    if (!taxCode) return null;

    const known = await pool.query<{
      tax_code: string; name: string; short_name: string | null;
      portal_url: string | null; code_label: string; note: string | null;
      lookup_url_template: string | null;
    }>(
      `SELECT tax_code, name, short_name, portal_url, code_label, note, lookup_url_template
         FROM einvoice_providers WHERE tax_code = $1`,
      [taxCode],
    );
    if (known.rows[0]) return { ...known.rows[0], known: true };

    const cached = await pool.query<{ company_name: string | null }>(
      `SELECT company_name FROM company_verification_cache WHERE tax_code = $1`,
      [taxCode],
    );
    return {
      tax_code:   taxCode,
      name:       cached.rows[0]?.company_name ?? `MST ${taxCode}`,
      short_name: null,
      portal_url: null,
      code_label: 'Mã tra cứu',
      note:       null,
      lookup_url_template: null,
      known:      false,
    };
  }

  /**
   * Nhận diện nhà cung cấp NGƯỢC từ link tra cứu in trong hoá đơn.
   *
   * Dùng khi hoá đơn không có MST đơn vị cung cấp giải pháp (hoá đơn tự phát hành,
   * hoặc dữ liệu cổng thuế thiếu trường tvandnkntt): chỉ còn mã tra cứu + link, mà link
   * đã đủ để biết vào đâu tra.
   */
  async resolveByUrl(url: string | null): Promise<ProviderInfo | null> {
    const domain = urlDomain(url);
    if (!domain) return null;

    const { rows } = await pool.query<{
      tax_code: string; name: string; short_name: string | null;
      portal_url: string | null; code_label: string; note: string | null;
      lookup_url_template: string | null;
    }>(
      `SELECT tax_code, name, short_name, portal_url, code_label, note, lookup_url_template
         FROM einvoice_providers
        WHERE portal_domain = $1
           OR portal_domain LIKE '%.' || $1
           OR $1 LIKE '%.' || portal_domain
        ORDER BY length(portal_domain) DESC
        LIMIT 1`,
      [domain],
    );
    if (rows[0]) return { ...rows[0], known: true };

    // Không có trong danh bạ: vẫn trả về những gì suy được từ chính hoá đơn,
    // để giao diện chỉ đúng cổng thay vì báo "không rõ nhà cung cấp".
    return {
      tax_code:   '',
      name:       domain,
      short_name: domain,
      portal_url: url,
      code_label: 'Mã tra cứu',
      note:       'Nhà cung cấp suy ra từ link tra cứu in trong hoá đơn',
      lookup_url_template: null,
      known:      false,
    };
  }

  /** Tất cả nguồn lấy bản gốc của một hoá đơn */
  async getOriginalSources(companyId: string, invoiceId: string): Promise<OriginalSources | null> {
    const { rows } = await pool.query<{
      invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; seller_name: string | null;
      gdt_tvandnkntt: string | null; provider_solution_tax_code: string | null;
      provider_lookup_code: string | null; provider_lookup_label: string | null;
      provider_lookup_url: string | null;
      raw_xml: string | null;
      pdf_status: string; has_pdf: boolean; pdf_size: number | null;
      xml_status: string; has_xml: boolean; xml_size: number | null;
      provider_pdf_status: string; has_provider_pdf: boolean;
      provider_pdf_size: number | null; provider_pdf_source: string | null;
      provider_pdf_error: string | null;
    }>(
      `SELECT invoice_number, serial_number, seller_tax_code, seller_name, gdt_tvandnkntt,
              provider_solution_tax_code,
              provider_lookup_code, provider_lookup_label, provider_lookup_url,
              CASE WHEN provider_lookup_code IS NULL OR provider_lookup_url IS NULL
                        OR provider_solution_tax_code IS NULL
                   THEN raw_xml ELSE NULL END AS raw_xml,
              COALESCE(pdf_status,'unknown') AS pdf_status,
              (pdf_path IS NOT NULL)         AS has_pdf,
              pdf_size,
              COALESCE(xml_status,'unknown') AS xml_status,
              (raw_xml IS NOT NULL)          AS has_xml,
              raw_xml_size                   AS xml_size,
              COALESCE(provider_pdf_status,'unknown') AS provider_pdf_status,
              (provider_pdf_path IS NOT NULL)         AS has_provider_pdf,
              provider_pdf_size, provider_pdf_source, provider_pdf_error
         FROM invoices
        WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [invoiceId, companyId],
    );
    const inv = rows[0];
    if (!inv) return null;

    // Chưa có mã / link tra cứu nhưng đã có XML → trích ngay và lưu lại cho lần sau
    let code  = inv.provider_lookup_code;
    let label = inv.provider_lookup_label;
    let url   = inv.provider_lookup_url;
    let mstGiaiPhap = inv.provider_solution_tax_code;
    if ((!code || !url || !mstGiaiPhap) && inv.raw_xml) {
      if (!code) {
        const extracted = extractLookupCode(inv.raw_xml);
        code  = extracted.code;
        label = extracted.label;
      }
      if (!url) url = extractLookupUrl(inv.raw_xml);
      if (!mstGiaiPhap) mstGiaiPhap = extractSolutionProviderTaxCode(inv.raw_xml);
      if (code || url || mstGiaiPhap) {
        await pool.query(
          `UPDATE invoices
              SET provider_lookup_code       = COALESCE($2, provider_lookup_code),
                  provider_lookup_label      = COALESCE($3, provider_lookup_label),
                  provider_lookup_url        = COALESCE($4, provider_lookup_url),
                  provider_solution_tax_code = COALESCE($5, provider_solution_tax_code)
            WHERE id = $1`,
          [invoiceId, code, label, url, mstGiaiPhap],
        ).catch(() => undefined);
      }
    }

    // Nguồn hoá đơn, theo đúng thứ tự đáng tin:
    //   1. MSTTCGP — đơn vị cung cấp giải pháp, chính là bên có cổng tra cứu
    //   2. tvandnkntt — tổ chức T-VAN, chỉ dùng khi XML không có MSTTCGP
    //   3. tên miền của link in trong hoá đơn
    const provider = (await this.resolve(mstGiaiPhap))
      ?? (await this.resolve(inv.gdt_tvandnkntt))
      ?? (await this.resolveByUrl(url));

    // Nhà cung cấp có adapter tự động + công ty đã kết nối tài khoản chưa
    const connectorKind = inv.gdt_tvandnkntt ? AUTOMATABLE_PROVIDERS[inv.gdt_tvandnkntt] : undefined;
    let connected = false;
    if (connectorKind) {
      const c = await pool.query(
        `SELECT 1 FROM company_connectors
          WHERE company_id = $1 AND provider = $2::invoice_provider AND enabled = true LIMIT 1`,
        [companyId, connectorKind],
      );
      connected = c.rows.length > 0;
    }

    // Đường cổng tra cứu công khai: có plugin đang bật cho nhà cung cấp này không.
    // Không cần tài khoản nên áp dụng được cho cả hoá đơn đầu vào.
    let portalAutomatable = false;
    if (mstGiaiPhap ?? inv.gdt_tvandnkntt) {
      const p = await pool.query(
        `SELECT 1 FROM einvoice_providers
          WHERE tax_code = $1 AND lookup_adapter IS NOT NULL AND lookup_enabled = true LIMIT 1`,
        [mstGiaiPhap ?? inv.gdt_tvandnkntt],
      ).catch(() => ({ rows: [] as unknown[] }));
      portalAutomatable = p.rows.length > 0;
    }

    // Link mở thẳng hoá đơn (deep link) là tốt nhất — người dùng bấm một phát ra đúng
    // hoá đơn, không phải gõ lại mã. Sau đó mới tới link in trong hoá đơn, rồi trang
    // tra cứu chung của nhà cung cấp.
    // Cổng công khai có driver tra cứu tương tác không (nhận diện theo MSTTCGP → T-VAN →
    // tên miền link in trong hoá đơn, giống hệt lúc thật sự đi tra)
    const portalLookup = await providerPortalService.capability({
      solutionTaxCode: mstGiaiPhap,
      tvanTaxCode:     inv.gdt_tvandnkntt,
      lookupUrl:       url,
      sellerTaxCode:   inv.seller_tax_code,
    });

    const deepLink = provider?.lookup_url_template && code
      ? provider.lookup_url_template
          .replace('{code}', encodeURIComponent(code))
          .replace('{mst}', encodeURIComponent(inv.seller_tax_code ?? ''))
          .replace('{no}',  encodeURIComponent(inv.invoice_number ?? ''))
      : null;
    const lookupUrl = deepLink ?? url ?? provider?.portal_url ?? null;

    return {
      provider:        provider && !provider.portal_url && lookupUrl
                         ? { ...provider, portal_url: lookupUrl }
                         : provider,
      lookup_code:     code,
      lookup_label:    label ?? 'Mã tra cứu',
      lookup_url:      lookupUrl,
      seller_tax_code: inv.seller_tax_code,
      seller_name:     inv.seller_name,
      invoice_label:   `${inv.serial_number ?? ''}-${inv.invoice_number}`,
      gdt_representation: {
        pdf_status: inv.pdf_status,
        has_pdf:    inv.has_pdf,
        pdf_size:   inv.pdf_size,
        xml_status: inv.xml_status,
        has_xml:    inv.has_xml,
        xml_size:   inv.xml_size,
      },
      provider_pdf: {
        status:      inv.provider_pdf_status,
        has_pdf:     inv.has_provider_pdf,
        size:        inv.provider_pdf_size,
        source:      inv.provider_pdf_source,
        error:       inv.provider_pdf_error,
        // Tải tự động được nếu có API theo tài khoản HOẶC có plugin cổng công khai đang bật
        automatable: !!connectorKind || portalAutomatable || portalLookup.supported,
        connected:   connected || portalAutomatable || portalLookup.supported,
      },
      portal_lookup: portalLookup,
    };
  }
}

export const einvoiceProviderService = new EInvoiceProviderService();
