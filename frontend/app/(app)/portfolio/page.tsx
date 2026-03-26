'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatVND, formatVNDShort } from '../../../utils/formatCurrency';
import apiClient from '../../../lib/apiClient';
import { useView } from '../../../contexts/ViewContext';

const compact = (n: number) =>
  formatVND(n);
const mVnd = formatVND;

interface CompanySummary {
  company_id: string;
  company_name: string;
  tax_code: string;
  output_invoices: string;
  input_invoices: string;
  output_total: string;
  input_total: string;
  output_vat: string;
  input_vat: string;
  payable_vat: string;
  unvalidated_count: string;
}

interface PortfolioKpi {
  total_companies: number;
  total_invoices: number;
  total_output: number;
  total_input: number;
  total_output_vat: number;
  total_input_vat: number;
  total_payable_vat: number;
  total_unvalidated: number;
  period: { month: number; year: number };
  by_company: CompanySummary[];
}

interface TrendRow {
  month: number;
  year: number;
  output_total: number;
  input_total: number;
  output_vat: number;
  input_vat: number;
  payable_vat: number;
}

export default function PortfolioPage() {
  const { orgId } = useView();
  const [kpi, setKpi] = useState<PortfolioKpi | null>(null);
  const [trend, setTrend] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());

  const load = useCallback(async (m: number, y: number) => {
    setLoading(true);
    try {
      const orgParam = orgId ? `&organizationId=${orgId}` : '';
      const [kpiRes, trendRes] = await Promise.all([
        apiClient.get<{ data: PortfolioKpi }>(`/portfolio/kpi?month=${m}&year=${y}${orgParam}`),
        apiClient.get<{ data: TrendRow[] }>(`/portfolio/trend${orgId ? `?organizationId=${orgId}` : ''}`),
      ]);
      setKpi(kpiRes.data.data);
      setTrend(trendRes.data.data);
    } catch {
      // silent error
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(month, year); }, [load, month, year]);

  const trendChartData = trend.map((r) => ({
    name: `T${r.month}/${String(r.year).slice(2)}`,
    'Doanh thu': Math.round(r.output_total / 1_000_000),
    'Chi phí': Math.round(r.input_total / 1_000_000),
    'VAT nộp': Math.round(r.payable_vat / 1_000_000),
  }));

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years = [year - 1, year, year + 1];

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase bg-amber-50 text-amber-700">portfolio</span>
            <h1 className="text-2xl font-bold text-gray-900">Danh Mục Doanh Nghiệp</h1>
          </div>
          {kpi && (
            <p className="text-sm text-gray-500 mt-0.5">
              {kpi.total_companies} công ty · Tháng {month}/{year}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          >
            {months.map((m) => <option key={m} value={m}>T{m}</option>)}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500" />
        </div>
      ) : kpi ? (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Tổng Doanh Thu', value: `${compact(kpi.total_output)} ₫`, sub: `${kpi.total_companies} công ty`, color: 'text-gray-900' },
              { label: 'Tổng Chi Phí', value: `${compact(kpi.total_input)} ₫`, sub: 'Hóa đơn đầu vào', color: 'text-gray-900' },
              { label: 'VAT Phải Nộp', value: `${compact(kpi.total_payable_vat)} ₫`, sub: 'Tổng hợp toàn bộ', color: kpi.total_payable_vat > 0 ? 'text-red-600' : 'text-gray-400' },
              { label: 'Chờ Xác Thực GDT', value: kpi.total_unvalidated.toLocaleString('vi-VN'), sub: 'Hóa đơn toàn hệ thống', color: 'text-yellow-600' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-xl shadow-sm p-4">
                <p className="text-xs text-gray-500 mb-1">{c.label}</p>
                <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
                <p className="text-xs text-gray-400 mt-0.5">{c.sub}</p>
              </div>
            ))}
          </div>

          {/* Trend Chart */}
          {trendChartData.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Xu Hướng 12 Tháng (triệu ₫)</h2>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={trendChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
                  <Tooltip formatter={(val: number) => formatVND(Number(val) * 1_000_000)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Doanh thu" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={16} />
                  <Bar dataKey="Chi phí" fill="#94a3b8" radius={[3, 3, 0, 0]} maxBarSize={16} />
                  <Bar dataKey="VAT nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={16} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Per-company breakdown */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">Chi Tiết Theo Công Ty</h2>
            </div>
            <div className="divide-y divide-gray-50">
              {kpi.by_company.map((c) => (
                <div key={c.company_id} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{c.company_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{c.tax_code}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {Number(c.output_invoices)} bán ra · {Number(c.input_invoices)} mua vào
                    </p>
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <p className="text-sm font-bold text-gray-900">{mVnd(Number(c.output_total))}</p>
                    <p className={`text-xs font-semibold ${Number(c.payable_vat) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      VAT: {mVnd(Number(c.payable_vat))}
                    </p>
                    {Number(c.unvalidated_count) > 0 && (
                      <Link
                        href={`/invoices?gdt=pending&company=${c.company_id}`}
                        className="text-xs text-yellow-600 underline"
                      >
                        {c.unvalidated_count} chưa xác thực
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-20 text-gray-400">
          <p>Không có dữ liệu</p>
          <Link href="/settings/companies" className="text-sm text-primary-600 mt-2 block">
            Thêm công ty
          </Link>
        </div>
      )}
    </div>
  );
}
