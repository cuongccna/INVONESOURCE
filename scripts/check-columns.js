const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const res = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='invoices' ORDER BY ordinal_position"
  );
  console.log('Columns in invoices table:');
  res.rows.forEach(c => console.log(' ', c.column_name.padEnd(30), c.data_type));
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
