require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.WORKER_DB_URL || process.env.DATABASE_URL });

async function main() {
  // Check C26MCV invoices
  const r1 = await p.query(
    `SELECT id, invoice_number, serial_number, invoice_date::text, is_sco, direction, seller_tax_code, has_line_items
     FROM invoices WHERE serial_number='C26MCV' ORDER BY updated_at DESC LIMIT 5`
  );
  console.log('=== C26MCV invoices ===');
  console.log(JSON.stringify(r1.rows, null, 2));

  // Check invoices with is_sco=true that have NO line items
  const r2 = await p.query(
    `SELECT i.id, i.invoice_number, i.serial_number, i.is_sco, i.direction, i.seller_tax_code
     FROM invoices i
     WHERE i.is_sco = true
       AND NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = i.id)
     LIMIT 10`
  );
  console.log('\n=== is_sco=true invoices WITHOUT line items ===');
  console.log(JSON.stringify(r2.rows, null, 2));

  // Count sco vs non-sco line item coverage
  const r3 = await p.query(
    `SELECT i.is_sco,
            COUNT(*) as total,
            COUNT(DISTINCT l.invoice_id) as with_line_items,
            COUNT(*) - COUNT(DISTINCT l.invoice_id) as without_line_items
     FROM invoices i
     LEFT JOIN invoice_line_items l ON l.invoice_id = i.id
     GROUP BY i.is_sco`
  );
  console.log('\n=== Line items coverage by is_sco ===');
  console.log(JSON.stringify(r3.rows, null, 2));
}

main().catch(console.error).finally(() => p.end());
