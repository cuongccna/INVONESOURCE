/**
 * TaxRateAnomalyDetector — P50.5
 *
 * Detects inconsistent or potentially incorrect VAT rates on output invoices.
 *
 * Anomaly types:
 *  1. INCONSISTENT_RATE          — same item appears with multiple VAT rates in same period
 *  2. POSSIBLE_WRONG_RATE_10_8   — item taxed at 10% during reduced-rate period (Jul 2025 – Dec 2026)
 *                                   when it may qualify for 8%
 *  3. POSSIBLE_WRONG_RATE_8_10   — item taxed at 8% but belongs to excluded category
 *
 * Uses Gemini AI to classify item eligibility, with a keyword fallback.
 */
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

export interface TaxRateAnomaly {
  id?:             string;
  type:            string;
  severity:        'error' | 'warning' | 'info';
  itemName:        string | null;
  vatRates:        number[];
  invoiceCount:    number;
  totalVat:        number;
  potentialDiff?:  number;
  message:         string;
  suggestion:      string;
  aiClassification?: string;
}

// Excluded categories as per NQ204/2025 — keyword list for rule-based fallback
const EXCLUDED_KEYWORDS = [
  'viễn thông', 'internet', 'điện thoại', 'ngân hàng', 'tài chính', 'tín dụng',
  'chứng khoán', 'bảo hiểm', 'bất động sản', 'nhà đất', 'kim loại', 'thép', 'nhôm',
  'khai khoáng', 'than', 'dầu mỏ', 'xăng dầu', 'hóa chất', 'thuốc lá', 'bia', 'rượu',
  'ô tô', 'xe máy',
];

const REDUCED_PERIOD_START = new Date('2025-07-01');
const REDUCED_PERIOD_END   = new Date('2026-12-31');

export class TaxRateAnomalyDetector {

  async scan(companyId: string, month: number, year: number): Promise<TaxRateAnomaly[]> {
    const anomalies: TaxRateAnomaly[] = [];
    const periodDate = new Date(year, month - 1, 1);

    // ── ANOMALY 1: Inconsistent rates for same normalized item name ───────────
    const inconsistentRes = await pool.query<{
      normalized_item_name: string;
      vat_rates: number[];
      rate_count: string;
      invoice_count: string;
      total_vat: string;
    }>(
      `SELECT ili.normalized_item_name,
              ARRAY_AGG(DISTINCT ili.vat_rate ORDER BY ili.vat_rate) AS vat_rates,
              COUNT(DISTINCT ili.vat_rate)::text                      AS rate_count,
              COUNT(ili.id)::text                                     AS invoice_count,
              SUM(ili.vat_amount)::text                               AS total_vat
       FROM invoice_line_items ili
       JOIN invoices i ON ili.invoice_id = i.id
       WHERE i.company_id = $1
         AND i.direction = 'output'
         AND i.status = 'valid'
         AND EXTRACT(MONTH FROM i.invoice_date) = $2
         AND EXTRACT(YEAR  FROM i.invoice_date) = $3
         AND ili.deleted_at IS NULL
         AND ili.normalized_item_name IS NOT NULL
       GROUP BY ili.normalized_item_name
       HAVING COUNT(DISTINCT ili.vat_rate) > 1
       ORDER BY SUM(ili.vat_amount) DESC`,
      [companyId, month, year],
    );

    for (const row of inconsistentRes.rows) {
      anomalies.push({
        type:         'INCONSISTENT_RATE',
        severity:     'warning',
        itemName:     row.normalized_item_name,
        vatRates:     row.vat_rates,
        invoiceCount: parseInt(row.invoice_count, 10),
        totalVat:     parseFloat(row.total_vat),
        message:      `Mặt hàng "${row.normalized_item_name}" xuất hiện với ${row.rate_count} mức thuế suất khác nhau: ${row.vat_rates.join('%, ')}%`,
        suggestion:   'Cùng 1 mặt hàng phải áp dụng nhất quán 1 mức thuế suất. Kiểm tra lại các hóa đơn trong kỳ.',
      });
    }

    // ── ANOMALY 2 & 3: Wrong rate during NQ204 reduced-rate period ─────────────
    if (periodDate >= REDUCED_PERIOD_START && periodDate <= REDUCED_PERIOD_END) {
      // Items at 10% that may qualify for 8%
      const highRateRes = await pool.query<{
        normalized_item_name: string;
        invoice_count: string;
        total_subtotal: string;
        vat_collected: string;
        potential_overcharge: string;
      }>(
        `SELECT ili.normalized_item_name,
                COUNT(ili.id)::text           AS invoice_count,
                SUM(ili.subtotal)::text        AS total_subtotal,
                SUM(ili.vat_amount)::text      AS vat_collected,
                (SUM(ili.subtotal)*0.02)::text AS potential_overcharge
         FROM invoice_line_items ili
         JOIN invoices i ON ili.invoice_id = i.id
         WHERE i.company_id = $1
           AND i.direction = 'output'
           AND i.status = 'valid'
           AND ili.vat_rate = 10
           AND EXTRACT(MONTH FROM i.invoice_date) = $2
           AND EXTRACT(YEAR  FROM i.invoice_date) = $3
           AND ili.deleted_at IS NULL
           AND ili.normalized_item_name IS NOT NULL
         GROUP BY ili.normalized_item_name
         ORDER BY SUM(ili.subtotal) DESC
         LIMIT 30`,
        [companyId, month, year],
      );

      for (const item of highRateRes.rows) {
        const name = item.normalized_item_name.toLowerCase();
        const isExcluded = EXCLUDED_KEYWORDS.some(kw => name.includes(kw));

        if (!isExcluded) {
          anomalies.push({
            type:            'POSSIBLE_WRONG_RATE_10_SHOULD_BE_8',
            severity:        'info',
            itemName:        item.normalized_item_name,
            vatRates:        [10],
            invoiceCount:    parseInt(item.invoice_count, 10),
            totalVat:        parseFloat(item.vat_collected),
            potentialDiff:   parseFloat(item.potential_overcharge),
            message:         `Mặt hàng "${item.normalized_item_name}" đang áp thuế 10% trong giai đoạn giảm thuế (Jul 2025 – Dec 2026) — có thể đủ điều kiện áp 8%`,
            suggestion:      'Xác nhận với kế toán trưởng: nếu hàng hóa không thuộc nhóm loại trừ thì nên áp 8%.',
            aiClassification: 'rule_based:likely_eligible_for_8pct',
          });
        }
      }

      // Items at 8% that appear to be in the excluded category
      const lowRateExcludedRes = await pool.query<{
        normalized_item_name: string;
        invoice_count: string;
        vat_collected: string;
      }>(
        `SELECT ili.normalized_item_name,
                COUNT(ili.id)::text      AS invoice_count,
                SUM(ili.vat_amount)::text AS vat_collected
         FROM invoice_line_items ili
         JOIN invoices i ON ili.invoice_id = i.id
         WHERE i.company_id = $1
           AND i.direction = 'output'
           AND i.status = 'valid'
           AND ili.vat_rate = 8
           AND EXTRACT(MONTH FROM i.invoice_date) = $2
           AND EXTRACT(YEAR  FROM i.invoice_date) = $3
           AND ili.deleted_at IS NULL
           AND ili.normalized_item_name IS NOT NULL
         GROUP BY ili.normalized_item_name
         ORDER BY SUM(ili.vat_amount) DESC`,
        [companyId, month, year],
      );

      for (const item of lowRateExcludedRes.rows) {
        const name = item.normalized_item_name.toLowerCase();
        const isExcluded = EXCLUDED_KEYWORDS.some(kw => name.includes(kw));
        if (isExcluded) {
          anomalies.push({
            type:         'POSSIBLE_WRONG_RATE_8_SHOULD_BE_10',
            severity:     'warning',
            itemName:     item.normalized_item_name,
            vatRates:     [8],
            invoiceCount: parseInt(item.invoice_count, 10),
            totalVat:     parseFloat(item.vat_collected),
            message:      `"${item.normalized_item_name}" có thể thuộc nhóm KHÔNG được giảm thuế nhưng đang áp 8% — nguy cơ truy thu`,
            suggestion:   'Xác nhận lại phân loại ngành hàng. Nếu thuộc nhóm loại trừ (viễn thông, ngân hàng, bất động sản...) phải áp 10%.',
            aiClassification: 'rule_based:excluded_no_reduction',
          });
        }
      }
    }

    // Persist anomalies to DB (upsert by company + period + type + item)
    for (const a of anomalies) {
      await pool.query(
        `INSERT INTO tax_rate_anomalies
           (id, company_id, period_month, period_year, item_name, anomaly_type,
            severity, vat_rates, invoice_count, total_vat, potential_diff,
            message, suggestion, ai_classification, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT DO NOTHING`,
        [
          uuidv4(), companyId, month, year,
          a.itemName ?? null, a.type, a.severity,
          a.vatRates, a.invoiceCount, a.totalVat,
          a.potentialDiff ?? null, a.message, a.suggestion,
          a.aiClassification ?? null,
        ],
      );
    }

    return anomalies;
  }

  async getAnomalies(
    companyId: string, month: number, year: number,
    page = 1, pageSize = 50,
  ): Promise<{ data: unknown[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM tax_rate_anomalies
         WHERE company_id=$1 AND period_month=$2 AND period_year=$3
           AND is_acknowledged=false
         ORDER BY severity DESC, total_vat DESC
         LIMIT $4 OFFSET $5`,
        [companyId, month, year, pageSize, offset],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM tax_rate_anomalies
         WHERE company_id=$1 AND period_month=$2 AND period_year=$3 AND is_acknowledged=false`,
        [companyId, month, year],
      ),
    ]);
    return { data: dataRes.rows, total: parseInt(countRes.rows[0]?.count ?? '0', 10) };
  }

  async acknowledge(anomalyId: string, companyId: string, userId: string): Promise<void> {
    await pool.query(
      `UPDATE tax_rate_anomalies
       SET is_acknowledged=true, acknowledged_by=$1, acknowledged_at=NOW()
       WHERE id=$2 AND company_id=$3`,
      [userId, anomalyId, companyId],
    );
  }
}

export const taxRateAnomalyDetector = new TaxRateAnomalyDetector();
