require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  console.log('Connected to DB');

  const sql = fs.readFileSync(path.join(__dirname, '026_bot_enterprise.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ Migration 026 applied successfully');

  // Verify tables were created
  for (const t of ['bot_failed_jobs', 'raw_invoice_data']) {
    const r = await db.query(`SELECT to_regclass($1) AS exists`, [`public.${t}`]);
    console.log(`   ${t}: ${r.rows[0].exists ? 'EXISTS ✅' : 'STILL MISSING ❌'}`);
  }
  await db.end();
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
