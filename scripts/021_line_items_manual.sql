-- Add is_manual flag to invoice_line_items to distinguish manually-entered
-- line items (for header-only Nhóm 6/8 invoices from GDT Bot) from
-- auto-imported ones. Manually-added items can be edited/deleted in the UI.

ALTER TABLE invoice_line_items
  ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_line_items_manual ON invoice_line_items(invoice_id) WHERE is_manual = true;
