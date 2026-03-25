import { pool } from '../db/pool';
import { env } from '../config/env';

export interface PriceAnomaly {
  id: string;
  anomaly_type: string;
  severity: 'critical' | 'warning' | 'info';
  seller_tax_code: string | null;
  seller_name: string | null;
  item_name: string | null;
  unit_price: number;
  baseline_price: number;
  pct_deviation: number;
  ai_explanation: string | null;
  ai_action: string | null;
  is_acknowledged: boolean;
  invoice_id: string | null;
  created_at: string;
}

export interface AnomalySummary {
  critical: number;
  warning: number;
  info: number;
  total_overcharge_estimate: number;
}

export class PriceAnomalyDetector {
  async detectAnomalies(companyId: string): Promise<PriceAnomaly[]> {
    // Get company thresholds from settings
    const settingsRes = await pool.query<{
      audit_price_spike_threshold: string;
      audit_qty_spike_multiplier: string;
      audit_new_vendor_threshold: string;
      audit_round_num_deviation: string;
    }>(
      `SELECT audit_price_spike_threshold, audit_qty_spike_multiplier,
              audit_new_vendor_threshold, audit_round_num_deviation
       FROM company_settings WHERE company_id = $1`,
      [companyId],
    );
    const settings = settingsRes.rows[0] ?? {};
    const spikeThresh = Number(settings.audit_price_spike_threshold ?? 20);
    const qtyMultiplier = Number(settings.audit_qty_spike_multiplier ?? 2.5);
    const newVendorThresh = Number(settings.audit_new_vendor_threshold ?? 50_000_000);
    const roundNumDev = Number(settings.audit_round_num_deviation ?? 10);

    // Statistical anomaly detection: price spikes vs 90-day baseline
    const { rows: statRows } = await pool.query<{
      invoice_id: string;
      line_item_id: string;
      seller_tax_code: string;
      seller_name: string;
      item_name: string;
      unit_price: string;
      baseline_avg_price: string | null;
      pct_deviation: string | null;
      anomaly_type: string;
    }>(
      `WITH price_history AS (
         SELECT
           ili.id             AS line_item_id,
           i.id               AS invoice_id,
           i.seller_tax_code,
           i.seller_name,
           COALESCE(ili.normalized_item_name, ili.item_name) AS item_name,
           ili.unit_price,
           i.invoice_date,
           AVG(ili.unit_price) OVER (
             PARTITION BY i.company_id, i.seller_tax_code,
               COALESCE(ili.normalized_item_name, ili.item_name)
             ORDER BY i.invoice_date
             ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING
           ) AS baseline_avg_price,
           STDDEV(ili.unit_price) OVER (
             PARTITION BY i.company_id, i.seller_tax_code,
               COALESCE(ili.normalized_item_name, ili.item_name)
             ORDER BY i.invoice_date
             ROWS BETWEEN 90 PRECEDING AND 1 PRECEDING
           ) AS price_stddev,
           COUNT(*) OVER (
             PARTITION BY i.company_id, i.seller_tax_code,
               COALESCE(ili.normalized_item_name, ili.item_name)
           ) AS data_points
         FROM invoice_line_items ili
         JOIN invoices i ON ili.invoice_id = i.id
         WHERE i.company_id = $1
           AND i.direction = 'input'
           AND i.status != 'cancelled'
           AND ili.unit_price > 0
           AND i.invoice_date >= CURRENT_DATE - INTERVAL '90 days'
       )
       SELECT
         invoice_id, line_item_id, seller_tax_code, seller_name, item_name, unit_price::text,
         baseline_avg_price::text,
         CASE
           WHEN baseline_avg_price IS NULL OR baseline_avg_price = 0 THEN NULL
           ELSE ROUND((unit_price - baseline_avg_price) / baseline_avg_price * 100, 2)
         END::text AS pct_deviation,
         CASE
           WHEN data_points < 3 THEN 'insufficient_data'
           WHEN unit_price > baseline_avg_price + 2 * COALESCE(price_stddev, baseline_avg_price * 0.1)
             THEN 'price_spike'
           WHEN unit_price < baseline_avg_price - 2 * COALESCE(price_stddev, baseline_avg_price * 0.1)
             THEN 'price_drop'
           ELSE 'normal'
         END AS anomaly_type
       FROM price_history
       WHERE data_points >= 3`,
      [companyId],
    );

    const anomalies: Omit<PriceAnomaly, 'id' | 'created_at'>[] = [];

    for (const r of statRows) {
      if (r.anomaly_type === 'normal' || r.anomaly_type === 'insufficient_data') continue;
      const pct = Math.abs(Number(r.pct_deviation ?? 0));
      if (pct < spikeThresh) continue;
      const severity: 'critical' | 'warning' | 'info' = pct >= 30 ? 'critical' : pct >= 10 ? 'warning' : 'info';
      anomalies.push({
        anomaly_type: r.anomaly_type,
        severity,
        seller_tax_code: r.seller_tax_code,
        seller_name: r.seller_name,
        item_name: r.item_name,
        unit_price: Number(r.unit_price),
        baseline_price: Number(r.baseline_avg_price ?? 0),
        pct_deviation: Number(r.pct_deviation ?? 0),
        ai_explanation: null,
        ai_action: null,
        is_acknowledged: false,
        invoice_id: r.invoice_id,
      });
    }

    // Rule: new vendor with high-value invoice
    const { rows: newVendorRows } = await pool.query<{
      invoice_id: string; seller_tax_code: string; seller_name: string; total_amount: string;
    }>(
      `SELECT i.id AS invoice_id, i.seller_tax_code, i.seller_name, i.total_amount
       FROM invoices i
       WHERE i.company_id = $1
         AND i.direction = 'input'
         AND i.status != 'cancelled'
         AND i.total_amount >= $2
         AND i.invoice_date >= CURRENT_DATE - INTERVAL '30 days'
         AND i.seller_tax_code NOT IN (
           SELECT DISTINCT seller_tax_code FROM invoices
           WHERE company_id = $1 AND invoice_date < CURRENT_DATE - INTERVAL '30 days'
             AND direction = 'input' AND seller_tax_code IS NOT NULL
         )`,
      [companyId, newVendorThresh],
    );
    for (const r of newVendorRows) {
      anomalies.push({
        anomaly_type: 'new_vendor',
        severity: Number(r.total_amount) >= newVendorThresh * 3 ? 'critical' : 'warning',
        seller_tax_code: r.seller_tax_code,
        seller_name: r.seller_name,
        item_name: null,
        unit_price: Number(r.total_amount),
        baseline_price: 0,
        pct_deviation: 0,
        ai_explanation: null,
        ai_action: null,
        is_acknowledged: false,
        invoice_id: r.invoice_id,
      });
    }

    // Rule: quantity spike
    const { rows: qtyRows } = await pool.query<{
      invoice_id: string; seller_name: string; item_name: string;
      quantity: string; avg_quantity: string; pct_dev: string;
    }>(
      `WITH qty_stats AS (
         SELECT
           ili.invoice_id,
           i.seller_name,
           COALESCE(ili.normalized_item_name, ili.item_name) AS item_name,
           ili.quantity,
           AVG(ili.quantity) OVER (
             PARTITION BY i.company_id, COALESCE(ili.normalized_item_name, ili.item_name)
             ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
           ) AS avg_quantity
         FROM invoice_line_items ili
         JOIN invoices i ON ili.invoice_id = i.id
         WHERE i.company_id = $1 AND i.direction = 'input' AND i.status != 'cancelled'
           AND i.invoice_date >= CURRENT_DATE - INTERVAL '30 days'
       )
       SELECT invoice_id, seller_name, item_name, quantity::text, avg_quantity::text,
         ROUND((quantity / NULLIF(avg_quantity,0) - 1) * 100, 1)::text AS pct_dev
       FROM qty_stats
       WHERE avg_quantity IS NOT NULL AND quantity > avg_quantity * $2`,
      [companyId, qtyMultiplier],
    );
    for (const r of qtyRows) {
      anomalies.push({
        anomaly_type: 'qty_spike',
        severity: 'warning',
        seller_tax_code: null,
        seller_name: r.seller_name,
        item_name: r.item_name,
        unit_price: 0,
        baseline_price: 0,
        pct_deviation: Number(r.pct_dev),
        ai_explanation: null,
        ai_action: null,
        is_acknowledged: false,
        invoice_id: r.invoice_id,
      });
    }

    if (anomalies.length === 0) return [];

    // Persist new anomalies (skip duplicates by invoice_id + anomaly_type)
    const saved: PriceAnomaly[] = [];
    for (const a of anomalies) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM price_anomalies WHERE company_id = $1 AND invoice_id = $2 AND anomaly_type = $3
           AND created_at > NOW() - INTERVAL '7 days' LIMIT 1`,
        [companyId, a.invoice_id, a.anomaly_type],
      );
      if (existing.length > 0) continue;

      const { rows: ins } = await pool.query<PriceAnomaly>(
        `INSERT INTO price_anomalies
           (company_id, invoice_id, anomaly_type, severity, seller_tax_code, seller_name,
            item_name, unit_price, baseline_price, pct_deviation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [companyId, a.invoice_id, a.anomaly_type, a.severity,
         a.seller_tax_code, a.seller_name, a.item_name,
         a.unit_price, a.baseline_price, a.pct_deviation],
      );
      if (ins[0]) saved.push(ins[0]);
    }

    // AI explanations for top anomalies (max 10)
    const toExplain = saved.filter((a) => !a.ai_explanation).slice(0, 10);
    if (toExplain.length > 0) {
      try {
        const explained = await this.explainWithGemini(toExplain);
        for (const e of explained) {
          await pool.query(
            `UPDATE price_anomalies SET ai_explanation = $2, ai_action = $3 WHERE id = $1`,
            [e.id, e.explanation, e.action],
          );
          const found = saved.find((a) => a.id === e.id);
          if (found) { found.ai_explanation = e.explanation; found.ai_action = e.action; }
        }
      } catch { /* Gemini optional */ }
    }

    return saved;
  }

  async getAnomalies(
    companyId: string,
    page = 1,
    pageSize = 50,
    severity?: string,
    unacknowledgedOnly = false,
  ): Promise<{ data: PriceAnomaly[]; total: number; summary: AnomalySummary }> {
    const conditions = ['company_id = $1', "created_at > NOW() - INTERVAL '90 days'"];
    const params: unknown[] = [companyId];
    if (severity) { params.push(severity); conditions.push(`severity = $${params.length}`); }
    if (unacknowledgedOnly) conditions.push('is_acknowledged = false');

    const where = conditions.join(' AND ');
    const { rows } = await pool.query<PriceAnomaly & { total: string }>(
      `SELECT *, COUNT(*) OVER() AS total
       FROM price_anomalies
       WHERE ${where}
       ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
                ABS(pct_deviation) DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    );

    const summaryRes = await pool.query<{ severity: string; cnt: string; overcharge: string }>(
      `SELECT severity,
              COUNT(*)::text AS cnt,
              COALESCE(SUM((unit_price - baseline_price) * 1), 0)::text AS overcharge
       FROM price_anomalies
       WHERE company_id = $1 AND is_acknowledged = false
         AND created_at > NOW() - INTERVAL '90 days'
       GROUP BY severity`,
      [companyId],
    );

    const summary: AnomalySummary = { critical: 0, warning: 0, info: 0, total_overcharge_estimate: 0 };
    for (const s of summaryRes.rows) {
      if (s.severity === 'critical') { summary.critical = Number(s.cnt); summary.total_overcharge_estimate += Number(s.overcharge); }
      else if (s.severity === 'warning') { summary.warning = Number(s.cnt); }
      else { summary.info = Number(s.cnt); }
    }

    const total = rows.length > 0 ? Number((rows[0] as unknown as { total: string }).total) : 0;
    return { data: rows, total, summary };
  }

  async acknowledge(companyId: string, anomalyId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE price_anomalies SET is_acknowledged = true, acknowledged_by = $3, acknowledged_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [anomalyId, companyId, userId],
    );
  }

  private async explainWithGemini(
    anomalies: PriceAnomaly[],
  ): Promise<Array<{ id: string; explanation: string; action: string }>> {
    const apiKey = env.GEMINI_API_KEY;
    const model = env.GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const input = anomalies.map((a) => ({
      id: a.id, item_name: a.item_name, seller_name: a.seller_name,
      unit_price: a.unit_price, baseline_price: a.baseline_price,
      pct_deviation: a.pct_deviation, anomaly_type: a.anomaly_type,
    }));
    const body = {
      contents: [{
        parts: [{
          text: `Bạn là kiểm toán viên nội bộ AI cho doanh nghiệp Việt Nam.
Phân tích các bất thường giá hóa đơn mua hàng sau và trả lời JSON array.
Với mỗi bất thường: giải thích rủi ro ngắn gọn (1-2 câu tiếng Việt) và đề xuất hành động (1 câu).
Format: [{"id":"...","explanation":"...","action":"..."}]
Dữ liệu: ${JSON.stringify(input)}`,
        }],
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
    };

    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Gemini error');
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) as Array<{ id: string; explanation: string; action: string }> : [];
  }
}

export const priceAnomalyDetector = new PriceAnomalyDetector();
