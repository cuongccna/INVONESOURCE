-- ============================================================
-- 008_fix_numeric_overflow.sql
-- Expand NUMERIC precision to NUMERIC(22,2) for all money columns
-- NUMERIC(18,2) max = 9,999,999,999,999,999.99 (~9,999 tỷ) — looks big but
-- some legacy/test invoices carry unrealistic values that trip the limit.
-- NUMERIC(22,2) max = 9,999,999,999,999,999,999,999.99 (far beyond needed)
-- ============================================================

-- invoices
ALTER TABLE invoices
  ALTER COLUMN subtotal     TYPE NUMERIC(22,2),
  ALTER COLUMN vat_amount   TYPE NUMERIC(22,2),
  ALTER COLUMN total_amount TYPE NUMERIC(22,2);

-- invoice_line_items (created in 006_crm.sql)
ALTER TABLE invoice_line_items
  ALTER COLUMN unit_price TYPE NUMERIC(22,4),
  ALTER COLUMN subtotal   TYPE NUMERIC(22,2),
  ALTER COLUMN total      TYPE NUMERIC(22,2);

-- vat_reconciliations
ALTER TABLE vat_reconciliations
  ALTER COLUMN output_vat  TYPE NUMERIC(22,2),
  ALTER COLUMN input_vat   TYPE NUMERIC(22,2),
  ALTER COLUMN payable_vat TYPE NUMERIC(22,2);

-- tax_declarations
ALTER TABLE tax_declarations
  ALTER COLUMN ct22_total_input_vat      TYPE NUMERIC(22,0),
  ALTER COLUMN ct23_deductible_input_vat TYPE NUMERIC(22,0),
  ALTER COLUMN ct25_total_deductible     TYPE NUMERIC(22,0),
  ALTER COLUMN ct29_total_revenue        TYPE NUMERIC(22,0),
  ALTER COLUMN ct40_total_output_revenue TYPE NUMERIC(22,0),
  ALTER COLUMN ct40a_total_output_vat    TYPE NUMERIC(22,0),
  ALTER COLUMN ct41_payable_vat          TYPE NUMERIC(22,0),
  ALTER COLUMN ct43_carry_forward_vat    TYPE NUMERIC(22,0);

-- Reset circuit breaker for viettel so sync can retry immediately
UPDATE company_connectors
SET consecutive_failures = 0,
    circuit_state        = 'CLOSED',
    last_error           = NULL
WHERE provider = 'viettel';
