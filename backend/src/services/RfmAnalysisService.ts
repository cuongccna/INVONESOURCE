import { pool } from '../db/pool';

export type RfmSegment =
  | 'champions'
  | 'loyal'
  | 'at_risk'
  | 'new_customer'
  | 'big_spender'
  | 'lost'
  | 'other';

function classifySegment(r: number, f: number, m: number): RfmSegment {
  if (r >= 4 && f >= 4 && m >= 4) return 'champions';
  if (m === 5) return 'big_spender';
  if (r <= 2 && f >= 3 && m >= 3) return 'at_risk';
  if (r >= 4 && f <= 1) return 'new_customer';
  if (f >= 3 && m >= 3) return 'loyal';
  if (r === 1 && f === 1) return 'lost';
  return 'other';
}

function ntile(values: number[], n: number): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v: number) => {
    const pos = sorted.indexOf(v);
    return Math.ceil(((pos + 1) / sorted.length) * n) || 1;
  };
}

export class RfmAnalysisService {
  /**
   * Calculate RFM scores for all customers of a company and upsert to customer_rfm.
   */
  static async calculateRfm(companyId: string): Promise<void> {
    const now = new Date();

    // Aggregate per buyer
    const aggRes = await pool.query<{
      buyer_tax_code: string;
      buyer_name: string;
      last_invoice_date: Date;
      invoice_count_12m: string;
      total_amount_12m: string;
    }>(
      `SELECT
         buyer_tax_code,
         MAX(buyer_name) AS buyer_name,
         MAX(invoice_date) AS last_invoice_date,
         COUNT(*) AS invoice_count_12m,
         SUM(total_amount) AS total_amount_12m
       FROM invoices
       WHERE company_id = $1
         AND direction = 'output'
         AND status = 'valid'
         AND deleted_at IS NULL
         AND invoice_date >= NOW() - INTERVAL '12 months'
         AND buyer_tax_code IS NOT NULL
       GROUP BY buyer_tax_code`,
      [companyId],
    );

    if (aggRes.rowCount === 0) {
      // No valid invoices — purge all stale RFM entries for this company
      await pool.query(`DELETE FROM customer_rfm WHERE company_id = $1`, [companyId]);
      return;
    }

    const rows = aggRes.rows;

    // Compute R, F, M raw values
    const rValues = rows.map((r) =>
      Math.floor((now.getTime() - new Date(r.last_invoice_date).getTime()) / 86_400_000),
    );
    const fValues = rows.map((r) => Number(r.invoice_count_12m));
    const mValues = rows.map((r) => Number(r.total_amount_12m));

    // Scoring functions (R: lower days = higher score, so invert)
    const scoreR = ntile(rValues.map((v) => -v), 5); // negate so fewer days = higher quintile
    const scoreF = ntile(fValues, 5);
    const scoreM = ntile(mValues, 5);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rScore = scoreR(-rValues[i]);
      const fScore = scoreF(fValues[i]);
      const mScore = scoreM(mValues[i]);
      const rfmScore = rScore * 100 + fScore * 10 + mScore;
      const segment = classifySegment(rScore, fScore, mScore);

      await pool.query(
        `INSERT INTO customer_rfm
           (company_id, buyer_tax_code, buyer_name,
            r_score, f_score, m_score, rfm_score, segment,
            last_invoice_date, invoice_count_12m, total_amount_12m, calculated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (company_id, buyer_tax_code)
         DO UPDATE SET
           buyer_name        = EXCLUDED.buyer_name,
           r_score           = EXCLUDED.r_score,
           f_score           = EXCLUDED.f_score,
           m_score           = EXCLUDED.m_score,
           rfm_score         = EXCLUDED.rfm_score,
           segment           = EXCLUDED.segment,
           last_invoice_date = EXCLUDED.last_invoice_date,
           invoice_count_12m = EXCLUDED.invoice_count_12m,
           total_amount_12m  = EXCLUDED.total_amount_12m,
           calculated_at     = NOW()`,
        [
          companyId,
          row.buyer_tax_code,
          row.buyer_name,
          rScore, fScore, mScore, rfmScore, segment,
          row.last_invoice_date,
          Number(row.invoice_count_12m),
          Number(row.total_amount_12m),
        ],
      );
    }

    // Remove stale entries for buyers no longer present in valid invoices (last 12 months)
    await pool.query(
      `DELETE FROM customer_rfm
       WHERE company_id = $1
         AND buyer_tax_code NOT IN (
           SELECT DISTINCT buyer_tax_code FROM invoices
           WHERE company_id = $1 AND direction = 'output' AND status = 'valid'
             AND deleted_at IS NULL AND buyer_tax_code IS NOT NULL
             AND invoice_date >= NOW() - INTERVAL '12 months'
         )`,
      [companyId],
    );
  }

  static async getSummary(companyId: string): Promise<unknown> {
    const res = await pool.query(
      `SELECT
         segment,
         COUNT(*)                AS customer_count,
         SUM(total_amount_12m)   AS total_revenue,
         AVG(rfm_score)::numeric(6,1) AS avg_rfm
       FROM customer_rfm
       WHERE company_id = $1
       GROUP BY segment
       ORDER BY total_revenue DESC`,
      [companyId],
    );
    return res.rows;
  }

  static async getList(
    companyId: string,
    segment?: string,
    page = 1,
    pageSize = 50,
  ): Promise<{ data: unknown[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const params: unknown[] = [companyId, pageSize, offset];
    const segFilter = segment ? `AND segment = $4` : '';
    if (segment) params.push(segment);

    const countSegFilter = segment ? 'AND segment = $2' : '';
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM customer_rfm WHERE company_id = $1 ${segFilter}
         ORDER BY total_amount_12m DESC LIMIT $2 OFFSET $3`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*) FROM customer_rfm WHERE company_id = $1 ${countSegFilter}`,
        segment ? [companyId, segment] : [companyId],
      ),
    ]);

    return { data: dataRes.rows, total: Number(countRes.rows[0].count) };
  }
}
