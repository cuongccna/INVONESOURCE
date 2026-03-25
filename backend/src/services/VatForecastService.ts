import { pool } from '../db/pool';

export interface VatForecast {
  forecast_output_vat: number;
  forecast_input_vat: number;
  forecast_payable: number;
  carry_forward: number;
  net_forecast: number;
  periods_used: number;
  confidence_note: string;
}

export class VatForecastService {
  async forecastNextPeriod(companyId: string): Promise<VatForecast> {
    const now = new Date();
    // Build last 3 period (month, year) pairs going backwards from current month
    const periods: [number, number][] = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      periods.push([d.getMonth() + 1, d.getFullYear()]);
    }

    // Fetch ct40a (output VAT), deductible input VAT, and ct43 (carry-forward) for each period
    const { rows } = await pool.query<{
      period_month: number;
      period_year: number;
      ct40a: string;
      deductible_input: string;
      ct43: string;
    }>(
      `SELECT
         period_month,
         period_year,
         COALESCE(output_vat, 0)::numeric                               AS ct40a,
         COALESCE(input_vat, 0)::numeric                                AS deductible_input,
         COALESCE(GREATEST(0, input_vat - output_vat), 0)::numeric      AS ct43
       FROM vat_reconciliations
       WHERE company_id = $1
         AND (period_month, period_year) IN (
           ($2,$3), ($4,$5), ($6,$7)
         )
       ORDER BY period_year DESC, period_month DESC`,
      [
        companyId,
        periods[0][0], periods[0][1],
        periods[1][0], periods[1][1],
        periods[2][0], periods[2][1],
      ],
    );

    const weights = [0.5, 0.3, 0.2];
    // Map rows to matched period slots (rows may be < 3 if data is missing)
    const periodMap = new Map<string, { ct40a: number; deductible_input: number; ct43: number }>();
    for (const r of rows) {
      periodMap.set(`${r.period_month}-${r.period_year}`, {
        ct40a: Number(r.ct40a),
        deductible_input: Number(r.deductible_input),
        ct43: Number(r.ct43),
      });
    }

    let weightedOutput = 0;
    let weightedInput = 0;
    let totalWeight = 0;
    let periodsUsed = 0;
    let carryForward = 0;

    for (let i = 0; i < 3; i++) {
      const key = `${periods[i][0]}-${periods[i][1]}`;
      const p = periodMap.get(key);
      if (p) {
        weightedOutput += p.ct40a * weights[i];
        weightedInput += p.deductible_input * weights[i];
        totalWeight += weights[i];
        periodsUsed++;
        // carry-forward taken from most recent available
        if (i === 0) carryForward = p.ct43;
      }
    }

    if (periodsUsed === 0) {
      return {
        forecast_output_vat: 0,
        forecast_input_vat: 0,
        forecast_payable: 0,
        carry_forward: 0,
        net_forecast: 0,
        periods_used: 0,
        confidence_note: 'Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ.',
      };
    }

    // Normalise if fewer than 3 periods (avoid bias)
    const forecastOutput = totalWeight > 0 ? weightedOutput / totalWeight : 0;
    const forecastInput = totalWeight > 0 ? weightedInput / totalWeight : 0;
    const forecastPayable = Math.max(0, forecastOutput - forecastInput);
    const netForecast = Math.max(0, forecastPayable - carryForward);

    return {
      forecast_output_vat: Math.round(forecastOutput),
      forecast_input_vat: Math.round(forecastInput),
      forecast_payable: Math.round(forecastPayable),
      carry_forward: Math.round(carryForward),
      net_forecast: Math.round(netForecast),
      periods_used: periodsUsed,
      confidence_note: 'Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ.',
    };
  }
}

export const vatForecastService = new VatForecastService();
