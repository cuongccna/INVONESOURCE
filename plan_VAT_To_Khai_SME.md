# Plan: 01/GTGT SME Declaration — Full Feature Build

## TL;DR
Build complete Form 01/GTGT declaration for SME (enterprise only, not HKD): fix VAT classification (KCT/0%/KKKNT), add tax_category column, dynamic indicator config in DB, manual fields [37]/[38]/[40b], per-invoice non_deductible flag, Excel 3-sheet export matching BaoCaoMau.xlsx, and Admin UI for managing indicator definitions.

Also fix a pre-existing bug in `HtkkXmlGenerator`: XML ct25 incorrectly includes carry-forward [22], making ct36 and ct40a wrong when ct22 > 0.

---

## CRITICAL BUG DISCOVERED (pre-existing)

`HtkkXmlGenerator` bug when `ct24_carried_over_vat` (form [22]) > 0:
- XML ct25 = `ct25_total_deductible` = [24]+[22] — WRONG (should be just [24])
- XML ct36 = ct35 - ct25_wrong → too small
- XML ct40a = ct36 + ct22 → accidentally gives output-[24]-NQ instead of correct output-[24]-[22]-NQ

Fix: XML ct25 = `ct23_deductible_input_vat` (just current period), XML ct40a = MAX(0, ct36 - ct22 + ct37 - ct38 - ct39)

---

## DB Field → Form Indicator Mapping (reference)
| DB field                   | Form indicator | Meaning                             |
|----------------------------|---------------|-------------------------------------|
| ct23_input_subtotal        | [23]          | Pre-VAT value of deductible invoices|
| ct23_deductible_input_vat  | [24]          | Deductible VAT current period       |
| ct24_carried_over_vat      | [22]          | Carry-forward from previous period  |
| ct25_total_deductible      | [24]+[22]     | NOT displayed directly (internal)   |
| ct30_exempt_revenue        | [26] (KCT)    | Non-taxable output                  |
| ct32_revenue_5pct          | [30]          | Output revenue 5%                   |
| ct33_vat_5pct              | [31]          | Output VAT 5%                       |
| ct34_revenue_8pct          | (8% bucket)   | Output revenue 8% (NQ142)           |
| ct36_revenue_10pct         | [32]          | Output revenue 10%+8%               |
| ct37_vat_10pct             | [33]          | Output VAT 10%+8%                   |
| ct40_total_output_revenue  | [34]          | Total output revenue                |
| ct40a_total_output_vat     | [35]          | Total output VAT                    |
| ct41_payable_vat           | [41]          | Amount to pay                       |
| ct43_carry_forward_vat     | [43]          | Carry-forward to next period        |

---

## Phase 1 — Database (Migrations 034, 035)

### Migration 034: invoices + tax_declarations columns
**invoices table:**
- ADD `tax_category` VARCHAR(20) NULL — original tsuat string: 'KCT','KKKNT','KKKTT','0','5','8','8%','10'
- ADD `non_deductible` BOOLEAN DEFAULT false — per-invoice [25] exclusion flag

**tax_declarations table:**
- ADD `ct26_kct_revenue` NUMERIC(18,0) DEFAULT 0 — [26] KCT (replaces misnamed ct30_exempt_revenue for display)
- ADD `ct29_0pct_revenue` NUMERIC(18,0) DEFAULT 0 — [29] 0% export
- ADD `ct32a_kkknt_revenue` NUMERIC(18,0) DEFAULT 0 — [32a] KKKNT
- ADD `ct37_adjustment_decrease` NUMERIC(18,0) DEFAULT 0 — [37] manual điều chỉnh giảm
- ADD `ct38_adjustment_increase` NUMERIC(18,0) DEFAULT 0 — [38] manual điều chỉnh tăng
- ADD `ct40b_investment_vat` NUMERIC(18,0) DEFAULT 0 — [40b] manual investment VAT offset
- ADD `ct21_no_activity` BOOLEAN DEFAULT false — [21] checkbox

### Migration 035: declaration_indicator_configs table + seed data
```sql
CREATE TABLE declaration_indicator_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type VARCHAR(20) NOT NULL DEFAULT '01/GTGT',
  code VARCHAR(20) NOT NULL,          -- internal code: 'ct22', 'ct26', etc.
  indicator_number VARCHAR(10),        -- '[22]', '[26]', 'A', 'I', etc.
  label TEXT NOT NULL,                 -- Vietnamese label
  section_code VARCHAR(10),            -- 'A', 'B', 'C', 'I', 'II', etc.
  row_type VARCHAR(20) DEFAULT 'indicator', -- 'section_header', 'indicator', 'subsection'
  has_value_col BOOLEAN DEFAULT true,  -- shows Giá trị HHDV column
  has_vat_col BOOLEAN DEFAULT false,   -- shows Thuế GTGT column
  value_db_field VARCHAR(100),         -- DB column name for value (e.g. 'ct23_input_subtotal')
  vat_db_field VARCHAR(100),           -- DB column for VAT (e.g. 'ct23_deductible_input_vat')
  formula_expression TEXT,             -- e.g. 'MAX(0,[36]-[22]+[37]-[38]-[39])'
  is_manual BOOLEAN DEFAULT false,     -- user can directly edit this field
  is_calculated BOOLEAN DEFAULT true,  -- auto-calculated from invoices
  display_order INT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
UNIQUE(form_type, code)
```

Seed 01/GTGT config rows for all indicators [21]-[43] with correct labels, formulas, field mappings.

---

## Phase 2 — Bot/Parser: Save tax_category

**File: `bot/src/gdt-direct-api.service.ts`**
- In `parseVatRate()`, return BOTH the numeric rate AND the original string category
- New helper: `extractTaxCategory(raw: string): string` — normalizes to 'KCT','KKKNT','0','5','8','10'
- Update invoice upsert SQL to include `tax_category` column
- Map: 'kct' → 'KCT', 'kkknt'|'kkktt' → 'KKKNT', '0%'→'0', '5%'→'5', '8%'→'8', '10%'→'10'

**Backfill Script** (`scripts/backfill_tax_category.ts`):
- Query invoices WHERE tax_category IS NULL
- For each, try to find raw_xml from gdt_raw_cache or invoices.raw_xml
- Parse tsuat from XML → set tax_category
- Fallback: if vat_amount=0 and vat_rate=0 AND direction='output', set tax_category='KCT' tentatively

---

## Phase 3 — VatReconciliationService Fix

**File: `backend/src/services/VatReconciliationService.ts`**

Output classification (use `tax_category` column):
```
tax_category = 'KCT'             → ct26_kct_revenue (form [26])
tax_category IS NULL AND vat_rate = 0 (export) → ct29_0pct_revenue (form [29])
tax_category IN ('KKKNT','KKKTT') → ct32a_kkknt_revenue (form [32a])
tax_category = '0' (numeric zero rate, not KCT) → ct29_0pct_revenue
tax_category = '5'               → ct32_revenue_5pct, ct33_vat_5pct
tax_category = '8'               → ct34_revenue_8pct, ct35_vat_8pct
tax_category = '10'              → ct36_revenue_10pct, ct37_vat_10pct
```

Input deductible query: Add `AND non_deductible = false` filter.

Update `VatSummary` interface and return values to include ct26, ct29, ct32a.

---

## Phase 4 — TaxDeclarationEngine Fix

**File: `backend/src/services/TaxDeclarationEngine.ts`**

1. **Fetch manual fields** from existing DB row before recalculating (preserve ct37/ct38/ct40b/ct21 on recalc)
2. **Update INSERT/UPSERT** to include all new columns
3. **Fix formula** (note: engine's ct41/ct43 ARE correct, just make it explicit):
   ```
   ct37 = manual ct37_adjustment_decrease (default 0)
   ct38 = manual ct38_adjustment_increase (default 0)
   ct40b = manual ct40b_investment_vat (default 0)
   
   net = ct40a_adjusted - ct25_total_deductible + ct37 - ct38 - ct39(0)
   ct40 = MAX(0, net) - ct40b
   ct41 = MAX(0, -net + ct40b) — (chưa khấu trừ hết)
   ct43 = ct41 (when ct42=0)
   ```
4. **calculateQuarterlyDeclaration**: same updates

---

## Phase 5 — Fix HtkkXmlGenerator (Bug Fix)

**File: `backend/src/services/HtkkXmlGenerator.ts`**

Fix ct25, ct36, ct40a in XML:
```
// correct XML ct25 = [24] only (current period deductible)
const xml_ct25 = n(d.ct23_deductible_input_vat);  // NOT ct25_total_deductible
// correct XML ct22 = carry-forward
const xml_ct22 = n(d.ct24_carried_over_vat);
// correct XML ct26 = KCT revenue
const xml_ct26 = n(d.ct26_kct_revenue ?? d.ct30_exempt_revenue);
// correct XML ct29 = 0% export
const xml_ct29 = n(d.ct29_0pct_revenue ?? 0);
// correct XML ct32a = KKKNT
const xml_ct32a = n(d.ct32a_kkknt_revenue ?? 0);
// correct XML ct36 = [35] - [25] (using corrected ct25)
const xml_ct36 = xml_ct35_total - xml_ct25;
// correct XML ct37 = adjustment decrease (NQ142 + manual)
const xml_ct37 = n(d.ct37_adjustment_decrease ?? 0) + plucOutputSumReduction;
// correct XML ct38 = adjustment increase (manual)
const xml_ct38 = n(d.ct38_adjustment_increase ?? 0);
// correct XML ct40a = MAX(0, [36]-[22]+[37]-[38]-[39])
const xml_ct40a_raw = xml_ct36 - xml_ct22 + xml_ct37 - xml_ct38;
```

Also add ct29, ct32a to XML output (currently hardcoded to 0).

---

## Phase 6 — Backend API: Manual Fields + Indicator Config CRUD

### New endpoints in `declarations.ts`:
- `PATCH /:id/manual-fields` — update ct37, ct38, ct40b, ct21 + recalculate ct40, ct41, ct43
  - Body: `{ ct37?: number, ct38?: number, ct40b?: number, ct21?: boolean }`
  - Recalculates from stored ct35 and ct25 values
  - requireRole OWNER/ADMIN/ACCOUNTANT

### New routes file `backend/src/routes/indicatorConfigs.ts`:
- `GET /api/declarations/indicator-configs?form_type=01/GTGT` — public (authenticated) list for UI
- `GET /api/admin/indicator-configs` — admin list
- `POST /api/admin/indicator-configs` — create (OWNER only)
- `PUT /api/admin/indicator-configs/:id` — update label/formula/notes (OWNER only)
- `DELETE /api/admin/indicator-configs/:id` — soft delete (OWNER only)
- `POST /api/admin/indicator-configs/seed` — reset to defaults (OWNER only)

### Per-invoice non_deductible flag (in existing invoices routes):
- `PATCH /api/invoices/:id/non-deductible` — toggle `{ non_deductible: boolean }`
- Bulk: `POST /api/invoices/bulk-non-deductible` — `{ ids: string[], non_deductible: boolean }`

---

## Phase 7 — Frontend: Declaration Detail UI Refactor

**File: `frontend/app/(app)/declarations/[id]/page.tsx`**

1. **Load indicator config** via `GET /api/declarations/indicator-configs?form_type=01/GTGT`
2. **Formula evaluator utility** (`frontend/utils/indicatorFormula.ts`):
   - Safe parser (no eval): parses expressions like `MAX(0,[36]-[22]+[37]-[38]-[39])`
   - Supports: +, -, *, /, MAX(), MIN(), ABS(), indicator refs [XX]
   - Input: `{ values: Record<string, number>, expression: string } → number`
3. **Dynamic render**: map config rows to table rows with proper labels, sections, formula display
4. **Inline editing**: [37], [38], [40b] cells — click to edit, save via PATCH /manual-fields
5. **[21] checkbox**: PATCH /manual-fields `{ ct21: true }`
6. **Per-invoice non-deductible panel**: show input invoice list with toggle checkbox (in mua vào tab)
7. **Fix indicator labels**: currently shows wrong labels (e.g. [22] = ct22_total_input_vat but should be carry-forward)

---

## Phase 8 — Frontend: Admin Indicator Config Page

**New file: `frontend/app/(app)/admin/indicator-configs/page.tsx`**
- Route: `/admin/indicator-configs` (OWNER role guard)
- Table with columns: Code, Indicator#, Label, Section, Formula, Manual, Active
- Inline edit: label, formula_expression, notes, is_active
- Edit modal with full field editing
- Seed/Reset defaults button → calls POST /api/admin/indicator-configs/seed
- JSON export/import for full config snapshot

---

## Phase 9 — Excel Export Overhaul (3 Sheets)

**File: `backend/src/services/TaxDeclarationExporter.ts`**

### Sheet 1: "01GTGT" — Main Form (match BaoCaoMau.xlsx exactly)
Layout from image: No. | Chỉ tiêu | [code] | Giá trị HHDV | [code] | Thuế GTGT
- Title block: header with company, MST, period, submission_status
- Section A: [21] checkbox
- Section B: [22] (carry-forward)
- Section C header
  - Part I (Input): [23]/[24], [25]
  - Part II (Output): [26], [27]/[28], [29], [30]/[31], [32]/[33], [32a], [34]/[35]
  - Part III: [36]
  - Part IV: [37], [38]
  - Part V: [39]
  - Part VI: [40a], [40b], [40], [41], [42], [43]
- Column widths, borders, colors matching template
- Number format: #,##0 right-aligned, negative in parentheses (2,679,316) format

### Sheet 2: "PL01-1 Bán ra"
Columns: STT | Tên HH/DV | Ký hiệu | Số HĐ | Ngày | MST Bên mua | Tên bên mua | Tiền chưa thuế | TS% | Tiền thuế | Tổng tiền | Ghi chú

### Sheet 3: "PL01-2 Mua vào"  
Columns: STT | Tên HH/DV | Ký hiệu | Số HĐ | Ngày | MST Bên bán | Tên bên bán | Tiền chưa thuế | TS% | Tiền thuế | Tổng tiền | Đủ ĐK khấu trừ | Ghi chú
- "Đủ ĐK khấu trừ" = !non_deductible

---

## Relevant Files

**Backend:**
- `backend/src/services/TaxDeclarationEngine.ts` — calculation engine (phase 4)
- `backend/src/services/VatReconciliationService.ts` — VAT breakdown by rate (phase 3)
- `backend/src/services/HtkkXmlGenerator.ts` — XML generation bug fix (phase 5)
- `backend/src/services/TaxDeclarationExporter.ts` — Excel export overhaul (phase 9)
- `backend/src/routes/declarations.ts` — add manual-fields endpoint (phase 6)
- NEW `backend/src/routes/indicatorConfigs.ts` — indicator config CRUD (phase 6)
- `bot/src/gdt-direct-api.service.ts` — save tax_category (phase 2)

**Database:**
- NEW `scripts/034_declaration_vat_categories.sql` (phase 1)
- NEW `scripts/035_indicator_configs.sql` (phase 1)
- NEW `scripts/backfill_tax_category.ts` (phase 2)

**Frontend:**
- `frontend/app/(app)/declarations/[id]/page.tsx` — refactor (phase 7)
- NEW `frontend/utils/indicatorFormula.ts` — formula evaluator (phase 7)
- NEW `frontend/app/(app)/admin/indicator-configs/page.tsx` — admin page (phase 8)

---

## Verification
1. Run migration 034 + 035 on dev DB — check no existing data broken
2. Verify bot saves tax_category on new invoice sync
3. Run calculateQuarterlyDeclaration for a company with [22] > 0 — verify ct40a = correct
4. Generate XML for declaration with carry-forward — confirm ct22, ct25, ct36, ct40a all match official formula
5. Open Excel — confirm 3 sheets exist, Sheet 1 layout matches BaoCaoMau.xlsx image
6. Admin indicator config page: edit a label → reload declaration detail → label updated
7. Mark one invoice non_deductible → recalculate → ct25/ct41/ct43 decrease accordingly
8. Enter [37] = 100,000 → XML shows ct37=100,000, ct40a decreases

---

## Decisions
- HKD excluded from scope (existing /declarations/hkd route unchanged)
- Formula evaluator: no eval(), custom safe parser only
- Backfill: best-effort (raw_xml column + gdt_raw_cache), no forced re-download
- DB field naming NOT refactored (too risky), mapping documented above
- NQ142 reduction: kept as-is in PLuc annex, but ct37 in XML now = NQ_reduction + manual_ct37
- KEEP existing ct30_exempt_revenue column (backward compat), add ct26_kct_revenue as new canonical name
