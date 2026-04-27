import { pool } from '../db/pool';
import { buildTrailingDashboardBuckets } from '../utils/dashboardBuckets';
import type { PeriodType } from '../utils/period';

export interface VatForecast {
  forecast_output_vat: number;
  forecast_input_vat: number;
  forecast_payable: number;
  carry_forward: number;
  net_forecast: number;
  display_amount: number;
  direction: 'payable' | 'deductible';
  periods_used: number;
  confidence_note: string;
}

export class VatForecastService {
  async forecastNextPeriod(
    companyId: string,
    options?: { periodType?: PeriodType; year?: number; month?: number; quarter?: number },
  ): Promise<VatForecast> {
    const now = new Date();
    const periodType = options?.periodType ?? 'monthly';
    const year = options?.year ?? now.getFullYear();
    const month = options?.month ?? now.getMonth() + 1;
    const quarter = options?.quarter ?? Math.ceil(month / 3);
    const weights = [0.5, 0.3, 0.2];
    const historyBuckets = buildTrailingDashboardBuckets(periodType, { year, month, quarter }, 3);
    const newestFirstBuckets = [...historyBuckets].reverse();

    let weightedOutput = 0;
    let weightedInput = 0;
    let totalWeight = 0;
    let periodsUsed = 0;
    let carryForward = 0;

    if (periodType === 'yearly') {
      const targetYears = historyBuckets.map((bucket) => bucket.year);
      const { rows } = await pool.query<{
        period_month: number;
        period_year: number;
        period_type: 'monthly' | 'quarterly';
        ct40a: string;
        deductible_input: string;
        ct43: string;
      }>(
        `SELECT
           period_month,
           period_year,
           period_type,
           COALESCE(ct40a_total_output_vat, 0)::numeric AS ct40a,
           COALESCE(ct23_deductible_input_vat, 0)::numeric AS deductible_input,
           COALESCE(ct43_carry_forward_vat, 0)::numeric AS ct43
         FROM tax_declarations
         WHERE company_id = $1
           AND form_type = '01/GTGT'
           AND period_year = ANY($2::int[])
           AND period_type IN ('monthly', 'quarterly')`,
        [companyId, targetYears],
      );

      for (let index = 0; index < newestFirstBuckets.length; index++) {
        const bucket = newestFirstBuckets[index]!;
        const yearRows = rows.filter((row) => row.period_year === bucket.year);
        const sourceRows = yearRows.some((row) => row.period_type === 'quarterly')
          ? yearRows.filter((row) => row.period_type === 'quarterly')
          : yearRows.filter((row) => row.period_type === 'monthly');

        if (sourceRows.length === 0) {
          continue;
        }

        const output = sourceRows.reduce((sum, row) => sum + Number(row.ct40a), 0);
        const input = sourceRows.reduce((sum, row) => sum + Number(row.deductible_input), 0);

        weightedOutput += output * weights[index]!;
        weightedInput += input * weights[index]!;
        totalWeight += weights[index]!;
        periodsUsed += 1;

        if (index === 0) {
          const carryForwardRow = sourceRows.some((row) => row.period_type === 'quarterly')
            ? sourceRows.find((row) => row.period_type === 'quarterly' && row.period_month === 4)
            : sourceRows.find((row) => row.period_type === 'monthly' && row.period_month === 12);

          carryForward = Number(carryForwardRow?.ct43 ?? 0);
        }
      }
    } else {
      const targetYears = [...new Set(historyBuckets.map((bucket) => bucket.year))];
      const targetKeys = new Set(historyBuckets.map((bucket) => bucket.key));
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
           COALESCE(ct40a_total_output_vat, 0)::numeric AS ct40a,
           COALESCE(ct23_deductible_input_vat, 0)::numeric AS deductible_input,
           COALESCE(ct43_carry_forward_vat, 0)::numeric AS ct43
         FROM tax_declarations
         WHERE company_id = $1
           AND form_type = '01/GTGT'
           AND period_type = $2
           AND period_year = ANY($3::int[])`,
        [companyId, periodType, targetYears],
      );

      const periodMap = new Map<string, { ct40a: number; deductible_input: number; ct43: number }>();
      for (const row of rows) {
        const key = periodType === 'monthly'
          ? `${row.period_year}-${String(row.period_month).padStart(2, '0')}`
          : `${row.period_year}-Q${row.period_month}`;

        if (!targetKeys.has(key)) {
          continue;
        }

        periodMap.set(key, {
          ct40a: Number(row.ct40a),
          deductible_input: Number(row.deductible_input),
          ct43: Number(row.ct43),
        });
      }

      for (let index = 0; index < newestFirstBuckets.length; index++) {
        const bucket = newestFirstBuckets[index]!;
        const point = periodMap.get(bucket.key);
        if (!point) {
          continue;
        }

        weightedOutput += point.ct40a * weights[index]!;
        weightedInput += point.deductible_input * weights[index]!;
        totalWeight += weights[index]!;
        periodsUsed += 1;

        if (index === 0) {
          carryForward = point.ct43;
        }
      }
    }

    if (periodsUsed === 0) {
      return {
        forecast_output_vat: 0,
        forecast_input_vat: 0,
        forecast_payable: 0,
        carry_forward: 0,
        net_forecast: 0,
        display_amount: 0,
        direction: 'deductible',
        periods_used: 0,
        confidence_note: 'Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ.',
      };
    }

    const forecastOutput = totalWeight > 0 ? weightedOutput / totalWeight : 0;
    const forecastInput = totalWeight > 0 ? weightedInput / totalWeight : 0;
    const forecastPayable = Math.max(0, forecastOutput - forecastInput);
    const netForecast = forecastOutput - forecastInput - carryForward;

    return {
      forecast_output_vat: Math.round(forecastOutput),
      forecast_input_vat: Math.round(forecastInput),
      forecast_payable: Math.round(forecastPayable),
      carry_forward: Math.round(carryForward),
      net_forecast: Math.round(netForecast),
      display_amount: Math.round(Math.abs(netForecast)),
      direction: netForecast > 0 ? 'payable' : 'deductible',
      periods_used: periodsUsed,
      confidence_note: 'Dự báo dựa trên 3 kỳ gần nhất. Độ chính xác cao hơn khi dữ liệu đầy đủ.',
    };
  }
}

export const vatForecastService = new VatForecastService();
