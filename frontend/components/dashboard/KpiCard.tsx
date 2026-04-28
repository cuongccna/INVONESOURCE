interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  badge?: string;
  badgeColor?: string;
}

export function KpiCard({ label, value, sub, color = 'text-gray-900', badge, badgeColor = 'bg-gray-100 text-gray-600' }: KpiCardProps) {
  const len = value.length;
  const textSize =
    len <= 6  ? 'text-2xl' :
    len <= 9  ? 'text-xl'  :
    len <= 13 ? 'text-lg'  :
               'text-base';
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-start justify-between mb-1">
        <p className="text-xs text-gray-500">{label}</p>
        {badge && (
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${badgeColor}`}>
            {badge}
          </span>
        )}
      </div>
      <p className={`${textSize} font-bold leading-tight ${color} break-words tabular-nums`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
