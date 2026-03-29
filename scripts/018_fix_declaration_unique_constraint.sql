-- Migration 018: Drop stale 4-column unique constraint on tax_declarations
-- Migration 016 tried to drop 'tax_declarations_company_id_period_month_period_year_form__key'
-- (double underscore) but the real PostgreSQL-generated name is
-- 'tax_declarations_company_id_period_month_period_year_form_t_key' (truncated at 63 chars).
-- So the old constraint was never removed, causing duplicate-key errors alongside the new one.

ALTER TABLE tax_declarations
  DROP CONSTRAINT IF EXISTS tax_declarations_company_id_period_month_period_year_form_t_key;

-- Ensure the correct 5-column constraint from migration 016 is in place
ALTER TABLE tax_declarations
  DROP CONSTRAINT IF EXISTS tax_declarations_unique_period;

ALTER TABLE tax_declarations
  ADD CONSTRAINT tax_declarations_unique_period
  UNIQUE (company_id, period_month, period_year, form_type, period_type);
