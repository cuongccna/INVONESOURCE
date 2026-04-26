-- Migration 046: Add adjusted_original to invoice_status enum
-- Required for the "HĐ bị điều chỉnh" filter in the invoices page.
-- Previously import.ts was storing 'adjusted_original' but the DB enum lacked this value,
-- causing a 500 error on GET /api/invoices?status=adjusted_original.

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'adjusted_original';
