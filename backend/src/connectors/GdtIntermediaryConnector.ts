import axios, { AxiosInstance } from 'axios';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';
import { env } from '../config/env';

/**
 * ⚠️ GDT Intermediary Connector
 * Base URL and exact endpoints MUST be updated after partner negotiation.
 * This connector provides access to ALL invoices directly from the Tax Authority's
 * data warehouse via a licensed intermediary partner.
 *
 * Data latency: 24-48h vs realtime from provider connectors.
 * Use as: cross-validation source + fallback when provider connectors fail.
 */

const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000; // 5 minutes

interface GdtTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface GdtIntermediaryCredentials {
  clientId: string;
  clientSecret: string;
  taxCode: string;
}

export class GdtIntermediaryConnector extends BaseConnector {
  readonly id = 'gdt_intermediary';
  readonly name = 'GDT Intermediary';
  readonly version = '1.0.0';

  private http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private credentials: GdtIntermediaryCredentials | null = null;

  constructor() {
    super();
    const baseUrl = env.GDT_INTERMEDIARY_BASE_URL;
    this.http = axios.create({
      baseURL: baseUrl || 'https://placeholder.gdt.gov.vn',
      timeout: 30000,
    });
  }

  /**
   * Returns false if base URL is not configured — graceful skip
   */
  isEnabled(): boolean {
    return this.enabled && !!env.GDT_INTERMEDIARY_BASE_URL;
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as GdtIntermediaryCredentials;
    this.credentials = raw;
    await this.refreshToken();
  }

  private async refreshToken(): Promise<void> {
    if (!env.GDT_INTERMEDIARY_TOKEN_URL) {
      console.warn('[gdt_intermediary] Token URL not configured — skipping authentication');
      return;
    }

    const res = await this.retryWithBackoff(() =>
      axios.post<GdtTokenResponse>(
        env.GDT_INTERMEDIARY_TOKEN_URL!,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.credentials!.clientId,
          client_secret: this.credentials!.clientSecret,
          scope: env.GDT_INTERMEDIARY_SCOPE,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      )
    );

    this.accessToken = res.data.access_token;
    this.tokenExpiresAt = Date.now() + res.data.expires_in * 1000;
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.credentials) {
      this.throwError('Not authenticated — call authenticate() first');
    }
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_BEFORE_MS) {
      await this.refreshToken();
    }
  }

  private getAuthHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString();
    const to = params.toDate.toISOString();

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data?: unknown[] }>('/invoices/output', {
          headers: this.getAuthHeaders(),
          params: { taxCode: params.taxCode, from, to, page },
        })
      );
      const items = res.data?.data ?? [];
      return items.map((item) => this.normalizeInvoice(item, 'output'));
    });
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    await this.ensureValidToken();
    const from = params.fromDate.toISOString();
    const to = params.toDate.toISOString();

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data?: unknown[] }>('/invoices/input', {
          headers: this.getAuthHeaders(),
          params: { taxCode: params.taxCode, from, to, page },
        })
      );
      const items = res.data?.data ?? [];
      return items.map((item) => this.normalizeInvoice(item, 'input'));
    });
  }

  async downloadPDF(_externalId: string): Promise<Buffer> {
    this.throwError('PDF download not supported by GDT Intermediary connector');
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    try {
      await this.ensureValidToken();
      await this.http.get('/health', { headers: this.getAuthHeaders() });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeInvoice(raw: unknown, direction: 'output' | 'input'): NormalizedInvoice {
    const item = raw as Record<string, unknown>;
    return {
      externalId: this.parseString(item['id'] ?? item['invoiceId']),
      invoiceNumber: this.parseString(item['invoiceNumber']),
      serialNumber: this.parseString(item['serialNumber'] ?? item['symbol']),
      issuedDate: this.parseDate(item['issuedDate'] ?? item['invoiceDate']),
      sellerTaxCode: this.parseString(item['sellerTaxCode']),
      sellerName: this.parseString(item['sellerName']),
      buyerTaxCode: this.parseString(item['buyerTaxCode']),
      buyerName: this.parseString(item['buyerName']),
      subtotal: this.parseNumber(item['subtotal'] ?? item['totalAmountWithoutVAT']),
      vatRate: this.normalizeVatRate(item['vatRate']),
      vatAmount: this.parseNumber(item['vatAmount']),
      total: this.parseNumber(item['totalAmount']),
      currency: this.parseString(item['currency'] ?? 'VND') || 'VND',
      status: 'valid',   // GDT data is authoritative
      direction,
      source: 'gdt_intermediary',
    };
  }
}
