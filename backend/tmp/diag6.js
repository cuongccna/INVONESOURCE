const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

async function main() {
  // Check bbb company's deleted_at
  const r1 = await pool.query(
    `SELECT id, name, tax_code, deleted_at FROM companies WHERE id = '6f2f9e84-af6c-4491-b26f-440b9dc2adcd'`
  );
  console.log('BBB company:', JSON.stringify(r1.rows[0]));

  // Check ALL companies for admin@demoabc.vn user - including deleted ones
  const r2 = await pool.query(
    `SELECT c.id, c.name, c.deleted_at, uc.role
     FROM companies c 
     JOIN user_companies uc ON uc.company_id = c.id 
     JOIN users u ON u.id = uc.user_id 
     WHERE u.email = 'admin@demoabc.vn'
     ORDER BY c.name ASC`
  );
  console.log('\nALL companies (including deleted) for admin@demoabc.vn:');
  r2.rows.forEach((row, i) => console.log(i, row.id, row.name, 'deleted_at:', row.deleted_at));

  // Get user ID and what companyId is in user table (if any)
  const r3 = await pool.query(
    `SELECT u.id, u.email FROM users u WHERE u.email = 'admin@demoabc.vn'`
  );
  console.log('\nUser:', JSON.stringify(r3.rows[0]));
  
  // Check the login query result - same as auth.ts login
  const r4 = await pool.query(
    `SELECT u.id, u.email, uc.role, uc.company_id
     FROM users u
     LEFT JOIN user_companies uc ON uc.user_id = u.id
     WHERE u.email = 'admin@demoabc.vn' AND u.is_active = true
     LIMIT 1`
  );
  console.log('\nLogin query result (determines JWT companyId):', JSON.stringify(r4.rows[0]));
}

main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); });
