#!/usr/bin/env ts-node
import { pool } from '../src/db/pool';
import { InvoiceValidationPipeline } from '../src/tax/validation/invoice-validation.pipeline';

function periodToDateRange(period: string): { startDate: Date; endDate: Date } {
  const quarterMatch = period.match(/^(\d{4})-Q([1-4])$/);
  if (quarterMatch) {
    const year = parseInt(quarterMatch[1], 10);
    const quarter = parseInt(quarterMatch[2], 10);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 3;
    const startDate = new Date(year, startMonth - 1, 1);
    const endDate = new Date(year, endMonth - 1, 1);
    return { startDate, endDate };
  }
  const monthMatch = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10);
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 1);
    return { startDate, endDate };
  }
  throw new Error('Invalid period format');
}

(async function main(){
  try {
    const mst = process.argv[2] || '0319303270';
    const period = process.argv[3] || '2026-Q1';
    const direction = (process.argv[4] as any) || 'both';

    const { startDate, endDate } = periodToDateRange(period);
    console.log('Running validation pipeline for', mst, period, direction, startDate.toISOString(), '->', endDate.toISOString());

    const compRes = await pool.query('SELECT id FROM companies WHERE tax_code=$1 LIMIT 1', [mst]);
    if (!compRes.rows.length) {
      console.error('Company not found for tax_code', mst);
      process.exit(2);
    }
    const companyId = compRes.rows[0].id;

    let invoiceQuery = `SELECT id, company_id, direction, status, invoice_number, serial_number, invoice_date, seller_tax_code, seller_name, buyer_tax_code, buyer_name, total_amount, vat_amount, payment_method, gdt_validated, invoice_group, serial_has_cqt, has_line_items, mccqt, tc_hdon, lhd_cl_quan, khhd_cl_quan, so_hd_cl_quan FROM invoices WHERE company_id = $1 AND deleted_at IS NULL AND invoice_date >= $2 AND invoice_date < $3`;
    const params: unknown[] = [companyId, startDate, endDate];
    if (direction !== 'both') { params.push(direction); invoiceQuery += ` AND direction = $${params.length}`; }

    const { rows: invoices } = await pool.query(invoiceQuery, params);
    console.log('Invoices found:', invoices.length);

    const pipeline = new InvoiceValidationPipeline(pool);
    const output = await pipeline.validate(invoices, {
      mst,
      declaration_period: period,
      declaration_type: period.includes('Q') ? 'quarterly' : 'monthly',
      direction,
    } as any);

    console.log('Pipeline output stats:', output.stats);
    console.log('Excluded examples:', (output.excluded_invoices || []).slice(0,10));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
