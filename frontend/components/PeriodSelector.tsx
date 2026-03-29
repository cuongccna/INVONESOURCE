'use client';

export type PeriodType = 'monthly' | 'quarterly' | 'yearly';

export interface PeriodValue {
  periodType: PeriodType;
  month: number;    // 1-12 (used when periodType='monthly')
  quarter: number;  // 1-4  (used when periodType='quarterly')
  year: number;
}

export function defaultPeriod(): PeriodValue {
  const now = new Date();
  return {
    periodType: 'monthly',
    month: now.getMonth() + 1,
    quarter: Math.ceil((now.getMonth() + 1) / 3),
    year: now.getFullYear(),
  };
}

/** Convert PeriodValue to URLSearchParams for API calls */
export function periodToParams(p: PeriodValue): URLSearchParams {
  const params = new URLSearchParams({ year: String(p.year), periodType: p.periodType });
  if (p.periodType === 'monthly') params.append('month', String(p.month));
  if (p.periodType === 'quarterly') params.append('quarter', String(p.quarter));
  return params;
}

/** Human-readable period label */
export function periodLabel(p: PeriodValue): string {
  if (p.periodType === 'monthly') return `Tháng ${p.month}/${p.year}`;
  if (p.periodType === 'quarterly') return `Quý ${p.quarter}/${p.year}`;
  return `Năm ${p.year}`;
}

interface PeriodSelectorProps {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
}

export default function PeriodSelector({ value, onChange }: PeriodSelectorProps) {
  const now = new Date();
  // Show current year + 1 ahead and 4 back
  const years = Array.from({ length: 6 }, (_, i) => now.getFullYear() + 1 - i);
  const { periodType, month, quarter, year } = value;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Period type toggle */}
      <div className="flex bg-gray-100 rounded-lg p-1">
        {(['monthly', 'quarterly', 'yearly'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onChange({ ...value, periodType: t })}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
              periodType === t
                ? 'bg-white shadow text-blue-700'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'monthly' ? 'Tháng' : t === 'quarterly' ? 'Quý' : 'Năm'}
          </button>
        ))}
      </div>

      {/* Month select — only for monthly */}
      {periodType === 'monthly' && (
        <select
          value={month}
          onChange={(e) => onChange({ ...value, month: Number(e.target.value) })}
          className="border rounded-lg px-2 py-1 text-sm"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>
              Tháng {m}
            </option>
          ))}
        </select>
      )}

      {/* Quarter select — only for quarterly */}
      {periodType === 'quarterly' && (
        <select
          value={quarter}
          onChange={(e) => onChange({ ...value, quarter: Number(e.target.value) })}
          className="border rounded-lg px-2 py-1 text-sm"
        >
          {[1, 2, 3, 4].map((q) => (
            <option key={q} value={q}>
              Quý {q}
            </option>
          ))}
        </select>
      )}

      {/* Year select — always shown */}
      <select
        value={year}
        onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}
        className="border rounded-lg px-2 py-1 text-sm"
      >
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
