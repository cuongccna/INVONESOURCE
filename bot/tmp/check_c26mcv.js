require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query("SELECT invoice_number, serial_number, invoice_date::text, is_sco, updated_at::text FROM invoices WHERE serial_number='C26MCV' ORDER BY created_at DESC LIMIT 5")
  .then(r => { console.log('C26MCV rows:', JSON.stringify(r.rows, null, 2)); p.end(); })
  .catch(e => { console.error(e.message); p.end(); });
