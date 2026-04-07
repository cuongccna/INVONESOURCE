require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { Pool } = require('pg');
const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({ connectionString: dbUrl });

async function main() {
  // All declarations with their values
  const r1 = await pool.query(`
    SELECT td.id, c.name company_name, c.tax_code, c.id company_id,
           td.period_month, td.period_year, td.period_type,
           td.ct22_total_input_vat, td.ct23_deductible_input_vat,
           td.ct40a_total_output_vat, td.ct41_payable_vat, td.ct43_carry_forward_vat,
           td.created_at, td.updated_at
    FROM tax_declarations td
    JOIN companies c ON c.id = td.company_id
    ORDER BY td.updated_at DESC
    LIMIT 10
  `);
  console.log('=== ALL DECLARATIONS ===');
  console.table(r1.rows);

  // Users and their company associations
  const r2 = await pool.query(`
    SELECT u.id user_id, u.email, uc.company_id, uc.role, c.name, c.tax_code
    FROM users u
    JOIN user_companies uc ON uc.user_id = u.id
    JOIN companies c ON c.id = uc.company_id
    ORDER BY u.email
    LIMIT 20
  `);
  console.log('=== USERS + COMPANIES ===');
  console.table(r2.rows);

  // invoices available for Q1 2026 - by company
  const r3 = await pool.query(`
    SELECT company_id, c.tax_code, COUNT(*) inv_count,
           SUM(CASE WHEN direction='output' THEN 1 ELSE 0 END) output_count,
           SUM(CASE WHEN direction='input' THEN 1 ELSE 0 END) input_count,
           SUM(CASE WHEN direction='output' THEN vat_amount ELSE 0 END) output_vat
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
    WHERE invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
    GROUP BY company_id, c.tax_code
  `);
  console.log('=== Q1 2026 INVOICES BY COMPANY ===');
  console.table(r3.rows);

  await pool.end();
}
main().catch(e => { console.error(e.message); pool.end(); });
