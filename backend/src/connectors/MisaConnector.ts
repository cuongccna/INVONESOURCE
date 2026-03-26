import axios, { AxiosInstance } from 'axios';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';

const ENVIRONMENTS = {
  test:       'https://testapi.meinvoice.vn',
  production: 'https://api.meinvoice.vn',
} as const;

const MISA_ENV = (process.env['MISA_ENV'] ?? 'production') as keyof typeof ENVIRONMENTS;
const MISA_BASE_URL = ENVIRONMENTS[MISA_ENV] ?? ENVIRONMENTS.production;
const PAGE_SIZE = 50;
/** Refresh token 5 minutes before expiry to avoid mid-sync expiration */
const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000;

interface MisaCredentials {
  /** appid assigned by MISA per integration — contact MISA to obtain */
  appid: string;
  username: string;
  password: string;
  taxCode: string;
}

/** Auth response from POST /api/integration/auth/token */
interface MisaAuthResponse {
  Success: boolean;
  /** JWT token string when Success=true */
  Data?: string;
  ErrorCode?: string;
  Errors?: string[];
}

/**
 * MISA meInvoice Connector
 *
 * Auth: POST /api/integration/auth/token → Bearer JWT + CompanyTaxCode header
 * Token TTL ~1h → auto-refresh 5min before expiry
 *
 * appid is per-company — each customer must register at meInvoice and receive their own appid.
 * Contact MISA: support@misa.com.vn or 1900 1518.
 */
export class MisaConnector extends BaseConnector {
  readonly id = 'misa';
  readonly name = 'MISA meInvoice';
  readonly version = '1.0.0';

  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt: number = 0; // unix ms
  private credentials: MisaCredentials | null = null;

  constructor() {
    super();
    this.http = axios.create({
      baseURL: MISA_BASE_URL,
      timeout: 30_000,
    });
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as MisaCredentials;
    this.credentials = raw;
    await this.doAuthenticate(raw);
  }

  private async doAuthenticate(creds: MisaCredentials): Promise<void> {
    const response = await this.retryWithBackoff(() =>
      this.http.post<MisaAuthResponse>('/api/integration/auth/token', {
        appid:    creds.appid,
        taxcode:  creds.taxCode,
        username: creds.username,
        password: creds.password,
      })
    );

    const body = response.data;
    if (!body.Success || !body.Data) {
      const detail = body.Errors?.join('; ') ?? body.ErrorCode ?? 'Unknown error';
      this.throwError(`MISA authentication failed: ${detail}`);
    }

    this.token = body.Data;
    // MISA token TTL ~1h; decode & use exp if available, otherwise default 1h
    const ttlMs = this.extractJwtExp(this.token) ?? 3600 * 1000;
    this.tokenExpiresAt = Date.now() + ttlMs;
  }

  /** Extract exp from JWT payload (ms). Returns null if unreadable. */
  private extractJwtExp(token: string): number | null {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1]!, 'base64').toString('utf-8')
      ) as { exp?: number };
      if (payload.exp) return payload.exp * 1000 - Date.now();
    } catch { /* ignore */ }
    return null;
  }

  /** Ensure token is valid; refresh silently if within 5-minute window */
  private async ensureValidToken(): Promise<void> {
    if (!this.credentials) {
      this.throwError('Not authenticated — call authenticate() first');
    }
    if (!this.token || Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_BEFORE_MS) {
      await this.doAuthenticate(this.credentials!);
    }
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token!}`,
      CompanyTaxCode: this.credentials!.taxCode,
    };
  }

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString().split('T')[0]!;
    const to   = params.toDate.toISOString().split('T')[0]!;

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data?: unknown[] }>('/api/integration/invoice/list', {
          headers: this.getAuthHeaders(),
          params: { fromDate: from, toDate: to, pageIndex: page - 1, pageSize: PAGE_SIZE },
        })
      );
      return (res.data?.data ?? []).map((item) => this.normalizeInvoice(item, 'output'));
    });
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString().split('T')[0]!;
    const to   = params.toDate.toISOString().split('T')[0]!;

    try {
      return await this.paginatedFetch(async (page) => {
        const res = await this.retryWithBackoff(() =>
          this.http.get<{ data?: unknown[] }>('/api/integration/purchaseinvoice/list', {
            headers: this.getAuthHeaders(),
            params: { fromDate: from, toDate: to, pageIndex: page - 1, pageSize: PAGE_SIZE },
          })
        );
        return (res.data?.data ?? []).map((item) => this.normalizeInvoice(item, 'input'));
      });
    } catch (err: unknown) {
      // Purchase invoice is a paid add-on — handle 403 gracefully
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        console.warn('[misa] Purchase invoice API not activated (403) — this is a paid add-on, contact MISA to enable');
        return [];
      }
      throw err;
    }
  }

  async downloadPDF(externalId: string): Promise<Buffer> {
    await this.ensureValidToken();
    const res = await this.retryWithBackoff(() =>
      this.http.get(`/api/integration/invoice/pdf/${externalId}`, {
        headers: this.getAuthHeaders(),
        responseType: 'arraybuffer',
      })
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async downloadXML(externalId: string): Promise<string> {
    await this.ensureValidToken();
    const res = await this.retryWithBackoff(() =>
      this.http.get<string>(`/api/integration/invoice/xml/${externalId}`, {
        headers: this.getAuthHeaders(),
      })
    );
    return res.data;
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.token) return false;
      // Lightweight call: fetch 1 invoice from today
      await this.ensureValidToken();
      const today = new Date().toISOString().split('T')[0]!;
      await this.http.get('/api/integration/invoice/list', {
        headers: this.getAuthHeaders(),
        params: { fromDate: today, toDate: today, pageIndex: 0, pageSize: 1 },
      });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeInvoice(raw: unknown, direction: 'output' | 'input'): NormalizedInvoice {
    const item = raw as Record<string, unknown>;
    return {
      externalId:    this.parseString(item['invoiceId'] ?? item['id']),
      invoiceNumber: this.parseString(item['invoiceNumber'] ?? item['refId']),
      serialNumber:  this.parseString(item['serialNumber'] ?? item['symbol']),
      issuedDate:    this.parseDate(item['invoiceDate'] ?? item['arisingDate']),
      sellerTaxCode: this.parseString(item['sellerTaxCode'] ?? item['sellerCode']),
      sellerName:    this.parseString(item['sellerName']),
      buyerTaxCode:  this.parseString(item['buyerTaxCode'] ?? item['buyerCode']),
      buyerName:     this.parseString(item['buyerName']),
      subtotal:  this.parseNumber(item['total'] ?? item['originalAmountWithoutVAT']),
      vatRate:   this.normalizeVatRate(item['vatRate'] ?? item['vatPercentage']),
      vatAmount: this.parseNumber(item['vatAmount'] ?? item['originalVATAmount']),
      total:     this.parseNumber(item['totalAmount'] ?? item['originalAmount']),
      currency: this.parseString(item['currencyCode'] ?? 'VND') || 'VND',
      status: this.parseStatus(this.parseString(item['invoiceStatus'] ?? item['status'] ?? '')),
      direction,
      rawXml: typeof item['xmlContent'] === 'string' ? item['xmlContent'] : undefined,
      source: 'misa',
    };
  }

  private parseStatus(status: string): NormalizedInvoice['status'] {
    const map: Record<string, NormalizedInvoice['status']> = {
      '1': 'valid',    'valid': 'valid',    'active': 'valid',
      '2': 'cancelled','cancelled': 'cancelled',
      '3': 'replaced', 'replaced': 'replaced',
      '4': 'adjusted', 'adjusted': 'adjusted',
      '5': 'invalid',  'invalid': 'invalid',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }
}

