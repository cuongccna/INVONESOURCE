/**
 * types.ts — Core types for the Invoice Validation Plugin System (Group 28)
 *
 * IMPORTANT: ExclusionReasonCode values are stable string constants.
 * NEVER rename existing values — they are stored in invoice_validation_log.reason_codes.
 * Only ADD new values.
 */

// ─── Reason Codes ────────────────────────────────────────────────────────────

export enum ExclusionReasonCode {
  // Hard exclusions — invoice must not appear in any tax declaration
  CANCELLED_BY_GDT        = 'CANCELLED_BY_GDT',
  REPLACED_BY_NEWER       = 'REPLACED_BY_NEWER',
  INVALID_CQT_SIGNATURE   = 'INVALID_CQT_SIGNATURE',
  ILLEGAL_INVOICE         = 'ILLEGAL_INVOICE',

  // Input-side exclusions — không được khấu trừ
  CASH_PAYMENT_OVER_5M    = 'CASH_PAYMENT_OVER_5M',
  NOT_FOR_TAXABLE_USE     = 'NOT_FOR_TAXABLE_USE',
  VENDOR_ENFORCEMENT      = 'VENDOR_ENFORCEMENT',
  VENDOR_RISK_FLAGGED     = 'VENDOR_RISK_FLAGGED',

  // Declaration-period exclusions
  WRONG_DECLARATION_PERIOD = 'WRONG_DECLARATION_PERIOD',
}

// ─── DB row shape used throughout the validation pipeline ────────────────────

/**
 * InvoiceRow — shape of a row fetched from the `invoices` table for validation.
 * Subset of the full Invoice interface; only fields needed by validation plugins.
 */
export interface InvoiceRow {
  id: string;
  company_id: string;
  direction: 'input' | 'output';
  status: string;
  invoice_number: string;
  serial_number: string;
  invoice_date: Date;
  seller_tax_code: string;
  seller_name: string;
  buyer_tax_code: string;
  total_amount: number;
  vat_amount: number;
  payment_method: string | null;
  gdt_validated: boolean;
  invoice_group: number | null;
  serial_has_cqt: boolean | null;
  has_line_items: boolean;
  // Group 28 columns
  mccqt: string | null;
  tc_hdon: number | null;
  lhd_cl_quan: number | null;
  khhd_cl_quan: string | null;
  so_hd_cl_quan: string | null;
  invoice_relation_type: string | null;
  cross_period_flag: boolean;
}

// ─── Context passed into every pipeline run ───────────────────────────────────

export interface InvoiceValidationContext {
  /** MST of the company being declared */
  mst: string;
  /** Kỳ khai báo — format: 'YYYY-MM' (monthly) or 'YYYY-QN' (quarterly, e.g. '2026-Q1') */
  declaration_period: string;
  declaration_type: 'monthly' | 'quarterly';
  direction: 'input' | 'output' | 'both';
  /** invoice_id → is_cash_payment (true = thanh toán tiền mặt) */
  user_payment_flags?: Record<string, boolean>;
  /** invoice_id → not for business use (true = không phục vụ SXKD) */
  user_non_business_flags?: Record<string, boolean>;
}

// ─── Per-invoice result ───────────────────────────────────────────────────────

export interface InvoiceValidationResult {
  invoice_id: string;
  status: 'valid' | 'excluded' | 'warning';
  reason_codes: ExclusionReasonCode[];
  /** Mô tả tiếng Việt cho người dùng */
  reason_detail?: string;
  /** Tên plugin đưa ra quyết định */
  plugin_name: string;
  validated_at: Date;
}

// ─── Full pipeline output ─────────────────────────────────────────────────────

export interface PipelineValidationOutput {
  /** invoice_ids sẵn sàng đưa vào tờ khai */
  valid_invoices: string[];
  excluded_invoices: InvoiceValidationResult[];
  /** Hợp lệ nhưng cần người dùng chú ý */
  warning_invoices: InvoiceValidationResult[];
  stats: {
    total: number;
    valid: number;
    excluded: number;
    warnings: number;
    excluded_by_reason: Partial<Record<ExclusionReasonCode, number>>;
  };
  pipeline_run_id: string;
}
