-- Migration 015: Fix invoice upsert unique index
-- Replaces JS version — pure SQL, idempotent

BEGIN;

-- Drop old unique constraint (NULL seller_tax_code bypasses uniqueness)
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS "invoices_company_id_provider_invoice_number_seller_tax_code_key";
ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS "invoices_company_id_provider_invoice_number_seller_tax_code_invo";

-- Create functional unique index: COALESCE(seller_tax_code, '') so NULL is treated as ''
-- This makes ON CONFLICT work reliably for all rows
CREATE UNIQUE INDEX IF NOT EXISTS invoices_upsert_key
  ON invoices (company_id, provider, invoice_number, COALESCE(seller_tax_code, ''), invoice_date);

COMMIT;
