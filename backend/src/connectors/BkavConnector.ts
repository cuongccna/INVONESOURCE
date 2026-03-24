import axios, { AxiosInstance } from 'axios';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';

const BKAV_BASE_URL = 'https://api.bkav.com.vn/einvoice';

interface BkavCredentials {
  partnerGUID: string;
  partnerToken: string;
  taxCode: string;
}

/**
 * BKAV eInvoice Connector
 * Auth: Stateless headers PartnerGUID + PartnerToken (no token expiry)
 * GDT validation is handled internally by BKAV — set gdt_validated=true by default
 */
export class BkavConnector extends BaseConnector {
  readonly id = 'bkav';
  readonly name = 'BKAV eInvoice';
  readonly version = '1.0.0';

  private http: AxiosInstance;
  private partnerGUID: string = '';
  private partnerToken: string = '';

  constructor() {
    super();
    this.http = axios.create({
      baseURL: BKAV_BASE_URL,
      timeout: 30000,
    });
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as BkavCredentials;
    this.partnerGUID = raw.partnerGUID;
    this.partnerToken = raw.partnerToken;
    // BKAV is stateless — no login needed, credentials are set in headers
  }

  private getAuthHeaders() {
    return {
      PartnerGUID: this.partnerGUID,
      PartnerToken: this.partnerToken,
    };
  }

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    const from = params.fromDate.toISOString();
    const to = params.toDate.toISOString();

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data?: unknown[]; invoices?: unknown[] }>('/api/invoices', {
          headers: this.getAuthHeaders(),
          params: { from, to, page },
        })
      );
      const items = res.data?.data ?? res.data?.invoices ?? [];
      return items.map((item) => this.normalizeInvoice(item, 'output'));
    });
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    const from = params.fromDate.toISOString();
    const to = params.toDate.toISOString();

    return this.paginatedFetch(async (page) => {
      const res = await this.retryWithBackoff(() =>
        this.http.get<{ data?: unknown[]; invoices?: unknown[] }>('/api/purchase-invoices', {
          headers: this.getAuthHeaders(),
          params: { from, to, page },
        })
      );
      const items = res.data?.data ?? res.data?.invoices ?? [];
      return items.map((item) => this.normalizeInvoice(item, 'input'));
    });
  }

  async downloadPDF(externalId: string): Promise<Buffer> {
    const res = await this.retryWithBackoff(() =>
      this.http.get(`/api/invoices/${externalId}/pdf`, {
        headers: this.getAuthHeaders(),
        responseType: 'arraybuffer',
      })
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async downloadXML(externalId: string): Promise<Buffer> {
    const res = await this.retryWithBackoff(() =>
      this.http.get(`/api/invoices/${externalId}/xml`, {
        headers: this.getAuthHeaders(),
        responseType: 'arraybuffer',
      })
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.get('/api/health', {
        headers: this.getAuthHeaders(),
      });
      return true;
    } catch {
      // Fallback: try list with minimal params
      try {
        await this.http.get('/api/invoices', {
          headers: this.getAuthHeaders(),
          params: {
            from: new Date().toISOString(),
            to: new Date().toISOString(),
            page: 1,
          },
        });
        return true;
      } catch {
        return false;
      }
    }
  }

  private normalizeInvoice(raw: unknown, direction: 'output' | 'input'): NormalizedInvoice {
    const item = raw as Record<string, unknown>;
    return {
      externalId: this.parseString(item['id'] ?? item['invoiceId']),
      invoiceNumber: this.parseString(item['invoiceNumber'] ?? item['soHoaDon']),
      serialNumber: this.parseString(item['serialNumber'] ?? item['kyHieu']),
      // BKAV field: ArisingDate or issuedDate
      issuedDate: this.parseDate(item['ArisingDate'] ?? item['arisingDate'] ?? item['issuedDate']),
      sellerTaxCode: this.parseString(item['sellerTaxCode'] ?? item['mstNguoiBan']),
      sellerName: this.parseString(item['sellerName'] ?? item['tenNguoiBan']),
      buyerTaxCode: this.parseString(item['buyerTaxCode'] ?? item['mstNguoiMua']),
      buyerName: this.parseString(item['buyerName'] ?? item['tenNguoiMua']),
      subtotal: this.parseNumber(item['totalAmountWithoutVAT'] ?? item['tienHangHoaDichVu']),
      vatRate: this.normalizeVatRate(item['vatRate'] ?? item['thueSuatGTGT']),
      vatAmount: this.parseNumber(item['vatAmount'] ?? item['tienThueGTGT']),
      total: this.parseNumber(item['totalAmount'] ?? item['tongTienThanhToan']),
      currency: this.parseString(item['currency'] ?? 'VND') || 'VND',
      status: this.parseBkavStatus(this.parseString(item['status'] ?? item['trangThai'] ?? '')),
      direction,
      // BKAV handles GDT validation internally
      source: 'bkav',
    };
  }

  private parseBkavStatus(status: string): NormalizedInvoice['status'] {
    const map: Record<string, NormalizedInvoice['status']> = {
      '1': 'valid',
      'valid': 'valid',
      'signed': 'valid',
      '2': 'cancelled',
      'cancelled': 'cancelled',
      'huy': 'cancelled',
      '3': 'replaced',
      'replaced': 'replaced',
      'thayte': 'replaced',
      '4': 'adjusted',
      'adjusted': 'adjusted',
      'dieuchinH': 'adjusted',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }
}
