const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

const COMPANY_ID = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';

async function main() {
  // 1. All columns in invoices table
  const r1 = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'invoices'
     ORDER BY ordinal_position`
  );
  console.log('=== INVOICE TABLE COLUMNS ===');
  r1.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`));

  // 2. Sample 5 invoices to see the raw field values
  const r2 = await pool.query(
    `SELECT invoice_number, serial_number, invoice_type, tc_hdon,
            khhd_cl_quan, so_hd_cl_quan, so_hd_bo_thay, khhd_bo_thay,
            invoice_status, status, gdt_validated, provider_status,
            vat_amount, direction
     FROM invoices
     WHERE company_id = $1
       AND deleted_at IS NULL
       AND EXTRACT(YEAR FROM invoice_date) = 2026
     ORDER BY invoice_number::bigint
     LIMIT 15`,
    [COMPANY_ID]
  );
  console.log('\n=== SAMPLE INVOICES (tc_hdon, khhd/so replacement fields) ===');
  console.table(r2.rows.map(r => ({
    inv_num: r.invoice_number,
    serial: r.serial_number,
    invoice_type: r.invoice_type,
    tc_hdon: r.tc_hdon,
    khhd_cl_quan: r.khhd_cl_quan,
    so_hd_cl_quan: r.so_hd_cl_quan,
    so_hd_bo_thay: r.so_hd_bo_thay,
    khhd_bo_thay: r.khhd_bo_thay,
    status: r.status,
    vat_amount: r.vat_amount,
  })));

  // 3. Check for 'replace' / 'adjust' / 'cancel' type invoice_type values
  const r3 = await pool.query(
    `SELECT DISTINCT invoice_type, tc_hdon FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL
     ORDER BY invoice_type`,
    [COMPANY_ID]
  );
  console.log('\n=== Distinct invoice_type & tc_hdon ===');
  console.table(r3.rows);

  // 4. Check if any invoice references another (so_hd_bo_thay or khhd_bo_thay populated)
  const r4 = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE so_hd_bo_thay IS NOT NULL AND so_hd_bo_thay != '') as has_so_hd_bo_thay,
            COUNT(*) FILTER (WHERE khhd_bo_thay IS NOT NULL AND khhd_bo_thay != '') as has_khhd_bo_thay,
            COUNT(*) as total
     FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL`,
    [COMPANY_ID]
  );
  console.log('\n=== Replacement reference fields (bo_thay) ===');
  console.table(r4.rows);
}

main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); });
