'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, BarChart, Bar,
} from 'recharts';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const compact = (n: number) => n.toLocaleString('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const mVnd = (n: number) => `${Math.round(n / 1_000_000).toLocaleString('vi-VN')}M`;

interface CompanyStat {
  id: string; name: string; tax_code: string;
  output_total: string; input_total: string;
  output_vat: string; input_vat: string;
  payable_vat: string; unvalidated_count: string;
  output_invoices: string; input_invoices: string;
}

interface TrendRow {
  month: number; year: number;
  output_total: number; input_total: number;
  output_vat: number; input_vat: number;
}

interface CompareResult {
  period: { month: number; year: number };
  companies: CompanyStat[];
  trend: Record<string, TrendRow[]>;
}

interface UserCompany { id: string; name: string; tax_code: string; }

const METRICS = [
  { key: 'output_total', label: 'Doanh thu', fmt: mVnd, bestHigher: true },
  { key: 'input_total', label: 'Chi phí', fmt: mVnd, bestHigher: false },
  { key: 'payable_vat', label: 'VAT phải nộp', fmt: mVnd, bestHigher: false },
  { key: 'output_invoices', label: 'HĐ đầu ra', fmt: (n: number) => n.toLocaleString('vi-VN'), bestHigher: true },
  { key: 'input_invoices', label: 'HĐ đầu vào', fmt: (n: number) => n.toLocaleString('vi-VN'), bestHigher: true },
  { key: 'unvalidated_count', label: 'Chưa xác thực', fmt: (n: number) => n.toLocaleString('vi-VN'), bestHigher: false },
] as const;

export default function ComparePage() {
  const { companies: allCompanies } = useCompany();
  const [selected, setSelected] = useState<string[]>([]);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (ids: string[], m: number, y: number) => {
    if (ids.length < 2) return;
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: CompareResult }>(
        `/compare?companyIds=${ids.join(',')}&month=${m}&year=${y}`
      );
      setResult(res.data.data);
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (selected.length >= 2) void load(selected, month, year); }, [selected, month, year, load]);

  const toggleCompany = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 6 ? [...prev, id] : prev
    );
  };

  // Build trend chart data (align by month/year label)
  const buildTrendData = () => {
    if (!result) return [];
    const labels = new Map<string, Record<string, number>>();
    for (const [companyId, rows] of Object.entries(result.trend)) {
      const company = result.companies.find((c) => c.id === companyId);
      if (!company) continue;
      for (const row of rows) {
        const key = `T${row.month}/${String(row.year).slice(2)}`;
        if (!labels.has(key)) labels.set(key, { _sort: row.year * 100 + row.month });
        labels.get(key)![company.name] = Math.round(row.output_total / 1_000_000);
      }
    }
    return [...labels.entries()]
      .sort((a, b) => (a[1]._sort as number) - (b[1]._sort as number))
      .map(([name, vals]) => ({ name, ...vals }));
  };

  const trendData = buildTrendData();

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">So Sánh Công Ty</h1>
          <p className="text-sm text-gray-500 mt-0.5">Chọn 2–6 công ty để so sánh</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>T{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {/* Company selector chips */}
      <div className="bg-white rounded-xl shadow-sm p-4">
        <p className="text-xs font-semibold text-gray-500 mb-3">
          Đã chọn: {selected.length}/6 công ty
        </p>
        <div className="flex flex-wrap gap-2">
          {(allCompanies as UserCompany[]).map((c, i) => {
            const idx = selected.indexOf(c.id);
            const active = idx >= 0;
            return (
              <button key={c.id} onClick={() => toggleCompany(c.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'border-transparent text-white'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
                style={active ? { backgroundColor: COLORS[idx % COLORS.length] } : {}}>
                {c.name}
              </button>
            );
          })}
        </div>
        {selected.length < 2 && (
          <p className="text-xs text-gray-400 mt-3">👆 Chọn ít nhất 2 công ty để xem so sánh</p>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-600" />
        </div>
      )}

      {result && !loading && (
        <>
          {/* KPI comparison table */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">
                So Sánh KPI — Tháng {result.period.month}/{result.period.year}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-2 font-medium text-gray-500 w-32">Chỉ tiêu</th>
                    {result.companies.map((c, i) => (
                      <th key={c.id} className="text-right px-4 py-2 font-semibold"
                        style={{ color: COLORS[i % COLORS.length] }}>
                        {c.name.split(' ').slice(-1)[0]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {METRICS.map(({ key, label, fmt, bestHigher }) => {
                    const vals = result.companies.map((c) => Number(c[key as keyof CompanyStat]));
                    const best = bestHigher ? Math.max(...vals) : Math.min(...vals);
                    const worst = bestHigher ? Math.min(...vals) : Math.max(...vals);
                    return (
                      <tr key={key}>
                        <td className="px-4 py-2.5 text-gray-500 font-medium">{label}</td>
                        {vals.map((v, i) => (
                          <td key={i} className={`px-4 py-2.5 text-right font-semibold ${
                            v === best ? 'text-emerald-600' : v === worst && vals.length > 1 ? 'text-red-500' : 'text-gray-700'
                          }`}>
                            {fmt(v)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Revenue trend multi-line */}
          {trendData.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Xu Hướng Doanh Thu 12 Tháng (triệu ₫)</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={trendData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 10 }} width={45} />
                  <Tooltip formatter={(val: number) => `${val.toLocaleString('vi-VN')} triệu`} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {result.companies.map((c, i) => (
                    <Line key={c.id} type="monotone" dataKey={c.name}
                      stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* VAT comparison bar chart */}
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">VAT Phải Nộp (triệu ₫)</h2>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart
                data={result.companies.map((c, i) => ({
                  name: c.name.split(' ').slice(-1)[0],
                  vat: Math.round(Number(c.payable_vat) / 1_000_000),
                  fill: COLORS[i % COLORS.length],
                }))}
                margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip formatter={(val: number) => `${val.toLocaleString('vi-VN')} triệu`} />
                <Bar dataKey="vat" name="VAT" radius={[4, 4, 0, 0]} maxBarSize={40}
                  fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
