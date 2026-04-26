'use client';

/**
 * TaxCalendar — Professional Vietnamese VAT deadline calendar.
 *
 * Deadlines are computed CLIENT-SIDE using taxDeadlines.ts so the display is
 * always accurate regardless of backend data:
 *   Monthly  → Day 20 of the following month
 *   Quarterly → Last day of the first month of the next quarter
 *               Q1 → 30/04 | Q2 → 31/07 | Q3 → 31/10 | Q4 → 31/01 (next year)
 *
 * Legal basis: Điều 44 – Luật Quản lý thuế 38/2019/QH14
 */

import {
  getMonthlyDeadline,
  getQuarterlyDeadline,
  checkDeadlineStatus,
  fromVNDate,
  type DeadlineStatus,
} from '../../utils/taxDeadlines';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TaxDeadline {
  label: string;
  due: string;
  days_left: number;
  type: string;
}

export interface ProfessionalTaxCalendarProps {
  /** Backend deadlines array — used only for label text in the "Upcoming" section. */
  deadlines: TaxDeadline[];
  year: number;
  currentMonth: number;
  /** "GTGT" for SME, "Thuế khoán" for HKD */
  taxLabel?: string;
  title?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a Date as "DD/MM" in Vietnam timezone. */
function fmtDDMM(d: Date): string {
  const { day, month } = fromVNDate(d);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
}

/** Format a Date as "DD/MM/YYYY" in Vietnam timezone. */
function fmtFull(d: Date): string {
  const { day, month, year } = fromVNDate(d);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

/** Days-left display string. */
function daysLabel(dl: number): string {
  if (dl < 0)  return `Quá ${Math.abs(dl)} ngày`;
  if (dl === 0) return 'Hôm nay!';
  if (dl === 1) return 'Còn 1 ngày';
  return `Còn ${dl} ngày`;
}

// ─── Style maps ───────────────────────────────────────────────────────────────

/** Tailwind classes for the monthly grid cell. */
function monthCellCls(s: DeadlineStatus, isCurrent: boolean): string {
  if (s.daysLeft < 0)  return 'bg-gray-100 text-gray-400';
  if (isCurrent && s.daysLeft === 0) return 'bg-red-600 text-white shadow ring-2 ring-red-400';
  if (isCurrent)       return 'bg-blue-600 text-white shadow-md';
  if (s.daysLeft === 0) return 'bg-red-600 text-white font-bold';
  if (s.daysLeft <= 7)  return 'bg-red-100 text-red-700 font-bold ring-1 ring-red-300';
  if (s.daysLeft <= 20) return 'bg-orange-100 text-orange-700';
  return 'bg-green-50 text-green-700';
}

/** Tailwind classes for the "Upcoming" row. */
function upcomingRowCls(dl: number): string {
  if (dl === 0)  return 'bg-red-200 text-red-900 font-bold';
  if (dl <= 7)   return 'bg-red-50 text-red-800 font-semibold border border-red-200';
  if (dl <= 20)  return 'bg-orange-50 text-orange-800 border border-orange-200';
  return 'bg-green-50 text-green-800 border border-green-200';
}

/** Dot color for upcoming row. */
function dotCls(dl: number): string {
  if (dl === 0 || dl <= 7)  return 'bg-red-500';
  if (dl <= 20)             return 'bg-orange-400';
  return 'bg-green-500';
}

/** Badge inside upcoming row. */
function badgeCls(dl: number): string {
  if (dl === 0)  return 'bg-red-600 text-white';
  if (dl <= 7)   return 'bg-red-100 text-red-700';
  if (dl <= 20)  return 'bg-orange-100 text-orange-700';
  return 'bg-green-100 text-green-700';
}

/** Quarterly card background. */
function qCardCls(s: DeadlineStatus, isCurrent: boolean): string {
  if (s.daysLeft < 0) return 'bg-gray-50 text-gray-400 border-gray-200';
  if (isCurrent && s.daysLeft === 0) return 'bg-red-600 text-white border-red-600 shadow-lg';
  if (isCurrent && s.daysLeft <= 7)  return 'bg-red-500 text-white border-red-500 shadow-lg';
  if (isCurrent)      return 'bg-blue-600 text-white border-blue-600 shadow-md';
  if (s.daysLeft === 0) return 'bg-red-600 text-white border-red-600';
  if (s.daysLeft <= 7)  return 'bg-red-50 text-red-700 border-red-300';
  if (s.daysLeft <= 20) return 'bg-orange-50 text-orange-700 border-orange-300';
  return 'bg-green-50 text-green-700 border-green-200';
}

/** Days-left badge in quarterly card. */
function qBadgeCls(s: DeadlineStatus, isCurrent: boolean): string {
  if (isCurrent) return 'bg-white/20 text-white';
  if (s.daysLeft === 0 || s.daysLeft <= 7) return 'bg-red-100 text-red-700';
  if (s.daysLeft <= 20) return 'bg-orange-100 text-orange-700';
  return 'bg-green-100 text-green-700';
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ProfessionalTaxCalendar({
  deadlines,
  year,
  currentMonth,
  taxLabel = 'GTGT',
  title = 'Lịch Thuế',
}: ProfessionalTaxCalendarProps) {
  const months   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
  const quarters = [1, 2, 3, 4] as const;
  const currentQ = Math.ceil(currentMonth / 3);

  // ── Compute all deadline statuses client-side ────────────────────────────
  const monthlyStatus = months.map(m => ({
    month: m,
    deadline: getMonthlyDeadline(m, year),
    status:   checkDeadlineStatus(getMonthlyDeadline(m, year), 7),
  }));

  const quarterlyStatus = quarters.map(q => ({
    quarter:  q,
    deadline: getQuarterlyDeadline(q, year),
    status:   checkDeadlineStatus(getQuarterlyDeadline(q, year), 7),
    deadlineYear: q === 4 ? year + 1 : year,
  }));

  // ── "Upcoming" section: next 3 deadlines with labels from backend ────────
  // Build from client-computed statuses so dates are always correct.
  // Labels: prefer backend label strings (they have the right Vietnamese text).
  const upcomingItems = [
    ...monthlyStatus
      .filter(({ status }) => status.daysLeft >= 0)
      .map(({ month: m, deadline, status }) => {
        const backendLabel = deadlines.find(d =>
          (d.type === 'gtgt_monthly' || d.type === 'hkd_monthly') &&
          d.label.includes(`T${m}/`)
        )?.label ?? `Nộp ${taxLabel} T${m}/${year}`;
        return { label: backendLabel, deadline, daysLeft: status.daysLeft };
      }),
    ...quarterlyStatus
      .filter(({ status }) => status.daysLeft >= 0)
      .map(({ quarter: q, deadline, status }) => {
        const backendLabel = deadlines.find(d =>
          (d.type === 'gtgt_quarterly' || d.type === 'hkd_quarterly') &&
          d.label.includes(`Q${q}/`)
        )?.label ?? `Nộp ${taxLabel} Q${q}/${year}`;
        return { label: backendLabel, deadline, daysLeft: status.daysLeft };
      }),
  ]
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 3);

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">

      {/* ── Header ── */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">📅</span>
          <div>
            <h2 className="text-sm font-bold text-white leading-tight">{title} {year}</h2>
            <p className="text-[10px] text-blue-200 leading-tight">Luật Quản lý thuế 38/2019/QH14</p>
          </div>
        </div>
        <div className="text-right hidden sm:block">
          <p className="text-[10px] text-blue-200">Tháng: hạn ngày 20 tháng kế</p>
          <p className="text-[10px] text-blue-200">Quý: hạn ngày cuối tháng đầu quý kế</p>
        </div>
      </div>

      <div className="p-4 space-y-5">

        {/* ── Upcoming deadlines ── */}
        {upcomingItems.length > 0 && (
          <div>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">
              ⚡ Sắp đến hạn
            </p>
            <div className="space-y-1.5">
              {upcomingItems.map((item, i) => (
                <div
                  key={i}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 ${upcomingRowCls(item.daysLeft)}`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotCls(item.daysLeft)}`} />
                    <span className="text-xs font-medium">{item.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[11px] font-mono text-gray-500 hidden sm:inline">
                      {fmtFull(item.deadline)}
                    </span>
                    <span className="text-[11px] font-mono text-gray-500 sm:hidden">
                      {fmtDDMM(item.deadline)}
                    </span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeCls(item.daysLeft)}`}>
                      {daysLabel(item.daysLeft)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Monthly 12-month grid ── */}
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
              Kê khai theo tháng
            </p>
            <span className="text-[9px] text-gray-400">(hạn ngày 20 tháng kế)</span>
          </div>
          <div className="grid grid-cols-12 gap-1">
            {monthlyStatus.map(({ month: m, deadline, status }) => {
              const isCurrent = m === currentMonth;
              const isPast    = status.daysLeft < 0;
              return (
                <div
                  key={m}
                  title={`T${m}/${year} — hạn ${fmtFull(deadline)}${isPast ? ' (đã qua)' : ''}`}
                  className={`flex flex-col items-center justify-center rounded-lg py-2 cursor-default select-none transition-colors ${monthCellCls(status, isCurrent)}`}
                >
                  <span className="text-[9px] font-bold leading-tight">T{m}</span>
                  {isPast ? (
                    <span className="text-[8px] leading-none mt-0.5 opacity-70">✓</span>
                  ) : (
                    <span className={`text-[8px] leading-none mt-0.5 tabular-nums ${isCurrent ? 'text-blue-100' : 'opacity-80'}`}>
                      {fmtDDMM(deadline)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* Legend */}
          <div className="flex gap-3 mt-2 flex-wrap">
            {[
              { cls: 'bg-green-100',  label: 'Còn nhiều thời gian' },
              { cls: 'bg-orange-100', label: '≤ 20 ngày' },
              { cls: 'bg-red-100',    label: '≤ 7 ngày' },
              { cls: 'bg-gray-100',   label: 'Đã qua' },
            ].map(({ cls, label }) => (
              <span key={label} className="flex items-center gap-1">
                <span className={`w-2.5 h-2.5 rounded ${cls} inline-block`} />
                <span className="text-[9px] text-gray-400">{label}</span>
              </span>
            ))}
          </div>
        </div>

        {/* ── Quarterly 4-column grid ── */}
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">
              Kê khai theo quý
            </p>
            <span className="text-[9px] text-gray-400">(hạn ngày cuối tháng đầu quý kế)</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {quarterlyStatus.map(({ quarter: q, deadline, status, deadlineYear }) => {
              const isCurrent = q === currentQ;
              const isPast    = status.daysLeft < 0;
              return (
                <div
                  key={q}
                  title={`Q${q}/${year} — hạn ${fmtFull(deadline)}`}
                  className={`border rounded-xl px-2 py-3 text-center transition-all ${qCardCls(status, isCurrent)}`}
                >
                  <p className="text-xs font-bold leading-tight">Q{q}/{year}</p>
                  <p className={`text-[10px] mt-1 leading-tight font-mono ${isCurrent && !isPast ? 'text-blue-100 opacity-90' : 'opacity-80'}`}>
                    {isPast
                      ? '✓ Đã qua'
                      : `${fmtDDMM(deadline)}/${deadlineYear}`}
                  </p>
                  {!isPast && (
                    <span className={`inline-block mt-1.5 text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${qBadgeCls(status, isCurrent)}`}>
                      {daysLabel(status.daysLeft)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Legacy TaxCalendar (kept for backward compatibility) ─────────────────────

interface TaxCalendarProps {
  deadlines: TaxDeadline[];
  title?: string;
  emptyText?: string;
}

export function TaxCalendar({
  deadlines,
  title = '📅 Lịch Thuế',
  emptyText = 'Đang tải...',
}: TaxCalendarProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">{title}</h2>
      {deadlines.length > 0 ? (
        <div className="space-y-3">
          {deadlines.map((d, i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="text-sm text-gray-600">{d.label}</span>
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                d.days_left < 0      ? 'bg-red-100 text-red-700'
                : d.days_left <= 7  ? 'bg-orange-100 text-orange-700'
                : d.days_left <= 20 ? 'bg-amber-100 text-amber-700'
                : 'bg-green-100 text-green-700'
              }`}>
                {d.days_left < 0 ? 'Quá hạn' : `Còn ${d.days_left}d`}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400">{emptyText}</p>
      )}
    </div>
  );
}
