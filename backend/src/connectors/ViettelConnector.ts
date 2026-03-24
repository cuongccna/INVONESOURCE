import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { BaseConnector } from './BaseConnector';
import { EncryptedCredentials, SyncParams } from './types';
import { NormalizedInvoice } from 'shared';
import { decryptCredentials } from '../utils/encryption';

/**
 * ⚠️ IP WHITELIST REQUIRED
 * Before going live with Viettel SInvoice, the static server IP MUST be registered
 * with Viettel. Failure to do so will result in authentication errors that are
 * indistinguishable from wrong password errors.
 * Contact Viettel support at: sinvoice.viettel.vn to register the IP.
 */

const VIETTEL_BASE_URL = 'https://sinvoice.viettel.vn:8443/InvoiceAPI';
const REQUEST_TIMEOUT_MS = 90_000; // Viettel requires 90s timeout

interface ViettelCredentials {
  username: string;   // supplier tax code, e.g. '0100109106-215'
  password: string;
  taxCode: string;
}

/**
 * Viettel SInvoice Connector
 * Auth: HTTP Basic
 * ⚠️ CRITICAL: All dates must be in MILLISECONDS (not ISO strings)
 */
export class ViettelConnector extends BaseConnector {
  readonly id = 'viettel';
  readonly name = 'Viettel SInvoice';
  readonly version = '1.0.0';

  private http: AxiosInstance;
  private credentials: ViettelCredentials | null = null;

  constructor() {
    super();
    this.http = axios.create({
      baseURL: VIETTEL_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  async authenticate(creds: EncryptedCredentials): Promise<void> {
    const raw = decryptCredentials(creds.encrypted) as unknown as ViettelCredentials;
    this.credentials = raw;
    // Viettel uses HTTP Basic — validate by making a lightweight call
    // (no separate auth endpoint; credentials are validated per-request)
  }

  /**
   * ⚠️ Convert Date to milliseconds — REQUIRED by Viettel SInvoice API
   */
  private toMs(d: Date): number {
    return d.getTime();
  }

  private getBasicAuth(): { username: string; password: string } {
    if (!this.credentials) {
      this.throwError('Not authenticated — call authenticate() first');
    }
    return {
      username: this.credentials!.username,
      password: this.credentials!.password,
    };
  }

  async pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    const results: NormalizedInvoice[] = [];
    let page = 1;

    while (true) {
      const items = await this.retryWithBackoff(() =>
        this.http.post<{ datas?: unknown[] }>(
          '/InvoiceUtilsWS/getListInvoiceDataControl',
          {
            supplierTaxCode: params.taxCode,
            fromDate: this.toMs(params.fromDate),
            toDate: this.toMs(params.toDate),
            pageIndex: page,
            pageSize: 50,
            transactionUuid: uuidv4(),
          },
          { auth: this.getBasicAuth() }
        )
      );

      const data = items.data?.datas ?? [];
      if (!data.length) break;

      data.forEach((item) => results.push(this.normalizeInvoice(item, 'output')));
      page++;

      if (page > 200) break;
    }

    return results;
  }

  async pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]> {
    const results: NormalizedInvoice[] = [];
    let page = 1;

    while (true) {
      const items = await this.retryWithBackoff(() =>
        this.http.post<{ datas?: unknown[] }>(
          '/InvoiceUtilsWS/getListInvoiceDataControl',
          {
            supplierTaxCode: params.taxCode,
            fromDate: this.toMs(params.fromDate),
            toDate: this.toMs(params.toDate),
            pageIndex: page,
            pageSize: 50,
            type: 'purchase',   // distinguish input invoices
            transactionUuid: uuidv4(),
          },
          { auth: this.getBasicAuth() }
        )
      );

      const data = items.data?.datas ?? [];
      if (!data.length) break;

      data.forEach((item) => results.push(this.normalizeInvoice(item, 'input')));
      page++;

      if (page > 200) break;
    }

    return results;
  }

  async downloadPDF(externalId: string): Promise<Buffer> {
    const res = await this.retryWithBackoff(() =>
      this.http.post(
        '/InvoiceUtilsWS/getInvoiceRepresentationFile',
        {
          invoiceNo: externalId,
          transactionUuid: uuidv4(),
        },
        {
          auth: this.getBasicAuth(),
          responseType: 'arraybuffer',
        }
      )
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.credentials) return false;
      // Attempt a minimal API call to verify connectivity
      await this.http.post(
        '/InvoiceUtilsWS/getListInvoiceDataControl',
        {
          supplierTaxCode: this.credentials.taxCode,
          fromDate: this.toMs(new Date()),
          toDate: this.toMs(new Date()),
          pageIndex: 1,
          pageSize: 1,
          transactionUuid: uuidv4(),
        },
        { auth: this.getBasicAuth() }
      );
      return true;
    } catch {
      return false;
    }
  }

  private normalizeInvoice(raw: unknown, direction: 'output' | 'input'): NormalizedInvoice {
    const item = raw as Record<string, unknown>;
    return {
      externalId: this.parseString(item['invoiceNo'] ?? item['transactionID']),
      invoiceNumber: this.parseString(item['invoiceNo'] ?? item['transactionID']),
      serialNumber: this.parseString(item['serialNo'] ?? item['templateCode']),
      // Viettel dates are in milliseconds
      issuedDate: this.parseDate(
        typeof item['arisingDate'] === 'number'
          ? item['arisingDate']
          : item['invoiceDate']
      ),
      sellerTaxCode: this.parseString(item['sellerTaxCode'] ?? item['supplierTaxCode']),
      sellerName: this.parseString(item['sellerName'] ?? item['supplierName']),
      buyerTaxCode: this.parseString(item['buyerTaxCode'] ?? item['customerTaxCode']),
      buyerName: this.parseString(item['buyerName'] ?? item['customerName']),
      subtotal: this.parseNumber(item['totalAmountWithoutVAT'] ?? item['totalAmount']),
      vatRate: this.normalizeVatRate(item['vatRate'] ?? item['vatPercentage']),
      vatAmount: this.parseNumber(item['totalVATAmount'] ?? item['vatAmount']),
      total: this.parseNumber(item['totalAmount'] ?? item['paymentAmount']),
      currency: this.parseString(item['currencyCode'] ?? 'VND') || 'VND',
      status: this.parseViettelStatus(this.parseString(item['invoiceStatus'] ?? '')),
      direction,
      source: 'viettel',
    };
  }

  private parseViettelStatus(status: string): NormalizedInvoice['status'] {
    // Viettel status codes
    const map: Record<string, NormalizedInvoice['status']> = {
      '1': 'valid',
      '2': 'replaced',
      '3': 'adjusted',
      '4': 'cancelled',
      '5': 'cancelled',
      'valid': 'valid',
      'signed': 'valid',
      'cancelled': 'cancelled',
      'replaced': 'replaced',
      'adjusted': 'adjusted',
    };
    return map[status.toLowerCase()] ?? 'valid';
  }
}
