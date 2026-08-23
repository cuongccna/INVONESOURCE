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

export interface ProviderInfo {
  tax_code:   string;
  name:       string;
  short_name: string | null;
  portal_url: string | null;
  code_label: string;
  note:       string | null;
  /** true = có trong danh bạ đã kiểm chứng; false = chỉ suy ra tên từ cache tra cứu MST */
  known:      boolean;
}

export interface OriginalSources {
  provider:       ProviderInfo | null;
  lookup_code:    string | null;
  lookup_label:   string | null;
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
}

/** MST nhà cung cấp có adapter tải PDF tự động (khớp bot/src/provider-invoice.service.ts) */
const AUTOMATABLE_PROVIDERS: Record<string, 'viettel' | 'misa' | 'bkav'> = {
  '0100109106': 'viettel',
};

/** Trích mã tra cứu của nhà cung cấp trong TTKhac của XML (2 thứ tự trường đều gặp) */
export function extractLookupCode(xml: string | null): { code: string | null; label: string | null } {
  if (!xml) return { code: null, label: null };

  const patterns: Array<[RegExp, 1 | 2]> = [
    [/<TTruong>(Mã tra cứu|Mã số bí mật)<\/TTruong><KDLieu>[^<]*<\/KDLieu><DLieu>([^<]+)<\/DLieu>/, 2],
    [/<DLieu>([^<]+)<\/DLieu><KDLieu>[^<]*<\/KDLieu><TTruong>(Mã tra cứu|Mã số bí mật)<\/TTruong>/, 1],
  ];

  for (const [re, codeGroup] of patterns) {
    const m = re.exec(xml);
    if (m) {
      const code = (m[codeGroup] ?? '').trim();
      const label = (codeGroup === 2 ? m[1] : m[2]) ?? 'Mã tra cứu';
      if (code) return { code, label };
    }
  }
  return { code: null, label: null };
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
    }>(
      `SELECT tax_code, name, short_name, portal_url, code_label, note
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
      known:      false,
    };
  }

  /** Tất cả nguồn lấy bản gốc của một hoá đơn */
  async getOriginalSources(companyId: string, invoiceId: string): Promise<OriginalSources | null> {
    const { rows } = await pool.query<{
      invoice_number: string; serial_number: string | null;
      seller_tax_code: string | null; seller_name: string | null;
      gdt_tvandnkntt: string | null;
      provider_lookup_code: string | null; provider_lookup_label: string | null;
      raw_xml: string | null;
      pdf_status: string; has_pdf: boolean; pdf_size: number | null;
      xml_status: string; has_xml: boolean; xml_size: number | null;
      provider_pdf_status: string; has_provider_pdf: boolean;
      provider_pdf_size: number | null; provider_pdf_source: string | null;
      provider_pdf_error: string | null;
    }>(
      `SELECT invoice_number, serial_number, seller_tax_code, seller_name, gdt_tvandnkntt,
              provider_lookup_code, provider_lookup_label,
              CASE WHEN provider_lookup_code IS NULL THEN raw_xml ELSE NULL END AS raw_xml,
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

    // Chưa có mã tra cứu nhưng đã có XML → trích ngay và lưu lại cho lần sau
    let code = inv.provider_lookup_code;
    let label = inv.provider_lookup_label;
    if (!code && inv.raw_xml) {
      const extracted = extractLookupCode(inv.raw_xml);
      code = extracted.code;
      label = extracted.label;
      if (code) {
        await pool.query(
          `UPDATE invoices SET provider_lookup_code = $2, provider_lookup_label = $3 WHERE id = $1`,
          [invoiceId, code, label],
        ).catch(() => undefined);
      }
    }

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

    return {
      provider:        await this.resolve(inv.gdt_tvandnkntt),
      lookup_code:     code,
      lookup_label:    label ?? 'Mã tra cứu',
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
        automatable: !!connectorKind,
        connected,
      },
    };
  }
}

export const einvoiceProviderService = new EInvoiceProviderService();
