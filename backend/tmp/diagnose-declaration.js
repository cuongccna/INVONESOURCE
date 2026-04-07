const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

async function diagnose() {
  const companyId = 'e25b2f7c-d908-4e3e-883a-bf6884cbe9e7';

  // 1. Total invoice count for this company
  const total = await pool.query('SELECT COUNT(*) as total FROM invoices WHERE company_id = $1', [companyId]);
  console.log('Total invoices for company:', total.rows[0].total);

  // 2. Invoices breakdown Q1 2026
  const inv = await pool.query(
    `SELECT direction, status, gdt_validated,
            serial_has_cqt, (mccqt IS NOT NULL) as has_mccqt,
            COUNT(*) as cnt,
            SUM(vat_amount)::numeric(15,0) as total_vat
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND invoice_date >= '2026-01-01'
       AND invoice_date < '2026-04-01'
     GROUP BY direction, status, gdt_validated, serial_has_cqt, (mccqt IS NOT NULL)
     ORDER BY direction, status`,
    [companyId]
  );
  console.log('\n=== INVOICES Q1 2026 ===');
  console.table(inv.rows);

  // 3. Check if any invoices exist for Q1 monthly (for monthly mode test)
  for (const m of [1, 2, 3]) {
    const mInv = await pool.query(
      `SELECT direction, status, COUNT(*) as cnt, SUM(vat_amount)::numeric(15,0) as vat
       FROM invoices
       WHERE company_id = $1 AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR  FROM invoice_date) = 2026
       GROUP BY direction, status`,
      [companyId, m]
    );
    console.log(`\nMonth ${m}/2026:`, mInv.rows.length ? '' : '(no rows)');
    if (mInv.rows.length) console.table(mInv.rows);
  }

  // 4. Plugin configs
  const cfg = await pool.query(
    'SELECT mst, plugin_name, enabled, config FROM validation_plugin_configs ORDER BY mst, plugin_name'
  );
  console.log('\n=== PLUGIN CONFIGS ===');
  console.table(cfg.rows);

  // 5. Company info
  const co = await pool.query(
    'SELECT id, name, tax_code FROM companies WHERE id = $1',
    [companyId]
  );
  console.log('\n=== COMPANY ===');
  console.table(co.rows);

  // 6. Check tax_declarations for Q1 2026
  const td = await pool.query(
    `SELECT period_month, period_year, period_type, submission_status,
            ct40a_total_output_vat, ct41_payable_vat, ct43_carry_forward_vat
     FROM tax_declarations
     WHERE company_id = $1 AND period_year = 2026
     ORDER BY period_month`,
    [companyId]
  );
  console.log('\n=== TAX DECLARATIONS 2026 ===');
  console.table(td.rows);

  // 7. Sample 5 invoices to see their shape
  const sample = await pool.query(
    `SELECT id, direction, status, gdt_validated, invoice_date::date,
            vat_amount, total_amount, serial_has_cqt, mccqt, tc_hdon,
            invoice_group
     FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL
       AND invoice_date >= '2026-01-01' AND invoice_date < '2026-04-01'
     LIMIT 5`,
    [companyId]
  );
  console.log('\n=== SAMPLE INVOICES (5) ===');
  console.table(sample.rows);

  await pool.end();
}

diagnose().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
