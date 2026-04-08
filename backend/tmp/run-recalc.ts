#!/usr/bin/env ts-node
import { pool } from '../src/db/pool';
import { TaxDeclarationEngine } from '../src/services/TaxDeclarationEngine';

(async function main(){
  try {
    const taxCode = process.argv[2] || '0319303270';
    const quarter = parseInt(process.argv[3] || '1', 10);
    const year = parseInt(process.argv[4] || '2026', 10);

    const compRes = await pool.query('SELECT id, name FROM companies WHERE tax_code = $1 LIMIT 1', [taxCode]);
    if (!compRes.rows.length) { console.error('Company not found for tax_code', taxCode); process.exit(2); }
    const companyId = compRes.rows[0].id;
    console.log('Running TaxDeclarationEngine for company', compRes.rows[0].name, companyId, 'quarter', quarter, year);

    const engine = new TaxDeclarationEngine();
    const decl = await engine.calculateQuarterlyDeclaration(companyId, quarter, year);

    console.log('Declaration upsert result (DB row):');
    console.log({ ct22: decl.ct22_total_input_vat, ct23: decl.ct23_deductible_input_vat, ct29: decl.ct29_total_revenue, ct40a: decl.ct40a_total_output_vat, ct41: decl.ct41_payable_vat, ct43: decl.ct43_carry_forward_vat });

    // Fetch stored rows for verification
    const td = await pool.query('SELECT * FROM tax_declarations WHERE company_id=$1 AND period_month=$2 AND period_year=$3 AND period_type=$4', [companyId, quarter, year, 'quarterly']);
    console.log('Tax declarations rows count:', td.rows.length);
    if (td.rows.length) console.log(td.rows[0]);

    const vat = await pool.query('SELECT * FROM vat_reconciliations WHERE company_id=$1 AND period_month=$2 AND period_year=$3 LIMIT 1', [companyId, quarter, year]);
    console.log('Vat reconciliations rows count:', vat.rows.length);
    if (vat.rows.length) console.log(vat.rows[0]);

    // Show validation run id
    console.log('Validation stats:', decl._validation?.stats ?? null);
    console.log('Validation run id:', decl._validation?.pipeline_run_id ?? null);

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err);
    try { await pool.end(); } catch(e){}
    process.exit(1);
  }
})();
