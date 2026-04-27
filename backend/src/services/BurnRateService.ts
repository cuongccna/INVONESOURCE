import { pool } from '../db/pool';

export interface RepurchasePrediction {
  id: string;
  buyer_tax_code: string;
  buyer_name: string | null;
  normalized_item_name: string;
  display_item_name: string | null;
  avg_interval_days: number;
  avg_quantity: number;
  last_purchase_date: string;
  predicted_next_date: string;
  days_until_predicted: number;
  confidence: 'high' | 'medium' | 'low';
  data_points: number;
  is_actioned: boolean;
  action_note: string | null;
}

export class BurnRateService {
  async calculateBurnRate(companyId: string): Promise<void> {
    // Step 1: compute intervals using window functions on invoice_line_items
    const { rows } = await pool.query<{
      buyer_tax_code: string;
      buyer_name: string;
      norm_item: string;
      display_item: string;
      avg_interval: string | null;
      avg_qty: string | null;
      last_date: string;
      data_points: string;
    }>(
      `WITH ordered AS (
         SELECT
           i.buyer_tax_code,
           i.buyer_name,
           LOWER(REGEXP_REPLACE(
             TRIM(ili.item_name), '[^a-z0-9 ]', '', 'gi'
           ))                                AS norm_item,
           ili.item_name                     AS display_item,
           i.invoice_date,
           ili.quantity,
           LAG(i.invoice_date) OVER (
             PARTITION BY i.buyer_tax_code, LOWER(REGEXP_REPLACE(TRIM(ili.item_name), '[^a-z0-9 ]', '', 'gi'))
             ORDER BY i.invoice_date
           ) AS prev_date
         FROM invoice_line_items ili
         JOIN invoices i ON i.id = ili.invoice_id
         WHERE i.company_id = $1
           AND i.direction = 'output'
           AND i.status != 'cancelled'
           AND i.buyer_tax_code IS NOT NULL
           AND BTRIM(i.buyer_tax_code) <> ''
           AND ili.item_name IS NOT NULL
       ),
       intervals AS (
         SELECT
           buyer_tax_code,
           MAX(buyer_name)    AS buyer_name,
           norm_item,
           MAX(display_item)  AS display_item,
           AVG(CASE WHEN prev_date IS NOT NULL THEN invoice_date - prev_date END) AS avg_interval,
           AVG(quantity)      AS avg_qty,
           MAX(invoice_date)  AS last_date,
           COUNT(*)           AS data_points
         FROM ordered
         GROUP BY buyer_tax_code, norm_item
         HAVING COUNT(*) >= 3
       )
       SELECT
         buyer_tax_code,
         buyer_name,
         norm_item,
         display_item,
         avg_interval::text,
         avg_qty::text,
         last_date::text,
         data_points::text
       FROM intervals
       WHERE avg_interval IS NOT NULL`,
      [companyId],
    );

    if (rows.length === 0) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Upsert predictions
    for (const r of rows) {
      if (!r.buyer_tax_code?.trim()) {
        continue;
      }

      const avgInterval = Number(r.avg_interval);
      const dataPoints = Number(r.data_points);
      const lastDate = new Date(r.last_date);
      const predictedDate = new Date(lastDate);
      predictedDate.setDate(predictedDate.getDate() + Math.round(avgInterval));
      const daysUntil = Math.ceil((predictedDate.getTime() - today.getTime()) / 86_400_000);
      const confidence = dataPoints >= 6 ? 'high' : dataPoints >= 3 ? 'medium' : 'low';

      await pool.query(
        `INSERT INTO repurchase_predictions
           (company_id, buyer_tax_code, buyer_name, normalized_item_name, display_item_name,
            avg_interval_days, avg_quantity, last_purchase_date, predicted_next_date,
            days_until_predicted, confidence, data_points, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (company_id, buyer_tax_code, normalized_item_name) DO UPDATE SET
           buyer_name = EXCLUDED.buyer_name,
           avg_interval_days = EXCLUDED.avg_interval_days,
           avg_quantity = EXCLUDED.avg_quantity,
           last_purchase_date = EXCLUDED.last_purchase_date,
           predicted_next_date = EXCLUDED.predicted_next_date,
           days_until_predicted = EXCLUDED.days_until_predicted,
           confidence = EXCLUDED.confidence,
           data_points = EXCLUDED.data_points,
           updated_at = NOW()`,
        [
          companyId, r.buyer_tax_code, r.buyer_name, r.norm_item, r.display_item,
          avgInterval, Number(r.avg_qty), r.last_date,
          predictedDate.toISOString().slice(0, 10),
          daysUntil, confidence, dataPoints,
        ],
      );
    }
  }

  async getPredictions(
    companyId: string,
    daysRange: 7 | 14 | 30 = 7,
    page = 1,
    pageSize = 50,
  ): Promise<{ data: RepurchasePrediction[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const { rows } = await pool.query<RepurchasePrediction & { total: string }>(
      `SELECT *, COUNT(*) OVER() AS total
       FROM repurchase_predictions
       WHERE company_id = $1
         AND days_until_predicted <= $2
         AND confidence IN ('high','medium')
       ORDER BY days_until_predicted ASC, confidence DESC
       LIMIT $3 OFFSET $4`,
      [companyId, daysRange, pageSize, offset],
    );
    const total = rows.length > 0 ? Number((rows[0] as unknown as { total: string }).total) : 0;
    return { data: rows, total };
  }

  async getSilentCustomers(companyId: string): Promise<RepurchasePrediction[]> {
    const { rows } = await pool.query<RepurchasePrediction>(
      `SELECT * FROM repurchase_predictions
       WHERE company_id = $1
         AND days_until_predicted < -14
         AND is_actioned = false
       ORDER BY days_until_predicted ASC
       LIMIT 20`,
      [companyId],
    );
    return rows;
  }

  async markActioned(companyId: string, predictionId: string, note: string): Promise<void> {
    await pool.query(
      `UPDATE repurchase_predictions
       SET is_actioned = true, action_note = $3, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [predictionId, companyId, note],
    );
  }
}

export const burnRateService = new BurnRateService();
