import axios, { AxiosInstance } from 'axios';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';

const MISA_BASE_URL = 'https://api.meinvoice.vn';
const PAGE_SIZE = 50;
const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000; // 5 minutes

interface MisaCredentials {
  username: string;
  password: string;
  taxCode: string;
}

/**
 * MISA meInvoice Connector
 * Auth: Bearer JWT + CompanyTaxCode header
 * Token TTL ~1h → auto-refresh 5min before expiry
 */
export class MisaConnector extends BaseConnector {
  readonly id = 'misa';
  readonly name = 'MISA meInvoice';
  readonly version = '1.0.0';

  private http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;   // unix ms
  private taxCode: string = '';
  private credentials: MisaCredentials | null = null;

  constructor() {
    super();
    this.http = axios.create({
      baseURL: MISA_BASE_URL,
      timeout: 30000,
    });
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as MisaCredentials;
    this.credentials = raw;
    this.taxCode = raw.taxCode;
    await this.doAuthenticate(raw);
  }

  private async doAuthenticate(creds: MisaCredentials): Promise<void> {
    const response = await this.retryWithBackoff(() =>
      this.http.post<{ token: string; expiresIn: number }>('/auth/login', {
        username: creds.username,
        password: creds.password,
      })
    );

    this.token = response.data.token;
    // MISA token TTL ~1h (3600s) — calculate expiry
    const ttlMs = (response.data.expiresIn || 3600) * 1000;
    this.tokenExpiresAt = Date.now() + ttlMs;
    this.taxCode = creds.taxCode;
  }

  /** Auto-refresh token 5 minutes before expiry */
  private async ensureValidToken(): Promise<void> {
    if (!this.credentials) {
      this.throwError('Not authenticated — call authenticate() first');
    }
    if (!this.token || Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_BEFORE_MS) {
      await this.doAuthenticate(this.credentials!);
    }
  }

  private getAuthHeaders() {
    return {
      Authorization: `Bearer ${this.token}`,
      CompanyTaxCode: this.taxCode,
    };
  }

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString().split('T')[0];
    const to = params.toDate.toISOString().split('T')[0];

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data: unknown[] }>('/api/invoice/list', {
          headers: this.getAuthHeaders(),
          params: { fromDate: from, toDate: to, page, size: PAGE_SIZE },
        })
      );
      const items = res.data?.data ?? [];
      return items.map((item) => this.normalizeOutputInvoice(item));
    });
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString().split('T')[0];
    const to = params.toDate.toISOString().split('T')[0];

    try {
      return await this.paginatedFetch(async (page) => {
        const res = await this.retryWithBackoff(() =>
          this.http.get<{ data: unknown[] }>('/api/purchaseinvoice/list', {
            headers: this.getAuthHeaders(),
            params: { fromDate: from, toDate: to, page, size: PAGE_SIZE },
          })
        );
        const items = res.data?.data ?? [];
        return items.map((item) => this.normalizeInputInvoice(item));
      });
    } catch (err: unknown) {
      // Purchase invoice API is a paid add-on — handle 403 gracefully
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 403) {
        console.warn(`[misa] Purchase invoice API not available (403) — add-on may not be purchased`);
        return [];
      }
      throw err;
    }
  }

  async downloadPDF(externalId: string): Promise<Buffer> {
    await this.ensureValidToken();
    const res = await this.retryWithBackoff(() =>
      this.http.get(`/api/invoice/pdf/${externalId}`, {
        headers: this.getAuthHeaders(),
        responseType: 'arraybuffer',
      })
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.token) return false;
      await this.http.get('/api/auth/verify-token', {
        headers: this.getAuthHeaders(),
      });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeOutputInvoice(raw: unknown): NormalizedInvoice {
    const item = raw as Record<string, unknown>;
    return {
      externalId: this.parseString(item['invoiceId'] ?? item['id']),
      invoiceNumber: this.parseString(item['invoiceNumber'] ?? item['refId']),
      serialNumber: this.parseString(item['serialNumber'] ?? item['symbol']),
      issuedDate: this.parseDate(item['invoiceDate'] ?? item['arisingDate']),
      sellerTaxCode: this.parseString(item['sellerTaxCode'] ?? item['sellerCode']),
      sellerName: this.parseString(item['sellerName']),
      buyerTaxCode: this.parseString(item['buyerTaxCode'] ?? item['buyerCode']),
      buyerName: this.parseString(item['buyerName']),
      subtotal: this.parseNumber(item['total'] ?? item['originalAmountWithoutVAT']),
      vatRate: this.normalizeVatRate(item['vatRate'] ?? item['vatPercentage']),
      vatAmount: this.parseNumber(item['vatAmount'] ?? item['originalVATAmount']),
      total: this.parseNumber(item['totalAmount'] ?? item['originalAmount']),
      currency: this.parseString(item['currencyCode'] ?? 'VND') || 'VND',
      status: this.parseStatus(this.parseString(item['invoiceStatus'] ?? item['status'])),
      direction: 'output',
      rawXml: typeof item['xmlContent'] === 'string' ? item['xmlContent'] : undefined,
      source: 'misa',
    };
  }

  private normalizeInputInvoice(raw: unknown): NormalizedInvoice {
    const invoice = this.normalizeOutputInvoice(raw);
    return { ...invoice, direction: 'input' };
  }

  private parseStatus(status: string): NormalizedInvoice['status'] {
    const map: Record<string, NormalizedInvoice['status']> = {
      '1': 'valid',
      'valid': 'valid',
      '2': 'cancelled',
      'cancelled': 'cancelled',
      '3': 'replaced',
      'replaced': 'replaced',
      '4': 'adjusted',
      'adjusted': 'adjusted',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }
}
