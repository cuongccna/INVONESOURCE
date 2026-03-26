'use client';

import { useEffect, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import apiClient from '../../../../lib/apiClient';

interface MonthlyTrend {
  period_year: number;
  period_month: number;
  revenue: string;
  cost: string;
  output_vat: string;
  input_vat: string;
  payable_vat: string;
  invoice_count: string;
  valid_count: string;
  invalid_count: string;
  unvalidated_count: string;
  avg_invoice_value: string;
}

interface TopItem {
  buyer_name?: string;
  seller_name?: string;
  total_revenue?: string;
  total_spend?: string;
}

interface TrendsData {
  monthly: MonthlyTrend[];
  topCustomers: TopItem[];
  topSuppliers: TopItem[];
}

import { formatVNDShort, formatVND } from '../../../../utils/formatCurrency';

const fmtM = formatVNDShort;

const MONTH_LABELS = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12'];

export default function TrendsPage() {
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(12);
  const [error, setError] = useState(false);

  const load = async (m: number) => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiClient.get<{ data: TrendsData }>(`/reports/trends?months=${m}`);
      setData(res.data.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(months); }, [months]);

  const chartData = (data?.monthly ?? []).map((r) => ({
    label: `${MONTH_LABELS[r.period_month - 1]}/${String(r.period_year).slice(2)}`,
    revenue: Number(r.revenue),
    cost: Number(r.cost),
    outputVat: Number(r.output_vat),
    inputVat: Number(r.input_vat),
    payableVat: Math.max(0, Number(r.payable_vat)),
    valid: Number(r.valid_count),
    invalid: Number(r.invalid_count),
    unvalidated: Number(r.unvalidated_count),
  }));

  // Seasonal analysis: which months are above average
  const avgRevenue = chartData.length > 0
    ? chartData.reduce((s, d) => s + d.revenue, 0) / chartData.length
    : 0;

  const topCustomers = data?.topCustomers ?? [];
  const topSuppliers = data?.topSuppliers ?? [];
  const maxCustomerRevenue = topCustomers.reduce((m, c) => Math.max(m, Number(c.total_revenue ?? 0)), 0);
  const maxSupplierSpend = topSuppliers.reduce((m, s) => Math.max(m, Number(s.total_spend ?? 0)), 0);

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-6 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Phân Tích Xu Hướng</h1>
          <p className="text-sm text-gray-500">Doanh thu, chi phí, VAT theo tháng</p>
        </div>
        <div className="flex items-center gap-2">
          {([3, 6, 12, 24] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                months === m ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {m}T
            </button>
          ))}
          <button
            onClick={() => window.print()}
            className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 ml-2 print:hidden"
          >
            🖨 Tải báo cáo
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : error ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-3xl mb-2">⚠️</p>
          <p>Không thể tải dữ liệu xu hướng</p>
        </div>
      ) : chartData.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📊</p>
          <p className="font-medium text-gray-600">Chưa có dữ liệu để hiển thị xu hướng</p>
          <p className="text-sm mt-1">Đồng bộ hóa đơn để bắt đầu phân tích</p>
        </div>
      ) : (
        <>
          {/* Section 1: Revenue vs Cost area chart */}
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-base font-semibold text-gray-800 mb-4">Doanh Thu vs Chi Phí</h2>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6b7280" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#6b7280" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={fmtM} tick={{ fontSize: 10 }} width={55} />
                <Tooltip
                  formatter={(val: number, name: string) => [fmtM(val), name === 'revenue' ? 'Doanh thu' : 'Chi phí']}
                  labelStyle={{ fontWeight: 600 }}
                />
                <Legend formatter={(v) => v === 'revenue' ? 'Doanh thu' : 'Chi phí'} wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="revenue" stroke="#3b82f6" strokeWidth={2}
                  fill="url(#gradRevenue)" dot={false}
                  activeDot={{ r: 4, fill: '#3b82f6' }}
                />
                <Area type="monotone" dataKey="cost" stroke="#9ca3af" strokeWidth={2}
                  fill="url(#gradCost)" dot={false}
                  activeDot={{ r: 4, fill: '#6b7280' }}
                />
              </AreaChart>
            </ResponsiveContainer>

            {/* Seasonal highlights */}
            {avgRevenue > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {chartData
                  .filter((d) => d.revenue > avgRevenue * 1.2)
                  .slice(0, 3)
                  .map((d) => (
                    <span key={d.label} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      📈 Cao điểm: {d.label}
                    </span>
                  ))}
              </div>
            )}
          </div>

          {/* Section 2: VAT grouped bar chart */}
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-base font-semibold text-gray-800 mb-4">VAT Đầu Ra vs Đầu Vào</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData.slice(-6)} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={fmtM} tick={{ fontSize: 10 }} width={50} />
                <Tooltip
                  formatter={(val: number, name: string) => [
                    fmtM(val),
                    name === 'outputVat' ? 'VAT đầu ra' : name === 'inputVat' ? 'VAT đầu vào' : 'Phải nộp',
                  ]}
                />
                <Legend
                  formatter={(v) => v === 'outputVat' ? 'VAT đầu ra' : v === 'inputVat' ? 'VAT đầu vào' : 'Phải nộp'}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="outputVat" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                <Bar dataKey="inputVat" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="payableVat" fill="#ef4444" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Section 3: Top customers & suppliers */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Top customers */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-base font-semibold text-gray-800 mb-3">Top 5 Khách Hàng</h2>
              {topCustomers.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Chưa có dữ liệu</p>
              ) : (
                <div className="space-y-2">
                  {topCustomers.map((c, i) => {
                    const val = Number(c.total_revenue ?? 0);
                    const pct = maxCustomerRevenue > 0 ? (val / maxCustomerRevenue) * 100 : 0;
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="text-gray-700 truncate max-w-[60%]">{c.buyer_name}</span>
                          <span className="text-gray-500 font-medium">{fmtM(val)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Top suppliers */}
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-base font-semibold text-gray-800 mb-3">Top 5 Nhà Cung Cấp</h2>
              {topSuppliers.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Chưa có dữ liệu</p>
              ) : (
                <div className="space-y-2">
                  {topSuppliers.map((s, i) => {
                    const val = Number(s.total_spend ?? 0);
                    const pct = maxSupplierSpend > 0 ? (val / maxSupplierSpend) * 100 : 0;
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between text-xs mb-0.5">
                          <span className="text-gray-700 truncate max-w-[60%]">{s.seller_name}</span>
                          <span className="text-gray-500 font-medium">{fmtM(val)}</span>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Section 4: Invoice health trend */}
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-base font-semibold text-gray-800 mb-4">Tình Trạng Hóa Đơn Theo Tháng</h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData.slice(-6)} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={35} />
                <Tooltip
                  formatter={(val: number, name: string) => [
                    val,
                    name === 'valid' ? 'Hợp lệ' : name === 'unvalidated' ? 'Chờ xác thực' : 'Không hợp lệ',
                  ]}
                />
                <Legend
                  formatter={(v) => v === 'valid' ? 'Hợp lệ' : v === 'unvalidated' ? 'Chờ xác thực' : 'Không hợp lệ'}
                  wrapperStyle={{ fontSize: 11 }}
                />
                <Bar dataKey="valid" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                <Bar dataKey="unvalidated" stackId="a" fill="#f59e0b" />
                <Bar dataKey="invalid" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
