const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

const COMPANY_ID = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';

async function main() {
  // 1. Check invoices with tc_hdon != 0 (replacements/adjustments)
  const r1 = await pool.query(
    `SELECT id, invoice_number, serial_number, seller_tax_code, buyer_tax_code,
            tc_hdon, khhd_cl_quan, so_hd_cl_quan, direction,
            vat_amount, status, gdt_validated,
            invoice_date
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
       AND EXTRACT(YEAR  FROM invoice_date) = 2026
       AND (tc_hdon IS NOT NULL AND tc_hdon != 0)
     ORDER BY invoice_date, invoice_number`,
    [COMPANY_ID]
  );
  console.log('=== INVOICES WITH tc_hdon (replacement/adjustment invoices) ===');
  console.table(r1.rows.map(r => ({
    invoice_number: r.invoice_number,
    serial_number: r.serial_number,
    tc_hdon: r.tc_hdon,
    khhd_cl_quan: r.khhd_cl_quan,
    so_hd_cl_quan: r.so_hd_cl_quan,
    direction: r.direction,
    vat_amount: r.vat_amount,
    status: r.status,
    gdt_validated: r.gdt_validated,
  })));

  // 2. Check invoices that SHOULD be excluded (the originals being replaced)
  // These should have a replacement invoice pointing to them
  const r2 = await pool.query(
    `SELECT orig.invoice_number, orig.serial_number, orig.seller_tax_code, orig.direction,
            orig.vat_amount, orig.status, orig.gdt_validated,
            repl.invoice_number AS replaced_by_inv,
            repl.tc_hdon
     FROM invoices orig
     JOIN invoices repl ON repl.tc_hdon = 1
                       AND repl.khhd_cl_quan = orig.serial_number
                       AND repl.so_hd_cl_quan = orig.invoice_number
                       AND repl.seller_tax_code = orig.seller_tax_code
     WHERE orig.company_id = $1
       AND orig.deleted_at IS NULL
       AND EXTRACT(MONTH FROM orig.invoice_date) IN (1,2,3)
       AND EXTRACT(YEAR  FROM orig.invoice_date) = 2026`,
    [COMPANY_ID]
  );
  console.log('\n=== INVOICES THAT SHOULD BE EXCLUDED (originals with tc_hdon=1 replacement referencing them) ===');
  console.table(r2.rows);

  // 3. Check tc_hdon distribution
  const r3 = await pool.query(
    `SELECT tc_hdon, COUNT(*) as count
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
       AND EXTRACT(YEAR  FROM invoice_date) = 2026
     GROUP BY tc_hdon
     ORDER BY tc_hdon`,
    [COMPANY_ID]
  );
  console.log('\n=== tc_hdon distribution ===');
  console.table(r3.rows);

  // 4. Check khhd_cl_quan / so_hd_cl_quan null distribution
  const r4 = await pool.query(
    `SELECT 
       COUNT(*) FILTER (WHERE tc_hdon = 1 AND khhd_cl_quan IS NULL) as "tc_hdon1_khhd_null",
       COUNT(*) FILTER (WHERE tc_hdon = 1 AND khhd_cl_quan IS NOT NULL) as "tc_hdon1_khhd_ok",
       COUNT(*) FILTER (WHERE tc_hdon = 1) as "tc_hdon1_total"
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
       AND EXTRACT(YEAR  FROM invoice_date) = 2026`,
    [COMPANY_ID]
  );
  console.log('\n=== tc_hdon=1 null check ===');
  console.table(r4.rows);

  // 5. How many invoices with status=valid for Q1
  const r5 = await pool.query(
    `SELECT direction, status, gdt_validated, COUNT(*) as count, SUM(vat_amount) as total_vat
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND EXTRACT(MONTH FROM invoice_date) IN (1,2,3)
       AND EXTRACT(YEAR  FROM invoice_date) = 2026
     GROUP BY direction, status, gdt_validated
     ORDER BY direction, status`,
    [COMPANY_ID]
  );
  console.log('\n=== Invoice summary by direction/status ===');
  console.table(r5.rows);
}

main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); });
