-- Migration 016: Add quarterly declaration support
-- period_type: 'monthly' | 'quarterly'
-- For quarterly rows: period_month = quarter number (1-4), period_year = year
-- Unique constraint updated to include period_type

ALTER TABLE tax_declarations
  ADD COLUMN IF NOT EXISTS period_type VARCHAR(10) NOT NULL DEFAULT 'monthly';

-- Drop old unique constraint and recreate with period_type
ALTER TABLE tax_declarations
  DROP CONSTRAINT IF EXISTS tax_declarations_company_id_period_month_period_year_form__key;

ALTER TABLE tax_declarations
  ADD CONSTRAINT tax_declarations_unique_period
  UNIQUE (company_id, period_month, period_year, form_type, period_type);
