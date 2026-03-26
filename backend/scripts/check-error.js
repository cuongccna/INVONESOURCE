const pg = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await pool.query("SELECT provider, last_error, last_sync_at FROM company_connectors ORDER BY provider");
  console.log('=== CONNECTOR ERRORS ===');
  r.rows.forEach(row => console.log(row.provider, '|', row.last_error || 'NO ERROR', '|', row.last_sync_at));

  const s = await pool.query("SELECT provider, error_detail, records_fetched, started_at FROM sync_logs ORDER BY started_at DESC LIMIT 10");
  console.log('\n=== RECENT SYNC LOGS ===');
  s.rows.forEach(row => console.log(row.provider, '|', row.records_fetched, 'fetched |', row.error_detail || 'no error', '|', row.started_at));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
(async () => {
  const r = await pool.query("SELECT provider, last_error, last_sync_at FROM company_connectors ORDER BY provider");
  console.log('=== CONNECTOR ERRORS ===');
  r.rows.forEach(row => console.log(row.provider, '|', row.last_error || 'NO ERROR', '|', row.last_sync_at));

  const s = await pool.query("SELECT provider, error_detail, records_fetched, started_at FROM sync_logs ORDER BY started_at DESC LIMIT 10");
  console.log('\n=== RECENT SYNC LOGS ===');
  s.rows.forEach(row => console.log(row.provider, '|', row.records_fetched, 'fetched |', row.error_detail || 'no error', '|', row.started_at));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
