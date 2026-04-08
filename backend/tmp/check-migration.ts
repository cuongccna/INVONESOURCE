import { pool } from '../src/db/pool';

async function main() {
  // 1. Cột migration 028
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='invoices'
       AND column_name IN ('tc_hdon','khhd_cl_quan','so_hd_cl_quan','lhd_cl_quan')
     ORDER BY column_name`
  );
  console.log('=== Migration 028: cột trên invoices ===');
  const found = cols.rows.map((r: any) => r.column_name);
  console.log(found.length ? found.join(', ') : '⚠️ THIẾU — migration 028 chưa chạy');

  // 2. Index
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename='invoices' AND indexname='idx_invoices_replacement'`
  );
  console.log('Index idx_invoices_replacement:', idx.rows.length ? '✅ TỒN TẠI' : '⚠️ THIẾU');

  // 3. Bảng validation
  const tbls = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name IN ('invoice_validation_log','validation_plugin_configs','vendor_risk_scores')`
  );
  const tblNames = tbls.rows.map((r: any) => r.table_name);
  console.log('Validation tables:', tblNames.length ? tblNames.join(', ') : '⚠️ THIẾU');

  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
