import { pool } from '../db/pool';
import { env } from '../config/env';

export interface EsgCategoryEstimate {
  category_code: string;
  category_name: string;
  spend: number;
  tco2e: number;
  pct: number;
}

export interface EsgEstimate {
  company_id: string;
  calc_year: number;
  total_tco2e: number;
  by_category: EsgCategoryEstimate[];
  disclaimer: string;
}

const DISCLAIMER =
  'Ước tính sơ bộ theo phương pháp chi tiêu (Tier 3 GHG Protocol). ' +
  'Cần kiểm toán chuyên nghiệp cho báo cáo ESG chính thức.';

export class EsgEstimationService {
  async estimateForYear(companyId: string, year: number): Promise<EsgEstimate> {
    // Check cache first
    const cached = await pool.query<{ data: { by_category: EsgCategoryEstimate[]; total_tco2e: number } }>(
      `SELECT data FROM insights_cache WHERE company_id = $1 AND insight_type = 'esg' AND period_key = $2
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [companyId, String(year)],
    );

    if (cached.rows.length > 0 && cached.rows[0].data.total_tco2e > 0) {
      // Only use cache when it has a non-zero result
      // (avoids serving stale zero-cache computed before invoices were imported)
      const d = cached.rows[0].data;
      return {
        company_id: companyId,
        calc_year: year,
        total_tco2e: d.total_tco2e,
        by_category: d.by_category,
        disclaimer: DISCLAIMER,
      };
    }

    // Sum input invoice spend grouped by esg_category (from line items)
    const { rows } = await pool.query<{
      category_code: string;
      category_name: string;
      kg_co2_per_1000_vnd: string;
      total_spend: string;
    }>(
      `SELECT
         COALESCE(ili.esg_category, 'other') AS category_code,
         ef.category_name,
         ef.kg_co2_per_1000_vnd,
         SUM(ili.total)                       AS total_spend
       FROM invoice_line_items ili
       JOIN invoices i ON i.id = ili.invoice_id
       LEFT JOIN esg_emission_factors ef ON ef.category_code = COALESCE(ili.esg_category, 'other')
       WHERE i.company_id = $1
         AND i.direction = 'input'
         AND i.status != 'cancelled'
         AND i.deleted_at IS NULL
         AND EXTRACT(YEAR FROM i.invoice_date) = $2
       GROUP BY COALESCE(ili.esg_category, 'other'), ef.category_name, ef.kg_co2_per_1000_vnd`,
      [companyId, year],
    );

    // Fallback: if no line items, estimate from invoice totals using 'other' factor
    // Correct formula: tCO2e = (spend_VND / 1,000,000) × 0.20 kgCO2e / 1000
    if (rows.length === 0) {
      const totals = await pool.query<{ total_spend: string }>(
        `SELECT SUM(total_amount) AS total_spend FROM invoices
         WHERE company_id = $1 AND direction = 'input' AND status != 'cancelled'
           AND deleted_at IS NULL
           AND EXTRACT(YEAR FROM invoice_date) = $2`,
        [companyId, year],
      );
      const spend = Number(totals.rows[0]?.total_spend ?? 0);
      // 0.20 kgCO2e per million VND (Khác/default), then /1000 to convert kg→tonne
      // Use 3 decimal places to avoid rounding to 0 for small amounts
      const tco2e = (spend / 1_000_000) * 0.20 / 1000;
      const result: EsgEstimate = {
        company_id: companyId, calc_year: year,
        total_tco2e: Math.round(tco2e * 1000) / 1000,
        by_category: [{
          category_code: 'other', category_name: 'Khác (ước tính)',
          spend, tco2e: Math.round(tco2e * 1000) / 1000, pct: 100,
        }],
        disclaimer: DISCLAIMER,
      };
      await this.cacheResult(companyId, year, result);
      return result;
    }

    const totalSpend = rows.reduce((s, r) => s + Number(r.total_spend), 0);
    const byCategory: EsgCategoryEstimate[] = rows.map((r) => {
      const spend = Number(r.total_spend);
      // Default 0.0002 = 0.20 kgCO2e per million VND (Khác) converted to per 1000 VND
      const factor = Number(r.kg_co2_per_1000_vnd ?? 0.0002);
      // factor is kgCO2e/1000VND → multiply by (spend/1000) → kgCO2e → /1000 → tCO2e
      const tco2e = (spend / 1000) * factor / 1000;
      return {
        category_code: r.category_code,
        category_name: r.category_name ?? r.category_code,
        spend,
        tco2e: Math.round(tco2e * 1000) / 1000,
        pct: totalSpend > 0 ? Math.round((spend / totalSpend) * 1000) / 10 : 0,
      };
    });

    const totalTco2e = byCategory.reduce((s, c) => s + c.tco2e, 0);
    byCategory.sort((a, b) => b.tco2e - a.tco2e);

    const result: EsgEstimate = {
      company_id: companyId, calc_year: year,
      total_tco2e: Math.round(totalTco2e * 1000) / 1000,
      by_category: byCategory,
      disclaimer: DISCLAIMER,
    };
    await this.cacheResult(companyId, year, result);
    return result;
  }

  private async cacheResult(companyId: string, year: number, result: EsgEstimate): Promise<void> {
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    await pool.query(
      `INSERT INTO insights_cache (company_id, insight_type, period_key, data, expires_at)
       VALUES ($1, 'esg', $2, $3::jsonb, $4)
       ON CONFLICT (company_id, insight_type, period_key) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [companyId, String(year), JSON.stringify({ total_tco2e: result.total_tco2e, by_category: result.by_category }), expires],
    );
  }

  async getSeasonalInsights(companyId: string): Promise<{ raw: unknown; ai_analysis: string | null }> {
    // Check cache
    const key = new Date().getFullYear().toString();
    const cached = await pool.query<{ data: unknown; ai_analysis: string | null }>(
      `SELECT data, ai_analysis FROM insights_cache
       WHERE company_id = $1 AND insight_type = 'seasonal' AND period_key = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [companyId, key],
    );
    if (cached.rows.length > 0) {
      return { raw: cached.rows[0].data, ai_analysis: cached.rows[0].ai_analysis };
    }

    // Build 24-month revenue/spend aggregation
    const { rows } = await pool.query<{
      period_month: number; period_year: number;
      output_total: string; input_total: string; invoice_count: string;
    }>(
      `SELECT
         EXTRACT(MONTH FROM invoice_date)::int AS period_month,
         EXTRACT(YEAR  FROM invoice_date)::int AS period_year,
         SUM(CASE WHEN direction = 'output' THEN total_amount ELSE 0 END) AS output_total,
         SUM(CASE WHEN direction = 'input'  THEN total_amount ELSE 0 END) AS input_total,
         COUNT(*) AS invoice_count
       FROM invoices
       WHERE company_id = $1 AND status != 'cancelled'
         AND invoice_date >= (CURRENT_DATE - INTERVAL '24 months')
       GROUP BY period_month, period_year
       ORDER BY period_year, period_month`,
      [companyId],
    );

    const raw = rows.map((r) => ({
      month: r.period_month, year: r.period_year,
      revenue: Number(r.output_total), spend: Number(r.input_total),
      invoices: Number(r.invoice_count),
    }));

    let ai_analysis: string | null = null;
    if (rows.length >= 6) {
      try {
        ai_analysis = await this.callGeminiSeasonal(raw);
      } catch { /* silent — Gemini is optional */ }
    }

    // Cache for 30 days
    const expires = new Date();
    expires.setDate(expires.getDate() + 30);
    await pool.query(
      `INSERT INTO insights_cache (company_id, insight_type, period_key, data, ai_analysis, expires_at)
       VALUES ($1, 'seasonal', $2, $3::jsonb, $4, $5)
       ON CONFLICT (company_id, insight_type, period_key) DO UPDATE SET
         data = EXCLUDED.data, ai_analysis = EXCLUDED.ai_analysis, expires_at = EXCLUDED.expires_at`,
      [companyId, key, JSON.stringify(raw), ai_analysis, expires],
    );

    return { raw, ai_analysis };
  }

  private async callGeminiSeasonal(data: unknown[]): Promise<string> {
    const apiKey = env.GEMINI_API_KEY;
    const model = env.GEMINI_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const body = {
      contents: [{
        parts: [{
          text: `Bạn là chuyên gia phân tích tài chính cho doanh nghiệp Việt Nam.
Phân tích dữ liệu doanh thu/chi phí 24 tháng sau và cung cấp nhận xét bằng tiếng Việt:
${JSON.stringify(data)}

Hãy nêu ngắn gọn:
1. Top 3 tháng doanh thu cao nhất và lý do (nếu có xu hướng)
2. Top 3 tháng doanh thu thấp nhất và rủi ro
3. Khuyến nghị thời điểm nhập hàng hợp lý
4. Cảnh báo tháng dòng tiền nguy hiểm (chi nhiều + thu ít)
Trả lời trong 200 từ, súc tích cho chủ doanh nghiệp.`,
        }],
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
    };
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Gemini error');
    const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
}

export const esgService = new EsgEstimationService();
