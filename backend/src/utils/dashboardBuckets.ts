import type { PeriodType } from './period';

export interface DashboardBucket {
  key: string;
  label: string;
  year: number;
  month: number;
  quarter: number;
  startDate: string;
  endExclusiveDate: string;
}

function toIsoDate(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().split('T')[0]!;
}

export function buildDashboardBucketKey(
  periodType: PeriodType,
  year: number,
  month = 1,
  quarter = 1,
): string {
  if (periodType === 'monthly') {
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  if (periodType === 'quarterly') {
    return `${year}-Q${quarter}`;
  }

  return `${year}`;
}

export function buildTrailingDashboardBuckets(
  periodType: PeriodType,
  anchor: { year: number; month?: number; quarter?: number },
  count?: number,
): DashboardBucket[] {
  if (periodType === 'monthly') {
    const month = anchor.month ?? 1;
    const size = count ?? 12;

    return Array.from({ length: size }, (_, index) => {
      const offset = size - 1 - index;
      const bucketDate = new Date(Date.UTC(anchor.year, month - 1 - offset, 1));
      const year = bucketDate.getUTCFullYear();
      const bucketMonth = bucketDate.getUTCMonth() + 1;

      return {
        key: buildDashboardBucketKey('monthly', year, bucketMonth),
        label: `T${bucketMonth}/${String(year).slice(-2)}`,
        year,
        month: bucketMonth,
        quarter: Math.ceil(bucketMonth / 3),
        startDate: toIsoDate(year, bucketMonth - 1, 1),
        endExclusiveDate: toIsoDate(year, bucketMonth, 1),
      };
    });
  }

  if (periodType === 'quarterly') {
    const quarter = anchor.quarter ?? Math.ceil((anchor.month ?? 1) / 3);
    const size = count ?? 4;
    const anchorMonth = (quarter - 1) * 3;

    return Array.from({ length: size }, (_, index) => {
      const offset = size - 1 - index;
      const bucketDate = new Date(Date.UTC(anchor.year, anchorMonth - offset * 3, 1));
      const year = bucketDate.getUTCFullYear();
      const bucketQuarter = Math.floor(bucketDate.getUTCMonth() / 3) + 1;
      const startMonth = (bucketQuarter - 1) * 3;

      return {
        key: buildDashboardBucketKey('quarterly', year, startMonth + 1, bucketQuarter),
        label: `Q${bucketQuarter}/${String(year).slice(-2)}`,
        year,
        month: startMonth + 1,
        quarter: bucketQuarter,
        startDate: toIsoDate(year, startMonth, 1),
        endExclusiveDate: toIsoDate(year, startMonth + 3, 1),
      };
    });
  }

  const size = count ?? 4;
  return Array.from({ length: size }, (_, index) => {
    const year = anchor.year - (size - 1 - index);

    return {
      key: buildDashboardBucketKey('yearly', year),
      label: String(year),
      year,
      month: 1,
      quarter: 0,
      startDate: toIsoDate(year, 0, 1),
      endExclusiveDate: toIsoDate(year + 1, 0, 1),
    };
  });
}