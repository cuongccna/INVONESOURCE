import axios, { AxiosError, AxiosInstance } from 'axios';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';

/**
 * Viettel VInvoice Connector
 *
 * API: https://api-vinvoice.viettel.vn  (NOT the old sinvoice.viettel.vn system)
 * Auth: POST /auth/login → OAuth2 Bearer JWT (expires ~20 min), automatic re-auth
 * Date format: "dd/MM/yyyy"  (NOT milliseconds — that was the old SInvoice system)
 *
 * ⚠️ IP Whitelist: Server IP must be registered on the Viettel portal before going live.
 *    500 errors without detail usually mean IP not whitelisted.
 */

const VINVOICE_BASE   = 'https://api-vinvoice.viettel.vn';
const INVOICE_SVC_PATH = '/services/einvoiceapplication/api/InvoiceAPI/InvoiceUtilsWS';
const REQUEST_TIMEOUT_MS = 90_000;

interface ViettelCredentials {
  /** Tax code used as username, e.g. '0100109106-509'. */
  username: string;
  password: string;
}

interface TokenCache {
  accessToken: string;
  refreshToken: string;
  /** Unix ms when the access token expires */
  expiresAt: number;
}

/**
 * Format a Date as "dd/MM/yyyy" — the only format accepted by VInvoice date fields.
 */
function toViettelDate(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

export class ViettelConnector extends BaseConnector {
  readonly id      = 'viettel';
  readonly name    = 'Viettel VInvoice';
  readonly version = '2.0.0';

  private http: AxiosInstance;
  private credentials: ViettelCredentials | null = null;
  private tokenCache: TokenCache | null = null;

  constructor() {
    super();
    this.http = axios.create({
      baseURL: VINVOICE_BASE,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as ViettelCredentials;
    this.credentials = raw;
    this.tokenCache  = null;
    // Eagerly fetch token to validate credentials immediately
    await this.getToken();
  }

  // ─── Token management ──────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const bufferMs = 60_000; // Refresh 60 s before actual expiry
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - bufferMs) {
      return this.tokenCache.accessToken;
    }
    return this.doLogin();
  }

  private async doLogin(): Promise<string> {
    if (!this.credentials) {
      this.throwError('Not authenticated — call authenticate() first');
    }
    let res: { data: { access_token: string; refresh_token: string; expires_in: number } };
    try {
      res = await this.http.post('/auth/login', {
        username: this.credentials!.username,
        password: this.credentials!.password,
      });
    } catch (err) {
      const e = err as AxiosError;
      if (e?.response?.status === 401) {
        this.throwError('Viettel VInvoice: Sai username hoặc mật khẩu', err, 401);
      }
      throw err;
    }
    const { access_token, refresh_token, expires_in } = res.data;
    this.tokenCache = {
      accessToken:  access_token,
      refreshToken: refresh_token,
      expiresAt:    Date.now() + expires_in * 1_000,
    };
    return access_token;
  }

  // ─── Invoice pulling ────────────────────────────────────────────────────────

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    return this.fetchInvoicePages({
      endpoint:       `${INVOICE_SVC_PATH}/getListInvoiceDataControl`,
      taxCodeField:   'supplierTaxCode',
      params,
      direction:      'output',
    });
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    // VInvoice input (purchase) invoice endpoint — will return 404 on accounts
    // that haven't purchased this add-on. Silently skip in that case.
    try {
      return await this.fetchInvoicePages({
        endpoint:     `${INVOICE_SVC_PATH}/getListBuyerInvoiceDataControl`,
        taxCodeField: 'buyerTaxCode',
        params,
        direction:    'input',
      });
    } catch (err) {
      const e = err as AxiosError;
      if (e?.response?.status === 404) {
        console.warn('[viettel] Input invoice endpoint not available (404) — skipping');
        return [];
      }
      throw err;
    }
  }

  private async fetchInvoicePages(opts: {
    endpoint: string;
    taxCodeField: 'supplierTaxCode' | 'buyerTaxCode';
    params: SyncParams;
    direction: 'output' | 'input';
  }): Promise<NormalizedInvoice[]> {
    const { endpoint, taxCodeField, params, direction } = opts;
    const fromDate = toViettelDate(params.fromDate);
    const toDate   = toViettelDate(params.toDate);
    const results: NormalizedInvoice[] = [];
    let pageNum = 0;
    const rowPerPage = 50;

    while (true) {
      const token = await this.getToken();
      let data: { totalRows?: number; invoices?: unknown[] };

      try {
        const res = await this.retryWithBackoff(() =>
          this.http.post<typeof data>(endpoint, {
            // Use the credentials username (Viettel account tax code) for the API query.
            // params.taxCode is our DB company tax_code which may differ (e.g. missing -XXX suffix).
            [taxCodeField]: this.credentials!.username,
            fromDate,
            toDate,
            rowPerPage,
            pageNum,
          }, {
            headers: { Authorization: `Bearer ${token}` },
          })
        );
        data = res.data;
      } catch (err) {
        const e = err as AxiosError;
        if (e?.response?.status === 500) {
          this.throwError(
            'Viettel VInvoice lỗi 500. Kiểm tra: IP server đã được whitelist chưa? ' +
            `(URL: ${VINVOICE_BASE})`,
            err, 500
          );
        }
        throw err;
      }

      const page = (data?.invoices ?? []) as unknown[];
      if (!page.length) break;

      page.forEach(item => results.push(this.normalizeInvoice(item, direction, params.taxCode)));

      // VInvoice returns all rows when total <= rowPerPage*pageNum
      // Stop if we have all rows or we've looped too long
      const totalRows = data?.totalRows ?? 0;
      if (results.length >= totalRows || page.length < rowPerPage || pageNum > 200) break;
      pageNum++;
    }

    return results;
  }

  async downloadPDF(externalId: string): Promise<Buffer> {
    const token = await this.getToken();
    const res = await this.retryWithBackoff(() =>
      this.http.post(
        `${INVOICE_SVC_PATH}/getInvoiceRepresentationFile`,
        { invoiceNo: externalId },
        { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' }
      )
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.credentials) return false;
      const token = await this.getToken();
      const now = new Date();
      const r = await this.http.post<{ totalRows?: number }>(
        `${INVOICE_SVC_PATH}/getListInvoiceDataControl`,
        { supplierTaxCode: this.credentials.username, fromDate: toViettelDate(now), toDate: toViettelDate(now), rowPerPage: 1, pageNum: 0 },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return typeof r.data?.totalRows === 'number';
    } catch {
      return false;
    }
  }

  // ─── Normalization ──────────────────────────────────────────────────────────

  private normalizeInvoice(raw: unknown, direction: 'output' | 'input', taxCode: string): NormalizedInvoice {
    const item = raw as Record<string, unknown>;

    // For output invoices: seller = our company (supplierTaxCode), buyer = counterpart
    // For input invoices:  buyer  = our company (buyerTaxCode),  seller = counterpart
    const sellerTaxCode = direction === 'output'
      ? (this.parseString(item['supplierTaxCode']) || taxCode)
      : this.parseString(item['supplierTaxCode']);

    const buyerTaxCode = this.parseString(item['buyerTaxCode']);

    // Cap amounts to NUMERIC(22,2) safe range — 999 tỷ VND is already unrealistic;
    // anything beyond 9e21 would overflow even the new schema.
    const MAX_SAFE_AMOUNT = 999_999_999_999; // 999 tỷ VND
    const capAmount = (raw: unknown) => {
      const n = this.parseNumber(raw);
      if (n > MAX_SAFE_AMOUNT) {
        console.warn(`[viettel] Suspiciously large amount ${n} — capping at ${MAX_SAFE_AMOUNT}`);
        return MAX_SAFE_AMOUNT;
      }
      return n;
    };

    return {
      externalId:    this.parseString(item['invoiceNo'] ?? item['invoiceId']),
      invoiceNumber: this.parseString(item['invoiceNo'] ?? item['invoiceNumber']),
      serialNumber:  this.parseString(item['invoiceSeri'] ?? item['templateCode']),
      // issueDate is always UNIX milliseconds in VInvoice list responses
      issuedDate:    this.parseDate(item['issueDate'] ?? item['createTime']),
      sellerTaxCode,
      sellerName:    this.parseString(item['sellerName'] ?? item['supplierName'] ?? ''),
      buyerTaxCode,
      buyerName:     this.parseString(item['buyerName'] ?? item['customerName'] ?? ''),
      subtotal:      capAmount(item['totalBeforeTax'] ?? item['totalAmountWithoutVAT']),
      vatRate:       this.normalizeVatRate(item['taxRate'] ?? item['vatRate']),
      vatAmount:     capAmount(item['taxAmount'] ?? item['totalVATAmount']),
      total:         capAmount(item['total'] ?? item['totalAmount']),
      currency:      this.parseString(item['currency'] ?? item['currencyCode'] ?? 'VND') || 'VND',
      status:        this.parseViettelStatus(item['state'] ?? item['stateCode'] ?? 1),
      direction,
      source: 'viettel',
    };
  }

  private parseViettelStatus(state: unknown): NormalizedInvoice['status'] {
    const s = String(state);
    const map: Record<string, NormalizedInvoice['status']> = {
      '1': 'valid',
      '2': 'replaced',
      '3': 'cancelled',
      '4': 'cancelled',
      '5': 'adjusted',
    };
    return map[s] ?? 'valid';
  }
}
