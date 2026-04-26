interface TaxDeadline {
  label: string;
  due: string;
  days_left: number;
  type: string;
}

interface ProfessionalTaxCalendarProps {
  deadlines: TaxDeadline[];
  year: number;
  currentMonth: number;
  title?: string;
}

function urgencyClass(daysLeft: number): string {
  if (daysLeft < 0)   return 'bg-gray-100 text-gray-400';
  if (daysLeft <= 7)  return 'bg-red-100 text-red-700 font-bold';
  if (daysLeft <= 20) return 'bg-orange-100 text-orange-700';
  return 'bg-green-100 text-green-700';
}

function urgencyDot(daysLeft: number): string {
  if (daysLeft < 0)   return 'bg-gray-300';
  if (daysLeft <= 7)  return 'bg-red-500';
  if (daysLeft <= 20) return 'bg-orange-400';
  return 'bg-green-500';
}

function urgencyLabel(daysLeft: number): string {
  if (daysLeft < 0)  return 'Đã qua';
  if (daysLeft === 0) return 'Hôm nay!';
  if (daysLeft <= 7)  return `Còn ${daysLeft} ngày`;
  if (daysLeft <= 20) return `Còn ${daysLeft} ngày`;
  return `Còn ${daysLeft} ngày`;
}

export function ProfessionalTaxCalendar({ deadlines, year, currentMonth, title = 'Lịch Thuế' }: ProfessionalTaxCalendarProps) {
  // Monthly deadlines: type = 'gtgt_monthly' or 'hkd_monthly'
  const monthly = deadlines.filter(d => d.type === 'gtgt_monthly' || d.type === 'hkd_monthly');
  // Quarterly deadlines: type = 'gtgt_quarterly' or 'hkd_quarterly'
  const quarterly = deadlines.filter(d => d.type === 'gtgt_quarterly' || d.type === 'hkd_quarterly');

  // Upcoming = next 3 deadlines that are not yet passed, sorted by days_left
  const upcoming = deadlines
    .filter(d => d.days_left >= 0 && (d.type.includes('monthly') || d.type.includes('quarterly')))
    .sort((a, b) => a.days_left - b.days_left)
    .slice(0, 3);

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const quarters = [1, 2, 3, 4];

  // Map month → deadline
  const monthDeadlineMap: Record<number, TaxDeadline | undefined> = {};
  monthly.forEach(d => {
    // Extract the invoice month from label (e.g., "Nộp GTGT T4/2026" → 4)
    const m = parseInt(d.label.match(/T(\d+)\//)?.[1] ?? '0');
    if (m > 0) monthDeadlineMap[m] = d;
  });

  const quarterDeadlineMap: Record<number, TaxDeadline | undefined> = {};
  quarterly.forEach(d => {
    const q = parseInt(d.label.match(/Q(\d+)\//)?.[1] ?? '0');
    if (q > 0) quarterDeadlineMap[q] = d;
  });

  const QUARTER_DEADLINES: Record<number, string> = { 1: '20/04', 2: '20/07', 3: '20/10', 4: '20/01' };

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-white text-base">📅</span>
          <h2 className="text-sm font-bold text-white">{title} {year}</h2>
        </div>
        <span className="text-xs text-blue-200">Hạn: ngày 20 tháng kế tiếp</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Upcoming deadlines */}
        {upcoming.length > 0 && (
          <div>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">⚡ Sắp đến hạn</p>
            <div className="space-y-1.5">
              {upcoming.map((d, i) => (
                <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-2 ${urgencyClass(d.days_left)}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${urgencyDot(d.days_left)}`} />
                    <span className="text-xs font-medium">{d.label}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px]">{new Date(d.due).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}</span>
                    <span className="text-[10px] font-bold">{urgencyLabel(d.days_left)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Monthly calendar grid */}
        <div>
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">
            Kê khai theo tháng
            <span className="font-normal ml-1 text-gray-400">(hạn ngày 20 tháng kế)</span>
          </p>
          <div className="grid grid-cols-12 gap-1">
            {months.map((m) => {
              const d = monthDeadlineMap[m];
              const isCurrent = m === currentMonth;
              const isPast = d ? d.days_left < 0 : false;
              const bgClass = !d ? 'bg-gray-50 text-gray-300'
                : isPast      ? 'bg-gray-100 text-gray-400'
                : isCurrent   ? 'bg-blue-600 text-white shadow-md'
                : d.days_left <= 7  ? 'bg-red-100 text-red-700'
                : d.days_left <= 20 ? 'bg-orange-100 text-orange-700'
                : 'bg-green-50 text-green-700';
              return (
                <div
                  key={m}
                  title={d ? `${d.label} — hạn ${d.due}` : `T${m}/${year}`}
                  className={`flex flex-col items-center justify-center rounded-lg py-1.5 cursor-default select-none ${bgClass}`}
                >
                  <span className="text-[9px] font-bold">T{m}</span>
                  {d && !isPast && (
                    <span className={`text-[8px] leading-none mt-0.5 ${isCurrent ? 'text-blue-100' : ''}`}>
                      20/{m === 12 ? '01' : String(m + 1).padStart(2, '0')}
                    </span>
                  )}
                  {isPast && <span className="text-[8px] leading-none mt-0.5">✓</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Quarterly row */}
        <div>
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-2">
            Kê khai theo quý
            <span className="font-normal ml-1 text-gray-400">(hạn ngày 20 tháng đầu quý kế)</span>
          </p>
          <div className="grid grid-cols-4 gap-2">
            {quarters.map((q) => {
              const d = quarterDeadlineMap[q];
              const currentQ = Math.ceil(currentMonth / 3);
              const isCurrentQ = q === currentQ;
              const isPast = d ? d.days_left < 0 : false;
              const bgClass = isPast        ? 'bg-gray-50 text-gray-400 border-gray-200'
                : isCurrentQ  ? 'bg-blue-600 text-white border-blue-600 shadow-md'
                : d && d.days_left <= 7  ? 'bg-red-50 text-red-700 border-red-200'
                : d && d.days_left <= 20 ? 'bg-orange-50 text-orange-700 border-orange-200'
                : 'bg-green-50 text-green-700 border-green-200';
              return (
                <div key={q} className={`border rounded-lg px-2 py-2 text-center ${bgClass}`}>
                  <p className="text-xs font-bold">Q{q}/{year}</p>
                  <p className={`text-[10px] mt-0.5 ${isCurrentQ ? 'text-blue-100' : ''}`}>
                    {isPast ? '✓ Đã qua' : `Hạn ${QUARTER_DEADLINES[q]}${q === 4 ? `/${year + 1}` : `/${year}`}`}
                  </p>
                  {d && !isPast && (
                    <p className={`text-[9px] font-semibold mt-0.5 ${isCurrentQ ? 'text-blue-100' : ''}`}>
                      {urgencyLabel(d.days_left)}
                    </p>
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

// Legacy component kept for backward compatibility
interface TaxCalendarProps {
  deadlines: TaxDeadline[];
  title?: string;
  emptyText?: string;
}

export function TaxCalendar({ deadlines, title = '📅 Lịch Thuế', emptyText = 'Đang tải...' }: TaxCalendarProps) {
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
