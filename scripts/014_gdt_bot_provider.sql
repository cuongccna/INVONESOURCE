-- Migration: add gdt_bot to invoice_provider enum
-- Needed by the GDT Crawler Bot which inserts invoices with provider='gdt_bot'
ALTER TYPE invoice_provider ADD VALUE IF NOT EXISTS 'gdt_bot';
