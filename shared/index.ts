// Shared TypeScript types for HĐĐT Unified Platform

export type UserRole = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';
export type InvoiceProvider = 'misa' | 'viettel' | 'bkav' | 'gdt_intermediary' | 'manual';
export type InvoiceDirection = 'output' | 'input';
export type InvoiceStatus = 'valid' | 'cancelled' | 'replaced' | 'adjusted' | 'invalid';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type FilingFrequency = 'monthly' | 'quarterly';
export type DeclarationMethod = 'deduction' | 'direct';
export type SubmissionMethod = 'manual' | 'tvan' | 'gdt_api';
export type SubmissionStatus = 'draft' | 'ready' | 'submitted' | 'accepted' | 'rejected';

export type CompanyType = 'private' | 'jsc' | 'partnership' | 'household' | 'other';
export type ViewMode = 'portfolio' | 'group' | 'single';

export interface ViewContextState {
  mode: ViewMode;
  orgId?: string;
  companyId?: string;
}

export interface Company {
  id: string;
  name: string;
  tax_code: string;
  address: string;
  phone?: string;
  email?: string;
  company_type: CompanyType;
  fiscal_year_start: number;
  onboarded: boolean;
  deleted_at?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  email: string;
  full_name: string;
  created_at: Date;
}

export interface UserCompany {
  user_id: string;
  company_id: string;
  role: UserRole;
}

export interface CompanyConnector {
  id: string;
  company_id: string;
  provider: InvoiceProvider;
  credentials_encrypted: string;
  enabled: boolean;
  circuit_state: CircuitState;
  consecutive_failures: number;
  last_sync_at: Date | null;
  created_at: Date;
}

export interface Invoice {
  id: string;
  company_id: string;
  provider: InvoiceProvider;
  direction: InvoiceDirection;
  invoice_number: string;
  serial_number: string;
  invoice_date: Date;
  seller_tax_code: string;
  seller_name: string;
  buyer_tax_code: string;
  buyer_name: string;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total_amount: number;
  currency: string;
  status: InvoiceStatus;
  gdt_validated: boolean;
  gdt_validated_at: Date | null;
  raw_xml: string | null;
  pdf_path: string | null;
  external_id: string | null;
  sync_at: Date | null;
  // GROUP 47: Invoice type classification
  invoice_group: 5 | 6 | 8 | null;
  serial_has_cqt: boolean | null;
  has_line_items: boolean;
  // GROUP 28: GDT XML replacement tracking fields
  mccqt: string | null;
  tc_hdon: 0 | 1 | null;
  lhd_cl_quan: number | null;
  khhd_cl_quan: string | null;
  so_hd_cl_quan: string | null;
  created_at: Date;
}

export interface VatReconciliation {
  id: string;
  company_id: string;
  period_month: number;
  period_year: number;
  output_vat: number;
  input_vat: number;
  payable_vat: number;
  breakdown: VatBreakdown;
  generated_at: Date;
}

export interface VatBreakdown {
  by_rate: {
    0?: VatRateBreakdown;
    5?: VatRateBreakdown;
    8?: VatRateBreakdown;
    10?: VatRateBreakdown;
  };
}

export interface VatRateBreakdown {
  output_subtotal: number;
  output_vat: number;
  input_subtotal: number;
  input_vat: number;
}

export interface Notification {
  id: string;
  company_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  is_read: boolean;
  push_sent: boolean;
  created_at: Date;
}

export interface SyncLog {
  id: string;
  company_id: string;
  provider: string;
  started_at: Date;
  finished_at: Date | null;
  records_fetched: number;
  errors_count: number;
  error_detail: string | null;
}

export interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: Date;
}

export interface TaxDeclaration {
  id: string;
  company_id: string;
  period_month: number;
  period_year: number;
  form_type: string;
  period_type: string;             // 'monthly' | 'quarterly' — giá trị thực tế trong DB
  declaration_method: DeclarationMethod;
  filing_frequency: FilingFrequency;
  ct22_total_input_vat: number;
  ct23_deductible_input_vat: number;
  ct23_input_subtotal: number;
  ct24_carried_over_vat: number;
  ct25_total_deductible: number;
  ct29_total_revenue: number;
  ct30_exempt_revenue: number;
  ct32_revenue_5pct: number;
  ct33_vat_5pct: number;
  ct34_revenue_8pct: number;
  ct35_vat_8pct: number;
  ct36_revenue_10pct: number;
  ct37_vat_10pct: number;
  ct36_nq_vat_reduction: number;
  ct40_total_output_revenue: number;
  ct40a_total_output_vat: number;
  ct41_payable_vat: number;
  ct43_carry_forward_vat: number;
  ct26_kct_revenue?: number;
  ct29_0pct_revenue?: number;
  ct32a_kkknt_revenue?: number;
  ct37_auto_decrease?: number | null;
  ct38_auto_increase?: number | null;
  ct37_adjustment_decrease?: number | null;
  ct38_adjustment_increase?: number | null;
  ct40b_investment_vat?: number | null;
  ct21_no_activity?: boolean | null;
  xml_content: string | null;
  xml_generated_at: Date | null;
  submission_method: SubmissionMethod;
  submission_status: SubmissionStatus;
  submission_at: Date | null;
  tvan_transaction_id: string | null;
  gdt_reference_number: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

export interface NormalizedInvoice {
  externalId: string;
  invoiceNumber: string;
  serialNumber: string;
  issuedDate: Date;
  sellerTaxCode: string;
  sellerName: string;
  buyerTaxCode: string;
  buyerName: string;
  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;
  currency: string;
  status: InvoiceStatus;
  direction: InvoiceDirection;
  rawXml?: string;
  source: InvoiceProvider;
  // GROUP 47: Invoice type classification (TT78/2021)
  invoiceGroup?: 5 | 6 | 8 | null;
  serialHasCqt?: boolean;
  hasLineItems?: boolean;
}

// GROUP 47: Parsed serial number structure (TT78/2021)
export interface ParsedSerial {
  raw: string;
  hasCqtCode: boolean;       // true = C (có mã CQT), false = K (không mã)
  invoiceYear: number;       // 26 → 2026
  invoiceType: string;       // 'T'|'M'|'D'|'N'|'V'|'X'
  invoiceTypeLabel: string;  // "Hóa đơn thường" | "Máy tính tiền" ...
  companyCode: string;       // DN tự đặt (e.g. 'DL', 'ABC')
  invoiceGroup: 5 | 6 | 8 | null;
  isDetailAvailable: boolean; // false for groups 6 & 8
}

// GROUP 48: Sync job for month/quarter scheduling
export interface SyncJob {
  fromDate: string;  // YYYY-MM-DD
  toDate: string;    // YYYY-MM-DD
  label: string;     // "Tháng 1" | "Tháng 2" etc.
}

// GROUP 48: SSE sync progress event
export interface SyncProgressEvent {
  jobId: string;
  state: 'waiting' | 'active' | 'completed' | 'failed';
  progress: number;               // 0-100
  invoicesFetched: number;
  currentPage: number;
  totalPages: number | null;
  currentMonth: string;            // for quarter sync
  message: string;
  error: string | null;
}
