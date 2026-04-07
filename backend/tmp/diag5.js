const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

async function main() {
  // 1. Companies order for admin@demoabc.vn (same as /api/companies)
  const r1 = await pool.query(
    `SELECT c.id, c.name, c.tax_code 
     FROM companies c 
     JOIN user_companies uc ON uc.company_id = c.id 
     JOIN users u ON u.id = uc.user_id 
     WHERE u.email = 'admin@demoabc.vn' AND c.deleted_at IS NULL 
     ORDER BY c.name ASC`
  );
  console.log('=== COMPANIES ORDER (list[0] is default after cache clear) ===');
  r1.rows.forEach((row, i) => console.log(i, row.id, row.name, row.tax_code));

  // 2. All recent declarations
  const r2 = await pool.query(
    `SELECT d.id, c.name, c.id as cid, d.company_id, d.ct40a_total_output_vat, d.updated_at 
     FROM tax_declarations d JOIN companies c ON c.id = d.company_id 
     ORDER BY d.updated_at DESC LIMIT 5`
  );
  console.log('\n=== RECENT DECLARATIONS ===');
  r2.rows.forEach(row => console.log(row.id, row.cid, row.name, 'ct40a='+row.ct40a_total_output_vat, row.updated_at));
}

main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); });
