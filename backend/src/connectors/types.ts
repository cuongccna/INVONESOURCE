import { NormalizedInvoice, InvoiceDirection } from 'shared';

// ============================================================
// Connector Plugin Types
// ============================================================

export interface EncryptedCredentials {
  encrypted: string;  // AES-256-GCM encrypted JSON string
}

export interface SyncParams {
  companyId: string;
  taxCode: string;
  fromDate: Date;
  toDate: Date;
}

export interface RawInvoice {
  [key: string]: unknown;
}

export interface ConnectorPlugin {
  readonly id: string;           // 'misa' | 'viettel' | 'bkav' | 'gdt_intermediary'
  readonly name: string;
  readonly version: string;

  isEnabled(): boolean;
  authenticate(creds: EncryptedCredentials): Promise<void>;
  pullOutputInvoices(params: SyncParams): Promise<NormalizedInvoice[]>;
  pullInputInvoices(params: SyncParams): Promise<NormalizedInvoice[]>;
  downloadPDF(externalId: string): Promise<Buffer>;
  healthCheck(): Promise<boolean>;
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  openedAt: Date | null;
  halfOpenAt: Date | null;
}

export interface ConnectorError extends Error {
  pluginId: string;
  statusCode?: number;
  originalError?: unknown;
}

export interface SyncResult {
  pluginId: string;
  success: boolean;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

export { NormalizedInvoice, InvoiceDirection };
