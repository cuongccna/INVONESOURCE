/**
 * Shared period resolution utility for report routes.
 * Converts query params (month/quarter/year + periodType) into a date range.
 */
import type { ParsedQs } from 'qs';

export type PeriodType = 'monthly' | 'quarterly' | 'yearly';

export interface ResolvedPeriod {
  start: string;       // ISO date YYYY-MM-DD (inclusive)
  end: string;         // ISO date YYYY-MM-DD (inclusive)
  year: number;
  month: number;       // first month of the range (1-12)
  quarter: number;     // 1-4 for quarterly, 0 otherwise
  periodType: PeriodType;
}

/**
 * Resolve a period from Express query params.
 * Supports:
 *   periodType=monthly  (default) + month=1-12 + year
 *   periodType=quarterly           + quarter=1-4 + year
 *   periodType=yearly              + year
 */
export function resolvePeriod(query: ParsedQs): ResolvedPeriod {
  const year = parseInt(query['year'] as string) || new Date().getFullYear();
  const periodType = ((query['periodType'] as string) ?? 'monthly') as PeriodType;

  if (periodType === 'quarterly') {
    const quarter = Math.min(4, Math.max(1, parseInt(query['quarter'] as string) || 1));
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    const start = `${year}-${String(startMonth).padStart(2, '0')}-01`;
    const end = new Date(year, endMonth, 0).toISOString().split('T')[0]!;
    return { start, end, year, month: startMonth, quarter, periodType: 'quarterly' };
  }

  if (periodType === 'yearly') {
    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      year,
      month: 1,
      quarter: 0,
      periodType: 'yearly',
    };
  }

  // monthly (default)
  const month = Math.min(12, Math.max(1, parseInt(query['month'] as string) || new Date().getMonth() + 1));
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0]!;
  return { start, end, year, month, quarter: 0, periodType: 'monthly' };
}
