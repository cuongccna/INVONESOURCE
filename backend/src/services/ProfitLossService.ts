/**
 * Group 40 — PL-01: Profit & Loss calculation engine
 * Vietnamese accounting standard B02-DN (Thong tu 200/2014/TT-BTC)
 */
import { pool } from '../db/pool';

export interface PLStatement {
  company_id: string;
  period_month: number;
  period_year: number;
  line_01: number;  // Doanh thu BH va CCDV
  line_02: number;  // Cac khoan giam tru DT
  line_10: number;  // Doanh thu thuan (01-02)
  line_11: number;  // Gia von hang ban
  line_20: number;  // Loi nhuan gop (10-11)
  line_21: number;  // DT hoat dong tai chinh
  line_22: number;  // Chi phi tai chinh
  line_25: number;  // Chi phi ban hang
  line_26: number;  // Chi phi QLDN
  line_30: number;  // LN thuan tu HDKD
  line_31: number;  // Thu nhap khac
  line_32: number;  // Chi phi khac
  line_40: number;  // Loi nhuan khac (31-32)
  line_50: number;  // Tong LN truoc thue (30+40)
  line_51: number;  // Chi phi thue TNDN
  line_60: number;  // LN sau thue (50-51)
  has_estimates: boolean;
  estimate_notes: string;
}

export class ProfitLossService {
  async calculatePL(companyId: string, month: number, year: number): Promise<PLStatement> {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    // Line 01: Total revenue from valid output invoices
    const revRes = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
       WHERE company_id=$1 AND direction='output' AND status='valid'
         AND deleted_at IS NULL
         AND invoice_date BETWEEN $2 AND $3`,
      [companyId, startDate, endDate],
    );
    const line01 = Number(revRes.rows[0]?.total ?? 0);

    // Line 11: COGS — use sum of matching input invoice line items
    // Match output & input by item_name within same period (approximation)
    const cogsRes = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(ili.total),0) AS total
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       WHERE i.company_id=$1 AND i.direction='input' AND i.status='valid'
         AND i.deleted_at IS NULL
         AND i.invoice_date BETWEEN $2 AND $3
         AND ili.item_name IN (
           SELECT DISTINCT ili2.item_name
           FROM invoice_line_items ili2
           JOIN invoices i2 ON i2.id = ili2.invoice_id
           WHERE i2.company_id=$1 AND i2.direction='output' AND i2.status='valid'
             AND i2.deleted_at IS NULL
             AND i2.invoice_date BETWEEN $2 AND $3
         )`,
      [companyId, startDate, endDate],
    );
    const cogsFromMatched = Number(cogsRes.rows[0]?.total ?? 0);

    // If no matching line items, fall back to total input as estimate
    let line11 = cogsFromMatched;
    let hasEstimates = false;
    let estimateNotes = '';
    if (cogsFromMatched === 0) {
      const inputRes = await pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(subtotal),0) AS total FROM invoices
         WHERE company_id=$1 AND direction='input' AND status='valid'
           AND deleted_at IS NULL
           AND invoice_date BETWEEN $2 AND $3`,
        [companyId, startDate, endDate],
      );
      line11 = Number(inputRes.rows[0]?.total ?? 0);
      hasEstimates = true;
      estimateNotes = 'Gia von duoc uoc tinh tu tong chi phi mua hang do thieu chi tiet hang hoa khop.';
    }

    // Cash book expenses
    let line25 = 0, line26 = 0, line31 = 0, line32 = 0;
    try {
      const cashRes = await pool.query<{ category: string; entry_type: string; total: string }>(
        `SELECT category, entry_type, COALESCE(SUM(amount),0) AS total
         FROM cash_book_entries
         WHERE company_id=$1 AND entry_date BETWEEN $2 AND $3 AND is_deleted=false
           AND entry_type IN ('receipt','payment')
         GROUP BY category, entry_type`,
        [companyId, startDate, endDate],
      );
      for (const r of cashRes.rows) {
        const amt = Number(r.total);
        if (r.entry_type === 'payment') {
          if (r.category?.includes('ban hang') || r.category?.includes('bán hàng')) line25 += amt;
          else if (r.category?.includes('quan ly') || r.category?.includes('quản lý') || r.category?.includes('QLDN')) line26 += amt;
          else if (r.category?.includes('khac') || r.category?.includes('khác')) line32 += amt;
        } else if (r.entry_type === 'receipt') {
          if (r.category?.includes('khac') || r.category?.includes('khác') || r.category?.includes('other')) line31 += amt;
        }
      }
    } catch {
      // cash_book_entries may not exist for all companies
    }

    const line10 = line01 - 0; // line02 = 0
    const line20 = line10 - line11;
    const line30 = line20 + 0 - 0 - line25 - line26; // line21=0, line22=0
    const line40 = line31 - line32;
    const line50 = line30 + line40;

    // Tax: 20% TNDN for DN; HKD handled separately
    const companyInfo = await pool.query<{ business_type: string }>(
      `SELECT COALESCE(business_type,'DN') AS business_type FROM companies WHERE id=$1`,
      [companyId],
    );
    const isDN = (companyInfo.rows[0]?.business_type ?? 'DN') === 'DN';
    const line51 = isDN && line50 > 0 ? Math.round(line50 * 0.20 * 100) / 100 : 0;
    const line60 = line50 - line51;

    const result: PLStatement = {
      company_id: companyId,
      period_month: month,
      period_year: year,
      line_01: Math.round(line01),
      line_02: 0,
      line_10: Math.round(line10),
      line_11: Math.round(line11),
      line_20: Math.round(line20),
      line_21: 0,
      line_22: 0,
      line_25: Math.round(line25),
      line_26: Math.round(line26),
      line_30: Math.round(line30),
      line_31: Math.round(line31),
      line_32: Math.round(line32),
      line_40: Math.round(line40),
      line_50: Math.round(line50),
      line_51: Math.round(line51),
      line_60: Math.round(line60),
      has_estimates: hasEstimates,
      estimate_notes: estimateNotes,
    };

    // Upsert to DB
    await pool.query(
      `INSERT INTO profit_loss_statements
         (company_id, period_month, period_year,
          line_01,line_02,line_10,line_11,line_20,line_21,line_22,line_25,line_26,
          line_30,line_31,line_32,line_40,line_50,line_51,line_60,
          has_estimates,estimate_notes,generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
       ON CONFLICT (company_id,period_month,period_year) DO UPDATE SET
         line_01=$4,line_02=$5,line_10=$6,line_11=$7,line_20=$8,line_21=$9,line_22=$10,
         line_25=$11,line_26=$12,line_30=$13,line_31=$14,line_32=$15,line_40=$16,
         line_50=$17,line_51=$18,line_60=$19,has_estimates=$20,estimate_notes=$21,generated_at=NOW()`,
      [companyId, month, year,
       result.line_01, result.line_02, result.line_10, result.line_11, result.line_20,
       result.line_21, result.line_22, result.line_25, result.line_26, result.line_30,
       result.line_31, result.line_32, result.line_40, result.line_50, result.line_51,
       result.line_60, result.has_estimates, result.estimate_notes],
    );

    return result;
  }

  /** Aggregate P&L across multiple months (for quarterly / yearly views). Re-derives computed lines. */
  async getAggregatedPL(
    companyId: string,
    year: number,
    fromMonth: number,
    toMonth: number,
  ): Promise<PLStatement | null> {
    const { rows } = await pool.query<{
      line_01: string; line_02: string; line_11: string;
      line_21: string; line_22: string; line_25: string; line_26: string;
      line_31: string; line_32: string; line_51: string;
      has_estimates: boolean; found_months: string;
    }>(
      `SELECT
         SUM(line_01) AS line_01, SUM(line_02) AS line_02,
         SUM(line_11) AS line_11,
         SUM(line_21) AS line_21, SUM(line_22) AS line_22,
         SUM(line_25) AS line_25, SUM(line_26) AS line_26,
         SUM(line_31) AS line_31, SUM(line_32) AS line_32,
         SUM(line_51) AS line_51,
         BOOL_OR(has_estimates) AS has_estimates,
         COUNT(*) AS found_months
       FROM profit_loss_statements
       WHERE company_id=$1 AND period_year=$2 AND period_month BETWEEN $3 AND $4`,
      [companyId, year, fromMonth, toMonth],
    );
    if (!rows.length || Number(rows[0]!.found_months) === 0) return null;
    const r = rows[0]!;
    const l01 = Number(r.line_01);  const l02 = Number(r.line_02);
    const l10 = l01 - l02;
    const l11 = Number(r.line_11);  const l20 = l10 - l11;
    const l21 = Number(r.line_21);  const l22 = Number(r.line_22);
    const l25 = Number(r.line_25);  const l26 = Number(r.line_26);
    const l30 = l20 + l21 - l22 - l25 - l26;
    const l31 = Number(r.line_31);  const l32 = Number(r.line_32);
    const l40 = l31 - l32;
    const l50 = l30 + l40;
    const l51 = Number(r.line_51);  const l60 = l50 - l51;
    return {
      company_id: companyId, period_month: fromMonth, period_year: year,
      line_01: l01, line_02: l02, line_10: l10,
      line_11: l11, line_20: l20,
      line_21: l21, line_22: l22, line_25: l25, line_26: l26,
      line_30: l30, line_31: l31, line_32: l32,
      line_40: l40, line_50: l50, line_51: l51, line_60: l60,
      has_estimates: r.has_estimates as boolean,
      estimate_notes: '',
    };
  }

  async getPL(companyId: string, month: number, year: number): Promise<PLStatement | null> {
    const { rows } = await pool.query(
      `SELECT * FROM profit_loss_statements WHERE company_id=$1 AND period_month=$2 AND period_year=$3`,
      [companyId, month, year],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      company_id: r.company_id,
      period_month: r.period_month,
      period_year: r.period_year,
      line_01: Number(r.line_01), line_02: Number(r.line_02), line_10: Number(r.line_10),
      line_11: Number(r.line_11), line_20: Number(r.line_20), line_21: Number(r.line_21),
      line_22: Number(r.line_22), line_25: Number(r.line_25), line_26: Number(r.line_26),
      line_30: Number(r.line_30), line_31: Number(r.line_31), line_32: Number(r.line_32),
      line_40: Number(r.line_40), line_50: Number(r.line_50), line_51: Number(r.line_51),
      line_60: Number(r.line_60),
      has_estimates: r.has_estimates,
      estimate_notes: r.estimate_notes ?? '',
    };
  }
}

export const profitLossService = new ProfitLossService();
