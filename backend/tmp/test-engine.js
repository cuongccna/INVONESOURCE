// Test TaxDeclarationEngine.calculateQuarterlyDeclaration directly
// using compiled dist/ code against real DB

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// Module alias for 'shared' package
const Module = require('module');
const originalLoad = Module._resolveFilename;
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'shared') {
    return require('path').join(__dirname, '../../shared/index.js');
  }
  return originalLoad.call(this, request, parent, isMain, options);
};

async function main() {
  const { TaxDeclarationEngine } = require('../dist/src/services/TaxDeclarationEngine');

  const companyId = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';  // Công 0319303270
  const quarter = 1;
  const year = 2026;

  console.log(`Testing calculateQuarterlyDeclaration Q${quarter}/${year} for company ${companyId}`);
  console.time('calculation');

  const engine = new TaxDeclarationEngine();

  try {
    const result = await engine.calculateQuarterlyDeclaration(companyId, quarter, year);
    console.timeEnd('calculation');

    console.log('\n=== QUARTERLY DECLARATION RESULT ===');
    console.log('ct22 (total input VAT)     :', result.ct22_total_input_vat);
    console.log('ct23 (deductible input VAT):', result.ct23_deductible_input_vat);
    console.log('ct40a (total output VAT)   :', result.ct40a_total_output_vat);
    console.log('ct25 (total deductible)    :', result.ct25_total_deductible);
    console.log('ct41 (payable VAT)         :', result.ct41_payable_vat);
    console.log('ct43 (carry forward)       :', result.ct43_carry_forward_vat);

    if (result._validation) {
      const v = result._validation;
      console.log('\n=== PIPELINE VALIDATION ===');
      console.log('valid_invoices count   :', v.valid_invoices.length);
      console.log('excluded count         :', v.excluded_invoices.length);
      console.log('warnings count         :', v.warnings.length);
    }

  } catch(err) {
    console.error('ERROR:', err.message);
    console.error(err.stack);
  }

  // Also verify the tax_declarations row was saved
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: dbUrl });
  const r = await pool.query(
    `SELECT period_month, period_year, period_type,
            ct22_total_input_vat, ct23_deductible_input_vat,
            ct40a_total_output_vat, ct41_payable_vat, ct43_carry_forward_vat
     FROM tax_declarations WHERE company_id=$1 AND period_year=$2 AND period_type='quarterly'
     ORDER BY period_month`,
    [companyId, year]
  );
  console.log('\n=== SAVED TAX DECLARATIONS ===');
  console.table(r.rows);
  await pool.end();
}

main().catch(console.error);
