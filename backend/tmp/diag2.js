const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

async function main() {
  const companyId = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';

  const r1 = await pool.query(`
    SELECT direction, status, gdt_validated, COUNT(*) cnt
    FROM invoices WHERE company_id=$1
    GROUP BY direction, status, gdt_validated ORDER BY cnt DESC
  `, [companyId]);
  console.log('=== COMPANY 0319303270 - breakdown ===');
  console.table(r1.rows);

  const r2 = await pool.query(`
    SELECT EXTRACT(year FROM invoice_date) y, EXTRACT(quarter FROM invoice_date) q,
           direction, COUNT(*) cnt
    FROM invoices WHERE company_id=$1
    GROUP BY y, q, direction ORDER BY y, q
  `, [companyId]);
  console.log('=== by quarter ===');
  console.table(r2.rows);

  const r3 = await pool.query(`
    SELECT id, invoice_number, direction, status, invoice_date,
           gdt_validated, serial_has_cqt, total_amount, vat_amount
    FROM invoices WHERE company_id=$1
    ORDER BY invoice_date DESC LIMIT 5
  `, [companyId]);
  console.log('=== samples ===');
  console.table(r3.rows);

  // Check VAT reconciliation for Q1 2026
  const r4 = await pool.query(`
    SELECT direction, SUM(total_amount) total, SUM(vat_amount) vat
    FROM invoices
    WHERE company_id=$1
      AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
    GROUP BY direction
  `, [companyId]);
  console.log('=== Q1 2026 totals ===');
  console.table(r4.rows);

  // Tax declarations
  const r5 = await pool.query(`
    SELECT period_type, period, year, status, created_at
    FROM tax_declarations WHERE company_id=$1
    ORDER BY created_at DESC LIMIT 10
  `, [companyId]);
  console.log('=== tax declarations ===');
  console.table(r5.rows);

  await pool.end();
}

main().catch(e => { console.error(e); pool.end(); });
