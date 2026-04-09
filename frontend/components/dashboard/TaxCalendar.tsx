interface TaxDeadline {
  label: string;
  due: string;
  days_left: number;
  type: string;
}

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
