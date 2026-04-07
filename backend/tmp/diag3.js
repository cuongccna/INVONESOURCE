const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

const companyId = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';

async function main() {
  // Check if subtotal column exists
  const colCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='invoices' AND column_name IN ('subtotal','total_amount','vat_amount')
    ORDER BY column_name
  `);
  console.log('=== invoices columns (subtotal/total_amount/vat_amount) ===');
  console.table(colCheck.rows);

  // Check Q1 2026 data - output invoices by vat_rate
  const out = await pool.query(`
    SELECT vat_rate, COUNT(*) cnt, SUM(vat_amount) vat, SUM(total_amount) total
    FROM invoices
    WHERE company_id=$1 AND direction='output' AND status='valid'
      AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
    GROUP BY vat_rate
  `, [companyId]);
  console.log('=== output by vat_rate ===');
  console.table(out.rows);

  // Check input deductible conditions
  const inp = await pool.query(`
    SELECT invoice_group, gdt_validated, COUNT(*) cnt,
           SUM(vat_amount) vat, SUM(total_amount) total
    FROM invoices
    WHERE company_id=$1 AND direction='input' AND status='valid'
      AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
    GROUP BY invoice_group, gdt_validated
  `, [companyId]);
  console.log('=== input group/gdt_validated breakdown ===');
  console.table(inp.rows);

  // Check which invoices fail the deductible check
  const notDeductible = await pool.query(`
    SELECT id, invoice_number, invoice_group, gdt_validated, total_amount, payment_method, serial_has_cqt
    FROM invoices
    WHERE company_id=$1 AND direction='input' AND status='valid'
      AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
      AND NOT (
        (COALESCE(invoice_group, 5) = 5 AND gdt_validated = true)
        OR (invoice_group IN (6, 8))
      )
    LIMIT 10
  `, [companyId]);
  console.log('=== input invoices NOT deductible ===', notDeductible.rows.length, 'rows');
  console.table(notDeductible.rows);

  // Check invoices missing vat_rate or subtotal
  const noVatRate = await pool.query(`
    SELECT COUNT(*) cnt FROM invoices
    WHERE company_id=$1 AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
      AND vat_rate IS NULL
  `, [companyId]);
  console.log('Invoices with NULL vat_rate:', noVatRate.rows[0].cnt);

  // Try direct simulation of quarterly query
  const m1=1, m2=2, m3=3, year=2026;
  const months = [m1, m2, m3];
  try {
    const outTest = await pool.query(`
      SELECT vat_rate, SUM(vat_amount) AS vat_sum, SUM(total_amount) AS subtotal_sum
      FROM invoices
      WHERE company_id=$1
        AND direction='output'
        AND status='valid'
        AND deleted_at IS NULL
        AND EXTRACT(YEAR FROM invoice_date) = $2
        AND EXTRACT(MONTH FROM invoice_date) = ANY($3::int[])
      GROUP BY vat_rate
    `, [companyId, year, months]);
    console.log('=== QUARTERLY OUTPUT SIMULATION ===');
    console.table(outTest.rows);
  } catch(e) {
    console.error('QUARTERLY OUTPUT ERROR:', e.message);
  }

  // Try with subtotal column
  try {
    const subtotalTest = await pool.query(`
      SELECT id, total_amount, vat_amount FROM invoices WHERE company_id=$1 LIMIT 3
    `, [companyId]);
    console.log('Sample invoice (total_amount, vat_amount):', subtotalTest.rows);
  } catch(e) {
    console.error('ERROR:', e.message);
  }

  await pool.end();
}

main().catch(e => { console.error(e.message); pool.end(); });
