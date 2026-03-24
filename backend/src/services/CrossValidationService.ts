import { pool } from '../db/pool';

export interface CrossValidationReport {
  companyId: string;
  period: { month: number; year: number };
  matched: number;
  onlyInProvider: ProviderInvoice[];
  onlyInGdt: ProviderInvoice[];
  amountMismatches: AmountMismatch[];
  generatedAt: Date;
}

export interface ProviderInvoice {
  invoiceId: string;
  invoiceNumber: string;
  sellerTaxCode: string;
  invoiceDate: Date;
  totalAmount: number;
  provider: string;
}

export interface AmountMismatch {
  invoiceNumber: string;
  sellerTaxCode: string;
  providerAmount: number;
  gdtAmount: number;
  difference: number;
  providerSource: string;
}

/**
 * CrossValidationService — compares invoices from nhà mạng connectors vs GDT Intermediary
 * to detect registration discrepancies.
 */
export class CrossValidationService {
  async crossValidate(
    companyId: string,
    period: { month: number; year: number }
  ): Promise<CrossValidationReport> {
    const { month, year } = period;

    // 1. Fetch invoices from nhà mạng (misa, viettel, bkav)
    const { rows: providerInvoices } = await pool.query<{
      id: string;
      invoice_number: string;
      seller_tax_code: string;
      invoice_date: Date;
      total_amount: string;
      provider: string;
    }>(
      `SELECT id, invoice_number, seller_tax_code, invoice_date, total_amount, provider
       FROM invoices
       WHERE company_id = $1
         AND provider IN ('misa', 'viettel', 'bkav')
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3`,
      [companyId, month, year]
    );

    // 2. Fetch from GDT Intermediary
    const { rows: gdtInvoices } = await pool.query<{
      id: string;
      invoice_number: string;
      seller_tax_code: string;
      invoice_date: Date;
      total_amount: string;
    }>(
      `SELECT id, invoice_number, seller_tax_code, invoice_date, total_amount
       FROM invoices
       WHERE company_id = $1
         AND provider = 'gdt_intermediary'
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3`,
      [companyId, month, year]
    );

    // 3. Match by: invoice_number + seller_tax_code + invoice_date (date only, no time)
    type MatchKey = string;
    const makeKey = (invNum: string, sellerTax: string, date: Date): MatchKey =>
      `${invNum}|${sellerTax}|${new Date(date).toISOString().split('T')[0]}`;

    const providerMap = new Map<MatchKey, (typeof providerInvoices)[number]>();
    for (const inv of providerInvoices) {
      providerMap.set(makeKey(inv.invoice_number, inv.seller_tax_code, inv.invoice_date), inv);
    }

    const gdtMap = new Map<MatchKey, (typeof gdtInvoices)[number]>();
    for (const inv of gdtInvoices) {
      gdtMap.set(makeKey(inv.invoice_number, inv.seller_tax_code, inv.invoice_date), inv);
    }

    const onlyInProvider: ProviderInvoice[] = [];
    const onlyInGdt: ProviderInvoice[] = [];
    const amountMismatches: AmountMismatch[] = [];
    let matched = 0;

    // 4. Compare provider vs GDT
    for (const [key, pInv] of providerMap) {
      const gInv = gdtMap.get(key);
      if (!gInv) {
        onlyInProvider.push({
          invoiceId: pInv.id,
          invoiceNumber: pInv.invoice_number,
          sellerTaxCode: pInv.seller_tax_code,
          invoiceDate: pInv.invoice_date,
          totalAmount: parseFloat(pInv.total_amount),
          provider: pInv.provider,
        });
      } else {
        matched++;
        const pAmt = parseFloat(pInv.total_amount);
        const gAmt = parseFloat(gInv.total_amount);
        if (Math.abs(pAmt - gAmt) > 1000) {  // tolerance: 1000đ
          amountMismatches.push({
            invoiceNumber: pInv.invoice_number,
            sellerTaxCode: pInv.seller_tax_code,
            providerAmount: pAmt,
            gdtAmount: gAmt,
            difference: pAmt - gAmt,
            providerSource: pInv.provider,
          });
        }
      }
    }

    // Invoices only in GDT (not in nhà mạng)
    for (const [key, gInv] of gdtMap) {
      if (!providerMap.has(key)) {
        onlyInGdt.push({
          invoiceId: gInv.id,
          invoiceNumber: gInv.invoice_number,
          sellerTaxCode: gInv.seller_tax_code,
          invoiceDate: gInv.invoice_date,
          totalAmount: parseFloat(gInv.total_amount),
          provider: 'gdt_intermediary',
        });
      }
    }

    // 6. Create notifications for critical discrepancies
    if (amountMismatches.length > 0) {
      const { v4: uuidv4 } = await import('uuid');
      const { rows: users } = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM user_companies WHERE company_id = $1',
        [companyId]
      );
      for (const user of users) {
        await pool.query(
          `INSERT INTO notifications (id, company_id, user_id, type, title, body)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(), companyId, user.user_id,
            'CROSS_VALIDATION_MISMATCH',
            'Phát hiện chênh lệch số liệu',
            `⚠️ ${amountMismatches.length} hóa đơn có số tiền chênh lệch giữa nhà mạng và GDT`,
          ]
        );
      }
    }

    return {
      companyId,
      period,
      matched,
      onlyInProvider,
      onlyInGdt,
      amountMismatches,
      generatedAt: new Date(),
    };
  }
}

export const crossValidationService = new CrossValidationService();
