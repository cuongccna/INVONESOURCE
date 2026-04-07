const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://user_invone:Cuongnv123456@localhost:5432/invone_db' });

const COMPANY_ID = '0d22490d-fc12-477d-9bb6-c45e4e9b4ec1';

async function main() {
  // 1. What values does invoice_relation_type have?
  const r1 = await pool.query(
    `SELECT DISTINCT invoice_relation_type, COUNT(*) as count
     FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL
     GROUP BY invoice_relation_type
     ORDER BY count DESC`,
    [COMPANY_ID]
  );
  console.log('=== invoice_relation_type distribution ===');
  console.table(r1.rows);

  // 2. Invoices with invoice_relation_type set (non-null)
  const r2 = await pool.query(
    `SELECT invoice_number, serial_number, tc_hdon,
            invoice_relation_type, related_invoice_id, related_invoice_number, related_invoice_period,
            khhd_cl_quan, so_hd_cl_quan,
            direction, vat_amount, status
     FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL
       AND invoice_relation_type IS NOT NULL
     ORDER BY invoice_number`,
    [COMPANY_ID]
  );
  console.log('\n=== Invoices with invoice_relation_type set ===');
  console.table(r2.rows.map(r => ({
    inv_num: r.invoice_number,
    serial: r.serial_number,
    tc_hdon: r.tc_hdon,
    rel_type: r.invoice_relation_type,
    rel_inv_id: r.related_invoice_id,
    rel_inv_num: r.related_invoice_number,
    khhd_cl_quan: r.khhd_cl_quan,
    so_hd_cl_quan: r.so_hd_cl_quan,
    direction: r.direction,
    vat_amount: r.vat_amount,
  })));

  // 3. Check ALL Q1 2026 invoices sorted by number to see the full picture
  const r3 = await pool.query(
    `SELECT invoice_number, serial_number, tc_hdon,
            invoice_relation_type, related_invoice_number,
            khhd_cl_quan, so_hd_cl_quan,
            direction, vat_amount, status, gdt_validated
     FROM invoices
     WHERE company_id = $1 AND deleted_at IS NULL
       AND EXTRACT(YEAR FROM invoice_date) = 2026
     ORDER BY direction, invoice_number::integer`,
    [COMPANY_ID]
  );
  console.log('\n=== ALL Q1 2026 invoices (sorted by number) — first 20 ===');
  r3.rows.slice(0, 20).forEach(r => {
    const relInfo = r.invoice_relation_type ? ` [rel_type=${r.invoice_relation_type} rel_num=${r.related_invoice_number} khhd_cl=${r.khhd_cl_quan} so_cl=${r.so_hd_cl_quan}]` : '';
    console.log(`  #${r.invoice_number} ${r.direction} vat=${r.vat_amount} tc_hdon=${r.tc_hdon}${relInfo}`);
  });
}

main().then(() => pool.end()).catch(e => { console.error(e.message); pool.end(); });
