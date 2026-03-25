import { pool } from '../db/pool';

export interface PriceAlert {
  company_id: string;
  seller_tax_code: string;
  seller_name: string;
  item_name: string;
  prev_price: number;
  curr_price: number;
  change_pct: number;
  period_month: number;
  period_year: number;
}

export class VendorPriceTrackingService {
  /**
   * Compare average unit prices for each (seller × item) pair between current and previous month.
   * Flags increases > threshold (default 5%) or decreases > 10%.
   * Upserts to price_alerts table.
   */
  static async trackPriceChanges(
    companyId: string,
    periodMonth: number,
    periodYear: number,
    thresholdPct = 5,
  ): Promise<PriceAlert[]> {
    // Previous period
    const prevMonth = periodMonth === 1 ? 12 : periodMonth - 1;
    const prevYear = periodMonth === 1 ? periodYear - 1 : periodYear;

    const res = await pool.query<{
      seller_tax_code: string; seller_name: string; item_name: string;
      curr_price: string; prev_price: string;
    }>(
      `WITH curr AS (
         SELECT seller_tax_code, MAX(seller_name) AS seller_name,
                il.item_name,
                AVG(il.unit_price) AS avg_price
         FROM invoice_line_items il
         JOIN invoices inv ON inv.id = il.invoice_id
         WHERE inv.company_id = $1
           AND inv.direction = 'input' AND inv.status = 'valid'
           AND EXTRACT(MONTH FROM inv.invoice_date) = $2
           AND EXTRACT(YEAR  FROM inv.invoice_date) = $3
           AND il.unit_price > 0 AND il.item_name IS NOT NULL
         GROUP BY il.item_name, inv.seller_tax_code
       ),
       prev AS (
         SELECT seller_tax_code, il.item_name,
                AVG(il.unit_price) AS avg_price
         FROM invoice_line_items il
         JOIN invoices inv ON inv.id = il.invoice_id
         WHERE inv.company_id = $1
           AND inv.direction = 'input' AND inv.status = 'valid'
           AND EXTRACT(MONTH FROM inv.invoice_date) = $4
           AND EXTRACT(YEAR  FROM inv.invoice_date) = $5
           AND il.unit_price > 0 AND il.item_name IS NOT NULL
         GROUP BY il.item_name, inv.seller_tax_code
       )
       SELECT c.seller_tax_code, c.seller_name, c.item_name,
              c.avg_price AS curr_price, p.avg_price AS prev_price
       FROM curr c
       JOIN prev p USING (seller_tax_code, item_name)
       WHERE ABS((c.avg_price - p.avg_price) / NULLIF(p.avg_price, 0) * 100) >= $6`,
      [companyId, periodMonth, periodYear, prevMonth, prevYear, thresholdPct],
    );

    const alerts: PriceAlert[] = [];
    for (const row of res.rows) {
      const curr = Number(row.curr_price);
      const prev = Number(row.prev_price);
      const changePct = prev > 0 ? ((curr - prev) / prev) * 100 : 0;

      await pool.query(
        `INSERT INTO price_alerts
           (company_id, seller_tax_code, seller_name, item_name,
            prev_price, curr_price, change_pct, period_month, period_year,
            is_acknowledged)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
         ON CONFLICT DO NOTHING`,
        [
          companyId, row.seller_tax_code, row.seller_name, row.item_name,
          prev, curr, changePct, periodMonth, periodYear,
        ],
      );

      alerts.push({
        company_id: companyId,
        seller_tax_code: row.seller_tax_code,
        seller_name: row.seller_name,
        item_name: row.item_name,
        prev_price: prev,
        curr_price: curr,
        change_pct: changePct,
        period_month: periodMonth,
        period_year: periodYear,
      });
    }

    return alerts;
  }

  static async getAlerts(
    companyId: string,
    unacknowledgedOnly = false,
    page = 1,
    pageSize = 50,
  ): Promise<{ data: unknown[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const ackFilter = unacknowledgedOnly ? 'AND is_acknowledged = false' : '';
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM price_alerts WHERE company_id = $1 ${ackFilter}
         ORDER BY ABS(change_pct) DESC, created_at DESC LIMIT $2 OFFSET $3`,
        [companyId, pageSize, offset],
      ),
      pool.query(
        `SELECT COUNT(*) FROM price_alerts WHERE company_id = $1 ${ackFilter}`,
        [companyId],
      ),
    ]);
    return { data: dataRes.rows, total: Number(countRes.rows[0].count) };
  }

  static async getVendorList(companyId: string, month: number, year: number): Promise<unknown[]> {
    const res = await pool.query(
      `SELECT
         inv.seller_tax_code,
         MAX(inv.seller_name) AS seller_name,
         COUNT(DISTINCT inv.id) AS invoice_count,
         SUM(inv.total_amount) AS total_spend,
         AVG(inv.total_amount) AS avg_per_invoice,
         MAX(inv.invoice_date) AS last_invoice_date
       FROM invoices inv
       WHERE inv.company_id = $1
         AND inv.direction = 'input' AND inv.status = 'valid'
         AND EXTRACT(MONTH FROM inv.invoice_date) = $2
         AND EXTRACT(YEAR  FROM inv.invoice_date) = $3
         AND inv.seller_tax_code IS NOT NULL
       GROUP BY inv.seller_tax_code
       ORDER BY total_spend DESC`,
      [companyId, month, year],
    );
    return res.rows;
  }
}
