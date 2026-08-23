/**
 * ProviderInvoiceService — lấy PDF hoá đơn theo MẪU RIÊNG CỦA NHÀ CUNG CẤP
 *
 * Vì sao cần: cổng thuế chỉ lưu XML ký số + bản thể hiện do CỔNG THUẾ dựng.
 * Bản PDF mang thương hiệu/mẫu của nhà cung cấp (Viettel S-Invoice, MISA meInvoice…)
 * chỉ nằm trên hệ thống của chính nhà cung cấp. Có 2 đường lấy:
 *
 *   1. API nhà cung cấp — cần tài khoản của công ty (Cài đặt → Kết nối hoá đơn).
 *      Áp dụng cho hoá đơn ĐẦU RA do công ty phát hành. Đây là những gì file này làm.
 *   2. Cổng tra cứu công khai — dùng "Mã tra cứu"/"Mã số bí mật" + captcha, người dùng
 *      tự mở từ giao diện (UI đã hiển thị sẵn mã và link).
 *
 * Thiết kế mở: mỗi nhà cung cấp là một adapter, đăng ký theo MST đơn vị cung cấp giải pháp.
 */
import axios from 'axios';
import { pool } from './db';
import { decryptCredentials } from './encryption.service';
import { logger } from './logger';

export interface ProviderPdfRequest {
  companyId:      string;
  /** MST người bán (chính là MST công ty với hoá đơn đầu ra) */
  supplierTaxCode: string;
  /** Ký hiệu hoá đơn, vd C26TAS */
  serial:         string;
  /** Số hoá đơn, vd 62 */
  invoiceNumber:  string;
}

export interface ProviderPdfResult {
  pdf:    Buffer | null;
  source: string | null;
  error:  string | null;
  /** true = công ty chưa cấu hình tài khoản nhà cung cấp nên không thể tự động lấy */
  noConnector?: boolean;
}

interface ProviderAdapter {
  /** Tên nguồn ghi vào DB */
  source: string;
  /** Provider trong bảng company_connectors */
  connector: 'viettel' | 'misa' | 'bkav';
  fetchPdf(req: ProviderPdfRequest, creds: Record<string, string>): Promise<Buffer>;
}

const HTTP_TIMEOUT_MS = Number(process.env['PROVIDER_API_TIMEOUT_MS'] ?? 30_000);

// ─── Viettel S-Invoice ────────────────────────────────────────────────────────
//
// POST {base}/InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile
// Body: { supplierTaxCode, invoiceNo, pattern, fileType: 'PDF' }
// Auth: Basic (tài khoản S-Invoice của chính doanh nghiệp phát hành)
// Trả về JSON có fileToBytes (base64) hoặc trực tiếp base64 tuỳ phiên bản.
const VIETTEL_BASES = [
  'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api',
  'https://api-sinvoice.viettel.vn',
];

const viettelAdapter: ProviderAdapter = {
  source: 'viettel_api',
  connector: 'viettel',

  async fetchPdf(req, creds): Promise<Buffer> {
    const username = creds['username'] ?? creds['user'] ?? '';
    const password = creds['password'] ?? creds['pass'] ?? '';
    if (!username || !password) throw new Error('Thiếu tài khoản Viettel S-Invoice trong kết nối');

    const body = {
      supplierTaxCode: req.supplierTaxCode,
      invoiceNo:       req.invoiceNumber,
      pattern:         req.serial,
      fileType:        'PDF',
    };

    let lastErr = 'không rõ';
    for (const base of VIETTEL_BASES) {
      const url = `${base}/InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile`;
      try {
        const res = await axios.post(url, body, {
          auth: { username, password },
          timeout: HTTP_TIMEOUT_MS,
          responseType: 'json',
          validateStatus: () => true,
        });

        if (res.status === 401 || res.status === 403) {
          throw new Error(`Tài khoản Viettel bị từ chối (HTTP ${res.status})`);
        }
        if (res.status !== 200) {
          lastErr = `HTTP ${res.status}`;
          continue;
        }

        const data = res.data as Record<string, unknown> | string;
        const b64 = typeof data === 'string'
          ? data
          : String(
              (data['fileToBytes'] as string) ??
              (data['data'] as string) ??
              (data['fileContent'] as string) ??
              '',
            );
        if (!b64) { lastErr = 'phản hồi không có nội dung file'; continue; }

        const buf = Buffer.from(b64, 'base64');
        if (buf.subarray(0, 5).toString() !== '%PDF-') {
          lastErr = 'nội dung trả về không phải PDF';
          continue;
        }
        return buf;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (/từ chối/.test(lastErr)) throw err;   // sai tài khoản → dừng, không thử base khác
      }
    }
    throw new Error(`Viettel API không trả được PDF: ${lastErr}`);
  },
};

/** MST đơn vị cung cấp giải pháp → adapter */
const ADAPTERS: Record<string, ProviderAdapter> = {
  '0100109106': viettelAdapter,   // Tập đoàn Công nghiệp - Viễn thông Quân đội (S-Invoice)
};

/** Có adapter tự động cho nhà cung cấp này không */
export function hasProviderAdapter(providerTaxCode: string | null): boolean {
  return !!providerTaxCode && !!ADAPTERS[providerTaxCode];
}

/**
 * Lấy PDF theo mẫu nhà cung cấp.
 * Không ném lỗi — trả về error/noConnector để worker ghi nhận trạng thái.
 */
export async function fetchProviderPdf(
  providerTaxCode: string | null,
  req: ProviderPdfRequest,
): Promise<ProviderPdfResult> {
  const adapter = providerTaxCode ? ADAPTERS[providerTaxCode] : undefined;
  if (!adapter) {
    return { pdf: null, source: null, error: 'Chưa hỗ trợ tự động với nhà cung cấp này', noConnector: false };
  }

  // Tài khoản nhà cung cấp của chính công ty
  const { rows } = await pool.query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM company_connectors
      WHERE company_id = $1 AND provider = $2::invoice_provider AND enabled = true
      LIMIT 1`,
    [req.companyId, adapter.connector],
  );
  if (rows.length === 0) {
    return {
      pdf: null, source: null, noConnector: true,
      error: 'Công ty chưa cấu hình tài khoản nhà cung cấp (Cài đặt → Kết nối hoá đơn)',
    };
  }

  let creds: Record<string, string>;
  try {
    creds = await decryptCredentials(rows[0]!.credentials_encrypted) as Record<string, string>;
  } catch (err) {
    return {
      pdf: null, source: null,
      error: `Không giải mã được thông tin kết nối: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const pdf = await adapter.fetchPdf(req, creds);
    logger.info('[ProviderInvoice] Đã lấy PDF theo mẫu nhà cung cấp', {
      source: adapter.source, serial: req.serial, invoiceNumber: req.invoiceNumber, bytes: pdf.byteLength,
    });
    return { pdf, source: adapter.source, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[ProviderInvoice] Lấy PDF nhà cung cấp thất bại', {
      source: adapter.source, serial: req.serial, invoiceNumber: req.invoiceNumber, error: msg,
    });
    return { pdf: null, source: adapter.source, error: msg };
  }
}
