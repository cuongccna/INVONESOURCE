require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.WORKER_DB_URL || process.env.DATABASE_URL });
p.query(
  "SELECT invoice_number, serial_number, invoice_date::text, is_sco, direction, seller_tax_code FROM invoices WHERE id=$1",
  ['a8d673bf-5cc8-4bf4-88f8-4af4a82ef00e']
).then(r => {
  console.log(JSON.stringify(r.rows, null, 2));
}).catch(console.error).finally(() => p.end());
