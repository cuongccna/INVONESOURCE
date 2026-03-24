import { ConnectorPlugin, EncryptedCredentials, SyncParams, RawInvoice } from './types';
import { NormalizedInvoice } from 'shared';

export class ConnectorError extends Error implements ConnectorPlugin {
  readonly id: string;
  readonly name: string = '';
  readonly version: string = '';
  readonly pluginId: string;
  readonly statusCode?: number;
  readonly originalError?: unknown;

  constructor(pluginId: string, message: string, originalError?: unknown, statusCode?: number) {
    super(`[${pluginId}] ${message}`);
    this.name = 'ConnectorError';
    this.id = pluginId;
    this.pluginId = pluginId;
    this.statusCode = statusCode;
    this.originalError = originalError;
    Object.setPrototypeOf(this, ConnectorError.prototype);
  }

  isEnabled(): boolean { return false; }
  async authenticate(_creds: EncryptedCredentials): Promise<void> { throw this; }
  async pullOutputInvoices(_params: SyncParams): Promise<NormalizedInvoice[]> { throw this; }
  async pullInputInvoices(_params: SyncParams): Promise<NormalizedInvoice[]> { throw this; }
  async downloadPDF(_externalId: string): Promise<Buffer> { throw this; }
  async healthCheck(): Promise<boolean> { return false; }
}

/**
 * BaseConnector — abstract base class for all provider connectors.
 * Provides shared helpers: retry, pagination, normalization.
 */
export abstract class BaseConnector implements ConnectorPlugin {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;

  protected enabled: boolean = true;

  isEnabled(): boolean {
    return this.enabled;
  }

  abstract authenticate(creds: EncryptedCredentials): Promise<void>;
  abstract pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]>;
  abstract pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]>;
  abstract downloadPDF(externalId: string): Promise<Buffer>;
  abstract healthCheck(): Promise<boolean>;

  /**
   * Retry with exponential backoff.
   * Wraps any error as ConnectorError with plugin context.
   */
  protected async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 1000
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw new ConnectorError(
      this.id,
      `Failed after ${maxRetries} attempts`,
      lastError
    );
  }

  /**
   * Paginated fetch: loops pages until an empty result is returned.
   * @param fetchPage function that returns items for a given 1-based page
   */
  protected async paginatedFetch<T>(
    fetchPage: (page: number) => Promise<T[]>
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;

    while (true) {
      const items = await fetchPage(page);
      if (!items || items.length === 0) break;
      results.push(...items);
      page++;

      // Safety limit: max 200 pages (~10k invoices at size=50)
      if (page > 200) {
        console.warn(`[${this.id}] paginatedFetch hit page limit at page ${page}`);
        break;
      }
    }

    return results;
  }

  /**
   * Normalize VAT rate from various formats to a plain number (e.g. 10)
   */
  protected normalizeVatRate(raw: unknown): number {
    if (typeof raw === 'number') {
      // Could be 0.1, 0.05, 0.08, or 10, 5, 8
      return raw <= 1 ? Math.round(raw * 100) : raw;
    }
    if (typeof raw === 'string') {
      const cleaned = raw.replace('%', '').trim();
      const num = parseFloat(cleaned);
      if (!isNaN(num)) {
        return num <= 1 ? Math.round(num * 100) : num;
      }
    }
    return 0;
  }

  /**
   * Safely parse a date from various formats
   */
  protected parseDate(raw: unknown): Date {
    if (raw instanceof Date) return raw;
    if (typeof raw === 'number') return new Date(raw);
    if (typeof raw === 'string') {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  }

  /**
   * Safely parse a number from string or number
   */
  protected parseNumber(raw: unknown): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const n = parseFloat(raw.replace(/,/g, ''));
      return isNaN(n) ? 0 : n;
    }
    return 0;
  }

  /**
   * Safely parse a string, defaulting to empty string
   */
  protected parseString(raw: unknown): string {
    if (typeof raw === 'string') return raw.trim();
    if (raw === null || raw === undefined) return '';
    return String(raw).trim();
  }

  /**
   * Helper: throw ConnectorError with this plugin's id
   */
  protected throwError(message: string, originalError?: unknown, statusCode?: number): never {
    throw new ConnectorError(this.id, message, originalError, statusCode);
  }
}
