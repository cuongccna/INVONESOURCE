import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { pool } from '../db/pool';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

export interface Anomaly {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  type: string;
  description: string;
  amount: number;
  sellerName: string;
}

export interface AnomalyWithAI extends Anomaly {
  risk: string;
  explanation: string;
  action: string;
}

export interface AnomalyReport {
  period: { month: number; year: number };
  totalAnomalies: number;
  anomalies: AnomalyWithAI[];
  generatedAt: Date;
}

/**
 * GeminiAnomalyService — detects invoice anomalies using rule-based methods,
 * then enhances top findings with Gemini AI explanations.
 */
export class GeminiAnomalyService {
  private model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL });

  async analyzeAnomalies(
    companyId: string,
    period: { month: number; year: number }
  ): Promise<AnomalyReport> {
    const { month, year } = period;

    // ============================================================
    // Step 1: Rule-based detection (fast, no AI cost)
    // ============================================================
    const anomalies: Anomaly[] = [];

    // 1a. Invoices with amount > (mean + 3*stdev) for that supplier
    const { rows: outliers } = await pool.query<{
      id: string;
      invoice_number: string;
      total_amount: string;
      seller_name: string;
      seller_tax_code: string;
    }>(
      `WITH supplier_stats AS (
         SELECT seller_tax_code,
                AVG(total_amount) as avg_amount,
                STDDEV(total_amount) as std_amount
         FROM invoices
         WHERE company_id = $1
           AND direction = 'input'
           AND status = 'valid'
           AND deleted_at IS NULL
           AND EXTRACT(MONTH FROM invoice_date) = $2
           AND EXTRACT(YEAR FROM invoice_date) = $3
         GROUP BY seller_tax_code
         HAVING COUNT(*) >= 3
       )
       SELECT i.id, i.invoice_number, i.total_amount, i.seller_name, i.seller_tax_code
       FROM invoices i
       JOIN supplier_stats s ON i.seller_tax_code = s.seller_tax_code
       WHERE i.company_id = $1
         AND i.direction = 'input'
         AND i.status = 'valid'
         AND i.deleted_at IS NULL
         AND EXTRACT(MONTH FROM i.invoice_date) = $2
         AND EXTRACT(YEAR FROM i.invoice_date) = $3
         AND i.total_amount > (s.avg_amount + 3 * COALESCE(s.std_amount, 0))
       LIMIT 10`,
      [companyId, month, year]
    );

    for (const row of outliers) {
      anomalies.push({
        id: `outlier-${row.id}`,
        invoiceId: row.id,
        invoiceNumber: row.invoice_number,
        type: 'AMOUNT_OUTLIER',
        description: `Chi phí bất thường: ${formatMoney(parseFloat(row.total_amount))}đ`,
        amount: parseFloat(row.total_amount),
        sellerName: row.seller_name,
      });
    }

    // 1b. GDT not validated
    const { rows: unvalidated } = await pool.query<{
      id: string; invoice_number: string; total_amount: string; seller_name: string;
    }>(
      `SELECT id, invoice_number, total_amount, seller_name
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status = 'valid'
         AND gdt_validated = false
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       LIMIT 20`,
      [companyId, month, year]
    );

    for (const row of unvalidated) {
      anomalies.push({
        id: `unvalidated-${row.id}`,
        invoiceId: row.id,
        invoiceNumber: row.invoice_number,
        type: 'GDT_NOT_VALIDATED',
        description: 'Chưa xác thực GDT — không được khấu trừ VAT',
        amount: parseFloat(row.total_amount),
        sellerName: row.seller_name,
      });
    }

    // 1c. Cash payment > 20M (not deductible)
    const { rows: cashOverLimit } = await pool.query<{
      id: string; invoice_number: string; total_amount: string; seller_name: string;
    }>(
      `SELECT id, invoice_number, total_amount, seller_name
       FROM invoices
       WHERE company_id = $1
         AND direction = 'input'
         AND status = 'valid'
         AND payment_method = 'cash'
         AND total_amount > 20000000
         AND deleted_at IS NULL
         AND EXTRACT(MONTH FROM invoice_date) = $2
         AND EXTRACT(YEAR FROM invoice_date) = $3
       LIMIT 10`,
      [companyId, month, year]
    );

    for (const row of cashOverLimit) {
      anomalies.push({
        id: `cash-${row.id}`,
        invoiceId: row.id,
        invoiceNumber: row.invoice_number,
        type: 'CASH_OVER_LIMIT',
        description: `Thanh toán tiền mặt > 20 triệu (${formatMoney(parseFloat(row.total_amount))}đ) — không được khấu trừ`,
        amount: parseFloat(row.total_amount),
        sellerName: row.seller_name,
      });
    }

    if (anomalies.length === 0) {
      return {
        period,
        totalAnomalies: 0,
        anomalies: [],
        generatedAt: new Date(),
      };
    }

    // ============================================================
    // Step 2: AI enhancement for top 10 anomalies
    // ============================================================
    const top10 = anomalies.slice(0, 10);
    const enhanced = await this.enhanceWithAI(top10);

    return {
      period,
      totalAnomalies: anomalies.length,
      anomalies: enhanced,
      generatedAt: new Date(),
    };
  }

  private async enhanceWithAI(anomalies: Anomaly[]): Promise<AnomalyWithAI[]> {
    const summary = anomalies.map((a) => ({
      id: a.id,
      type: a.type,
      description: a.description,
      amount: a.amount,
      sellerName: a.sellerName,
    }));

    const prompt = `You are a Vietnamese tax accountant. Analyze these invoice anomalies.
Explain each risk in Vietnamese and suggest action.
Return JSON array only (no markdown):
[{"id": "...", "risk": "high|medium|low", "explanation": "...", "action": "..."}]

Anomalies:
${JSON.stringify(summary, null, 2)}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const aiResults = JSON.parse(jsonText) as Array<{
        id: string; risk: string; explanation: string; action: string;
      }>;

      const aiMap = new Map(aiResults.map((r) => [r.id, r]));

      return anomalies.map((a): AnomalyWithAI => {
        const ai = aiMap.get(a.id);
        return {
          ...a,
          risk: ai?.risk ?? 'medium',
          explanation: ai?.explanation ?? a.description,
          action: ai?.action ?? 'Kiểm tra lại hóa đơn',
        };
      });
    } catch (err) {
      console.warn('[GeminiAnomaly] AI enhancement failed — returning rule-based only:', err);
      return anomalies.map((a): AnomalyWithAI => ({
        ...a,
        risk: 'medium',
        explanation: a.description,
        action: 'Kiểm tra lại hóa đơn',
      }));
    }
  }
}

function formatMoney(n: number): string {
  return n.toLocaleString('vi-VN');
}

export const geminiAnomalyService = new GeminiAnomalyService();
