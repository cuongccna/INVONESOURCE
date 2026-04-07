## PROMPT GROUP 28 — Invoice Validation Pipeline (Pre-Declaration Filter)

### 28.1 — Core Interface & Types

Create file `src/tax/validation/types.ts`.

Define the foundational types for the invoice validation plugin system:
```typescript
// Reason codes must be stable string constants — never change existing values,
// only add new ones. Used for audit logs and UI display.
export enum ExclusionReasonCode {
  // Hard exclusions (invoice must not appear in any tax declaration)
  CANCELLED_BY_GDT        = 'CANCELLED_BY_GDT',
  REPLACED_BY_NEWER       = 'REPLACED_BY_NEWER',
  INVALID_CQT_SIGNATURE   = 'INVALID_CQT_SIGNATURE',
  ILLEGAL_INVOICE         = 'ILLEGAL_INVOICE',

  // Input-side exclusions (mua vào — không được khấu trừ)
  CASH_PAYMENT_OVER_5M    = 'CASH_PAYMENT_OVER_5M',
  NOT_FOR_TAXABLE_USE     = 'NOT_FOR_TAXABLE_USE',
  VENDOR_ENFORCEMENT      = 'VENDOR_ENFORCEMENT',
  VENDOR_RISK_FLAGGED     = 'VENDOR_RISK_FLAGGED',

  // Declaration-period exclusions
  WRONG_DECLARATION_PERIOD = 'WRONG_DECLARATION_PERIOD',
}

export interface InvoiceValidationContext {
  mst: string                        // MST of the company being declared
  declaration_period: string         // Format: 'YYYY-MM' or 'YYYY-QN' (e.g. '2026-Q1')
  declaration_type: 'monthly' | 'quarterly'
  direction: 'input' | 'output'      // mua vào or bán ra
  user_payment_flags?: Record<string, boolean>  // invoice_id → is_cash_payment (user input)
  user_non_business_flags?: Record<string, boolean>  // invoice_id → not for business use
}

export interface InvoiceValidationResult {
  invoice_id: string
  status: 'valid' | 'excluded' | 'warning'
  reason_codes: ExclusionReasonCode[]
  reason_detail?: string             // Human-readable Vietnamese description
  plugin_name: string                // Which plugin made the decision
  validated_at: Date
}

export interface PipelineValidationOutput {
  valid_invoices: string[]           // invoice_ids ready for declaration
  excluded_invoices: InvoiceValidationResult[]
  warning_invoices: InvoiceValidationResult[]  // Valid but need user attention
  stats: {
    total: number
    valid: number
    excluded: number
    warnings: number
    excluded_by_reason: Record<ExclusionReasonCode, number>
  }
}
```

### 28.2 — Plugin Interface

Create file `src/tax/validation/plugin.interface.ts`.

Define the contract every validation plugin must implement:
```typescript
import { InvoiceRecord } from '../../invoices/types'
import {
  InvoiceValidationContext,
  InvoiceValidationResult,
  ExclusionReasonCode,
} from './types'

export interface IInvoiceValidationPlugin {
  // Unique identifier — used in audit logs and config
  readonly name: string

  // Display name in Vietnamese for UI
  readonly displayName: string

  // Order of execution — lower runs first. Hard exclusions should be < 100.
  // Soft/user-input-dependent checks should be >= 200.
  readonly priority: number

  // Which declaration direction this plugin applies to
  readonly appliesTo: 'input' | 'output' | 'both'

  // Legal basis reference for audit trail
  readonly legalBasis: string  // e.g. 'Đ.19 NĐ123/2020, Đ.13 NĐ70/2025'

  // Whether this plugin can be disabled via config
  readonly canDisable: boolean

  /**
   * Validate a single invoice.
   * Return null if the invoice passes this plugin's check.
   * Return InvoiceValidationResult if the invoice should be excluded or warned.
   */
  validate(
    invoice: InvoiceRecord,
    context: InvoiceValidationContext
  ): Promise<InvoiceValidationResult | null>
}

export interface PluginConfig {
  name: string
  enabled: boolean
  config?: Record<string, unknown>  // Plugin-specific settings from DB
}
```

### 28.3 — Core Plugin Implementations

Create file `src/tax/validation/plugins/index.ts` that exports all plugins.

Create the following 6 plugin files, each in `src/tax/validation/plugins/`:

**File: `cancelled-filter.plugin.ts`**
- `name`: `'cancelled_filter'`
- `priority`: 10, `appliesTo`: `'both'`
- Logic: Exclude if `invoice.gdt_status === 'cancelled'` OR if GDT sync metadata marks it as hủy
- `reason_code`: `CANCELLED_BY_GDT`
- `reason_detail`: `'Hóa đơn đã bị hủy trên hệ thống GDT'`

**File: `replaced-filter.plugin.ts`**
- `name`: `'replaced_filter'`
- `priority`: 20, `appliesTo`: `'both'`
- Logic: Query DB — if any invoice exists where `tc_hdon = 1` AND `lhd_cl_quan = 1` AND `khhd_cl_quan = invoice.khhd` AND `so_hd_cl_quan = invoice.so_hd` AND `mst_nban = invoice.mst_nban`, then this invoice is the replaced original — exclude it.
- `reason_code`: `REPLACED_BY_NEWER`
- `reason_detail`: `'Hóa đơn gốc đã bị thay thế bởi hóa đơn số {replacing_so_hd}'`
- IMPORTANT: The replacement invoice itself (the one with `tc_hdon=1`) is VALID — only the original being replaced is excluded.

**File: `cqt-signature-filter.plugin.ts`**
- `name`: `'cqt_signature_filter'`
- `priority`: 30, `appliesTo`: `'both'`
- Logic: Exclude if `invoice.mccqt` is null or empty string. For electronic invoices (hóa đơn có mã), presence of `mccqt` is required.
- `reason_code`: `INVALID_CQT_SIGNATURE`
- `reason_detail`: `'Hóa đơn thiếu mã xác thực của Cơ quan Thuế (MCCQT)'`
- Note: Do NOT apply to invoices of type `khong_ma` (không có mã CQT) — check `invoice.khmshdon` to determine if mã is required.

**File: `cash-payment-filter.plugin.ts`**
- `name`: `'cash_payment_filter'`
- `priority`: 210, `appliesTo`: `'input'`  
- Logic: Exclude if `context.user_payment_flags[invoice.id] === true` AND `invoice.tong_tien_tt >= 5_000_000`
- If `user_payment_flags` does not contain the invoice_id, return a WARNING (not exclusion) with message asking user to confirm payment method.
- `reason_code`: `CASH_PAYMENT_OVER_5M`
- `reason_detail`: `'Thanh toán tiền mặt từ 5 triệu trở lên — không được khấu trừ theo Đ.26 NĐ181/2025 (hiệu lực 01/07/2025)'`
- Only apply to invoices dated >= 2025-07-01.

**File: `non-business-filter.plugin.ts`**
- `name`: `'non_business_filter'`
- `priority`: 220, `appliesTo`: `'input'`
- Logic: Exclude if `context.user_non_business_flags[invoice.id] === true`
- Return WARNING if not flagged but invoice description contains keywords suggesting personal use (configurable keyword list in plugin config)
- `reason_code`: `NOT_FOR_TAXABLE_USE`

**File: `vendor-risk-filter.plugin.ts`**
- `name`: `'vendor_risk_filter'`
- `priority`: 230, `appliesTo`: `'input'`
- Logic: Query `vendor_risk_scores` table. Exclude if vendor has `enforcement_status = 'active'` (cưỡng chế hóa đơn). Return WARNING if `risk_score >= 70`.
- `reason_code`: `VENDOR_ENFORCEMENT` for exclusion, `VENDOR_RISK_FLAGGED` for warning

### 28.4 — Pipeline Orchestrator

Create file `src/tax/validation/invoice-validation.pipeline.ts`.
```typescript
// The pipeline is the ONLY entry point the tax declaration engine calls.
// It knows nothing about individual plugins.

class InvoiceValidationPipeline {
  constructor(
    private readonly plugins: IInvoiceValidationPlugin[],
    private readonly configService: PluginConfigService,
    private readonly db: DatabaseService,
    private readonly auditLogger: AuditLogService
  ) {}

  async validate(
    invoices: InvoiceRecord[],
    context: InvoiceValidationContext
  ): Promise<PipelineValidationOutput>
}
```

Implementation requirements:
- Load enabled plugin configs from DB table `validation_plugin_configs` at runtime
- Sort active plugins by `priority` ascending before executing
- For each invoice, run it through all enabled plugins that match `context.direction` (or `'both'`)
- Short-circuit: if a plugin returns `status: 'excluded'`, mark the invoice excluded and **stop** running remaining plugins for that invoice (no need to check further)
- Collect all warnings even if invoice is valid
- Persist each `InvoiceValidationResult` to `invoice_validation_log` table (for audit)
- Return `PipelineValidationOutput` with separated valid/excluded/warning lists

### 28.5 — Database Schema

Add migration: `migrations/028_invoice_validation_pipeline.sql`
```sql
-- Plugin configuration (enables admin to toggle rules without redeploy)
CREATE TABLE validation_plugin_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mst VARCHAR(20) NOT NULL,           -- Company-specific overrides, or '*' for global
  plugin_name VARCHAR(100) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority_override INT,              -- Override default priority if needed
  config JSONB DEFAULT '{}',          -- Plugin-specific settings
  updated_by VARCHAR(100),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(mst, plugin_name)
);

-- Audit log: every validation decision is stored
CREATE TABLE invoice_validation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  mst VARCHAR(20) NOT NULL,
  declaration_period VARCHAR(20) NOT NULL,  -- e.g. '2026-Q1'
  direction VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL,              -- valid | excluded | warning
  reason_codes TEXT[] DEFAULT '{}',
  reason_detail TEXT,
  plugin_name VARCHAR(100),
  validated_at TIMESTAMPTZ DEFAULT NOW(),
  pipeline_run_id UUID NOT NULL            -- Groups all results from one pipeline run
);

CREATE INDEX idx_validation_log_invoice ON invoice_validation_log(invoice_id);
CREATE INDEX idx_validation_log_period ON invoice_validation_log(mst, declaration_period);
CREATE INDEX idx_validation_log_run ON invoice_validation_log(pipeline_run_id);

-- Seed global defaults for all 6 plugins
INSERT INTO validation_plugin_configs (mst, plugin_name, enabled, config) VALUES
  ('*', 'cancelled_filter',      TRUE, '{}'),
  ('*', 'replaced_filter',       TRUE, '{}'),
  ('*', 'cqt_signature_filter',  TRUE, '{}'),
  ('*', 'cash_payment_filter',   TRUE, '{"effective_date": "2025-07-01", "threshold": 5000000}'),
  ('*', 'non_business_filter',   TRUE, '{}'),
  ('*', 'vendor_risk_filter',    TRUE, '{"warn_threshold": 70}');
```

### 28.6 — API Endpoints

Add to `src/tax/validation/validation.controller.ts`:

POST /api/v1/declarations/validate-invoices
Body: {
mst: string
period: string          // '2026-Q1' | '2026-01'
direction: 'input' | 'output' | 'both'
invoice_ids?: string[]  // Optional: validate specific subset only
user_payment_flags?: Record<string, boolean>
user_non_business_flags?: Record<string, boolean>
}
Response: PipelineValidationOutput
GET /api/v1/declarations/validation-log
Query: { mst, period, status?, run_id? }
Response: InvoiceValidationResult[]
PATCH /api/v1/admin/validation-plugins
Body: PluginConfig[]     // Enable/disable/configure plugins
Auth: admin only

### 28.7 — Integration Point

Update `src/tax/declaration/declaration.service.ts` (existing file):

Replace any existing invoice filtering logic with a single call:
```typescript
// The declaration service ONLY does this — no filtering logic here
const validationOutput = await this.validationPipeline.validate(
  rawInvoices,
  { mst, declaration_period: period, declaration_type, direction: 'both' }
)

// Only use valid invoices for tax calculation
const invoicesForDeclaration = rawInvoices.filter(inv =>
  validationOutput.valid_invoices.includes(inv.id)
)
```

The declaration engine must not know about any exclusion rules directly.
Also attach `validationOutput.excluded_invoices` and `validationOutput.warning_invoices`
to the declaration response so the frontend can show the user what was excluded and why.