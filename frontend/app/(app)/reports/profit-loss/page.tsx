'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';
import PeriodSelector, {
  type PeriodValue,
  defaultPeriod,
  periodToParams,
  periodLabel,
} from '../../../../components/PeriodSelector';

interface PLStatement {
  company_id: string;
  period_month: number;
  period_year: number;
  line_01: number;
  line_02: number;
  line_10: number;
  line_11: number;
  line_20: number;
  line_21: number;
  line_22: number;
  line_25: number;
  line_26: number;
  line_30: number;
  line_31: number;
  line_32: number;
  line_40: number;
  line_50: number;
  line_51: number;
  line_60: number;
  has_estimates: boolean;
  estimate_notes: string;
}

interface PLData {
  current: PLStatement | null;
  previous: PLStatement | null;
}

const LINE_LABELS: Array<{ key: keyof PLStatement; label: string; indent?: number; bold?: boolean; separator?: boolean }> = [
  { key: 'line_01', label: '1. Doanh thu bán hàng và cung cấp dịch vụ', bold: true },
  { key: 'line_02', label: '2. Các khoản giảm trừ doanh thu', indent: 1 },
  { key: 'line_10', label: '10. Doanh thu thuần (01-02)', bold: true, separator: true },
  { key: 'line_11', label: '11. Giá vốn hàng bán', indent: 1 },
  { key: 'line_20', label: '20. Lợi nhuận gộp (10-11)', bold: true, separator: true },
  { key: 'line_21', label: '21. Doanh thu hoạt động tài chính', indent: 1 },
  { key: 'line_22', label: '22. Chi phí tài chính', indent: 1 },
  { key: 'line_25', label: '25. Chi phí bán hàng', indent: 1 },
  { key: 'line_26', label: '26. Chi phí quản lý doanh nghiệp', indent: 1 },
  { key: 'line_30', label: '30. LN thuần từ HĐKD (20+21-22-25-26)', bold: true, separator: true },
  { key: 'line_31', label: '31. Thu nhập khác', indent: 1 },
  { key: 'line_32', label: '32. Chi phí khác', indent: 1 },
  { key: 'line_40', label: '40. Lợi nhuận khác (31-32)', bold: true, separator: true },
  { key: 'line_50', label: '50. Tổng lợi nhuận trước thuế (30+40)', bold: true, separator: true },
  { key: 'line_51', label: '51. Chi phí thuế TNDN hiện hành (20%)', indent: 1 },
  { key: 'line_60', label: '60. Lợi nhuận sau thuế (50-51)', bold: true, separator: true },
];

export default function ProfitLossPage() {
  const { activeCompanyId } = useCompany();
  const [data, setData] = useState<PLData | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriod);
  const [compare, setCompare] = useState(false);

  const fetch = () => {
    if (!activeCompanyId) return;
    setLoading(true);
    const params = periodToParams(period);
    if (compare && period.periodType === 'monthly') params.append('compare', 'true');
    apiClient
      .get<{ data: PLData }>(`/reports/profit-loss?${params}`)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetch(); }, [activeCompanyId, period, compare]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setGenerating(true);
    try {
      const body: Record<string, unknown> = { year: period.year, periodType: period.periodType };
      if (period.periodType === 'monthly') body.month = period.month;
      if (period.periodType === 'quarterly') body.quarter = period.quarter;
      await apiClient.post('/reports/profit-loss/generate', body);
      fetch();
    } catch {
      // ignore
    } finally {
      setGenerating(false);
    }
  };

  const getVal = (pl: PLStatement | null, key: keyof PLStatement): number => {
    if (!pl) return 0;
    const v = pl[key];
    return typeof v === 'number' ? v : 0;
  };

  const lineColor = (key: keyof PLStatement, pl: PLStatement | null): string => {
    if (!pl) return '';
    const v = getVal(pl, key);
    if (['line_20','line_30','line_50','line_60'].includes(key as string)) {
      return v > 0 ? 'text-green-700' : v < 0 ? 'text-red-700' : 'text-gray-500';
    }
    return '';
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kết Quả Hoạt Động Kinh Doanh</h1>
          <p className="text-sm text-gray-500">{periodLabel(period)} · Mẫu B02-DN</p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <PeriodSelector value={period} onChange={setPeriod} />
          {period.periodType === 'monthly' && (
            <label className="flex items-center gap-1 text-sm cursor-pointer">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              So sánh
            </label>
          )}
          <button onClick={generate} disabled={generating}
            className="px-4 py-1 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
            {generating ? 'Đang tính...' : '📊 Tính lại'}
          </button>
        </div>
      </div>

      {data?.current?.has_estimates && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
          ⚠️ Dữ liệu ước tính: {data.current.estimate_notes}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : !data?.current ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-3">Chưa có báo cáo kỳ này</p>
          <button onClick={generate} disabled={generating}
            className="px-6 py-2 bg-blue-600 text-white rounded-lg disabled:opacity-50">
            {generating ? 'Đang tính...' : 'Tạo báo cáo ngay'}
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 text-left">Chỉ tiêu</th>
                <th className="px-4 py-2 text-right">
                  {periodLabel(period)}
                </th>
                {compare && data.previous && (
                  <th className="px-4 py-2 text-right text-gray-400">
                    T{period.month === 1 ? 12 : period.month - 1}/{period.month === 1 ? period.year - 1 : period.year}
                  </th>
                )}
                {compare && data.previous && (
                  <th className="px-4 py-2 text-right">+/−</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {LINE_LABELS.map(({ key, label, indent, bold, separator }) => {
                const curr = getVal(data.current, key);
                const prev = compare && data.previous ? getVal(data.previous, key) : null;
                const delta = prev !== null ? curr - prev : null;
                return (
                  <tr key={key} className={`${separator ? 'border-t-2 border-gray-200' : ''} hover:bg-gray-50`}>
                    <td className={`px-4 py-2 ${bold ? 'font-semibold' : 'text-gray-600'}`}
                      style={{ paddingLeft: `${(indent ?? 0) * 16 + 16}px` }}>
                      {label}
                    </td>
                    <td className={`px-4 py-2 text-right ${bold ? 'font-semibold' : ''} ${lineColor(key, data.current)}`}>
                      {formatVND(curr)}
                    </td>
                    {compare && data.previous && (
                      <td className="px-4 py-2 text-right text-gray-400">{formatVND(prev ?? 0)}</td>
                    )}
                    {compare && data.previous && (
                      <td className={`px-4 py-2 text-right text-xs ${delta !== null && delta > 0 ? 'text-green-600' : delta !== null && delta < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {delta !== null ? (delta >= 0 ? '+' : '') + formatVND(delta) : ''}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
