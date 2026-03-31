'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { formatVND } from '../../../../utils/formatCurrency';
import apiClient from '../../../../lib/apiClient';

interface SeasonalPoint {
  month: number;
  year: number;
  revenue: number;
  spend: number;
  invoices: number;
}

interface SeasonalPayload {
  raw: SeasonalPoint[];
  ai_analysis: string | null;
}

const monthLabel = (m: number, y: number) => `T${m}/${String(y).slice(2)}`;

export default function SeasonalInsightsPage() {
  const [data, setData] = useState<SeasonalPoint[]>([]);
  const [analysis, setAnalysis] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: SeasonalPayload }>('/insights/seasonal')
      .then((res) => {
        setData(res.data.data.raw ?? []);
        setAnalysis(res.data.data.ai_analysis ?? '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const chartData = useMemo(
    () => data.map((d) => ({
      name: monthLabel(d.month, d.year),
      revenue: Math.round(d.revenue / 1_000_000),
      spend: Math.round(d.spend / 1_000_000),
      invoices: d.invoices,
    })),
    [data],
  );

  if (loading) {
    return (
      <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
        <div className="flex justify-center py-14">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Insight Mua Theo Mùa</h1>
        <p className="text-sm text-gray-500 mt-1">Phân tích 24 tháng doanh thu, chi phí và tính mùa vụ</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Doanh thu vs Chi phí (triệu VND)</h2>
        {chartData.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-8">Chưa có dữ liệu</p>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={45} />
              <Tooltip formatter={(v: number) => formatVND(Number(v) * 1_000_000)} />
              <Bar dataKey="revenue" name="Doanh thu" fill="#2563eb" radius={[3, 3, 0, 0]} />
              <Bar dataKey="spend" name="Chi phí" fill="#059669" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Phân tích AI</h2>
        {analysis ? (
          <p className="text-sm text-gray-700 leading-6 whitespace-pre-line">{analysis}</p>
        ) : (
          <p className="text-sm text-gray-400">Chưa có phân tích AI (cần tối thiểu 6 tháng dữ liệu).</p>
        )}
      </div>

      {chartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Heatmap Mùa Vụ (doanh thu)</h2>
          <div className="grid grid-cols-4 gap-2 text-xs">
            {data.map((d) => {
              const score = d.revenue > 0 ? Math.min(1, d.revenue / Math.max(...data.map((x) => x.revenue))) : 0;
              const alpha = 0.15 + score * 0.75;
              return (
                <div
                  key={`${d.year}-${d.month}`}
                  className="rounded-lg p-2 border border-gray-100"
                  style={{ backgroundColor: `rgba(37, 99, 235, ${alpha})` }}
                >
                  <p className="font-semibold text-white">T{d.month}/{String(d.year).slice(2)}</p>
                  <p className="text-white/90">{formatVND(d.revenue)}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
