interface RiskScoreCardProps {
  score: number;
  criticalCount?: number;
  highCount?: number;
  mediumCount?: number;
}

function scoreColor(score: number) {
  if (score >= 60) return { ring: 'stroke-red-500', label: 'text-red-700', bg: 'bg-red-50' };
  if (score >= 30) return { ring: 'stroke-amber-500', label: 'text-amber-700', bg: 'bg-amber-50' };
  return { ring: 'stroke-green-500', label: 'text-green-700', bg: 'bg-green-50' };
}

export function RiskScoreCard({ score, criticalCount = 0, highCount = 0, mediumCount = 0 }: RiskScoreCardProps) {
  const colors = scoreColor(score);
  const circumference = 2 * Math.PI * 36;
  const filled = (score / 100) * circumference;

  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-start justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-700">🛡️ Điểm Rủi Ro</h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${colors.bg} ${colors.label}`}>
          {score < 20 ? 'Thấp' : score < 50 ? 'Trung bình' : score < 75 ? 'Cao' : 'Nghiêm trọng'}
        </span>
      </div>
      <div className="flex items-center gap-4">
        {/* Arc gauge */}
        <svg width="90" height="90" viewBox="0 0 90 90" className="shrink-0">
          <circle cx="45" cy="45" r="36" fill="none" stroke="#f3f4f6" strokeWidth="8" />
          <circle
            cx="45" cy="45" r="36" fill="none" strokeWidth="8"
            className={colors.ring}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference - filled}`}
            strokeDashoffset={circumference * 0.25}
            transform="rotate(-90 45 45)"
          />
          <text x="45" y="50" textAnchor="middle" className={`text-sm font-bold fill-current ${colors.label}`} fontSize="18">
            {score}
          </text>
        </svg>
        {/* Breakdown */}
        <div className="space-y-1.5 text-xs flex-1">
          {criticalCount > 0 && (
            <div className="flex items-center gap-2 text-red-700">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span>{criticalCount} nghiêm trọng</span>
            </div>
          )}
          {highCount > 0 && (
            <div className="flex items-center gap-2 text-orange-700">
              <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0" />
              <span>{highCount} cảnh báo cao</span>
            </div>
          )}
          {mediumCount > 0 && (
            <div className="flex items-center gap-2 text-amber-700">
              <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
              <span>{mediumCount} cần lưu ý</span>
            </div>
          )}
          {criticalCount === 0 && highCount === 0 && mediumCount === 0 && (
            <p className="text-green-700">Không có cờ rủi ro chưa xử lý</p>
          )}
        </div>
      </div>
    </div>
  );
}
