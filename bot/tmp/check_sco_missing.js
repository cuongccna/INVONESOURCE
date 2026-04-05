require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.WORKER_DB_URL || process.env.DATABASE_URL });

async function main() {
  const r = await p.query(
    `SELECT i.id, i.invoice_number, i.serial_number, i.invoice_date::text, i.is_sco, i.direction, i.seller_tax_code, i.updated_at::text
     FROM invoices i
     WHERE i.is_sco = true
       AND NOT EXISTS (SELECT 1 FROM invoice_line_items l WHERE l.invoice_id = i.id)
     ORDER BY i.updated_at DESC`
  );
  console.log(JSON.stringify(r.rows, null, 2));
}

main().catch(console.error).finally(() => p.end());
