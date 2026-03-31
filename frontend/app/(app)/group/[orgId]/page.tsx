'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { formatVND, formatVNDShort } from '../../../../utils/formatCurrency';
import apiClient from '../../../../lib/apiClient';

const compact = (n: number) =>
  formatVND(n);
const mVnd = formatVND;

interface EntitySummary {
  company_id: string;
  company_name: string;
  tax_code: string;
  level: number;
  entity_type: string;
  output_invoices: string;
  input_invoices: string;
  output_total: string;
  input_total: string;
  payable_vat: string;
}

interface GroupKpi {
  organization_id: string;
  total_entities: number;
  total_output: number;
  total_input: number;
  total_output_vat: number;
  total_input_vat: number;
  total_payable_vat: number;
  total_unvalidated: number;
  inter_company_excluded: number;
  period: { month: number; year: number };
  by_entity: EntitySummary[];
}

interface TrendRow {
  month: number;
  year: number;
  output_total: number;
  input_total: number;
  payable_vat: number;
  inter_company_excluded: number;
}

const LEVEL_LABEL: Record<number, string> = { 1: 'TCT', 2: 'CT Con', 3: 'Chi Nhánh' };
const LEVEL_COLOR: Record<number, string> = {
  1: 'bg-purple-100 text-purple-700',
  2: 'bg-blue-100 text-blue-700',
  3: 'bg-gray-100 text-gray-600',
};

export default function GroupDashboardPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [kpi, setKpi] = useState<GroupKpi | null>(null);
  const [trend, setTrend] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());

  const load = useCallback(async (m: number, y: number) => {
    setLoading(true);
    try {
      const [kpiRes, trendRes] = await Promise.all([
        apiClient.get<{ data: GroupKpi }>(`/group/${orgId}/kpi?month=${m}&year=${y}`),
        apiClient.get<{ data: TrendRow[] }>(`/group/${orgId}/trend`),
      ]);
      setKpi(kpiRes.data.data);
      setTrend(trendRes.data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(month, year); }, [load, month, year]);

  const chartData = trend.map((r) => ({
    name: `T${r.month}/${String(r.year).slice(2)}`,
    'Doanh thu': Math.round(r.output_total / 1_000_000),
    'Chi phí': Math.round(r.input_total / 1_000_000),
    'VAT nộp': Math.round(r.payable_vat / 1_000_000),
  }));

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase bg-emerald-50 text-emerald-700">group</span>
            <h1 className="text-2xl font-bold text-gray-900">Báo Cáo Hợp Nhất</h1>
          </div>
          {kpi && (
            <p className="text-sm text-gray-500 mt-0.5">
              {kpi.total_entities} đơn vị thành viên · Tháng {month}/{year}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>T{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            {[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
        </div>
      ) : kpi ? (
        <>
          {/* Inter-company notice */}
          {kpi.inter_company_excluded > 0 && (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-100 rounded-xl px-4 py-2.5 text-xs text-blue-700">
              <span className="text-base">ℹ️</span>
              <span>
                <strong>{kpi.inter_company_excluded.toLocaleString('vi-VN')}</strong> giao dịch nội bộ đã được loại trừ khỏi số liệu hợp nhất.
              </span>
            </div>
          )}

          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Doanh Thu (hợp nhất)', value: `${compact(kpi.total_output)} ₫`, color: 'text-gray-900' },
              { label: 'Chi Phí (hợp nhất)', value: `${compact(kpi.total_input)} ₫`, color: 'text-gray-900' },
              { label: 'VAT Phải Nộp', value: `${compact(kpi.total_payable_vat)} ₫`, color: kpi.total_payable_vat > 0 ? 'text-red-600' : 'text-gray-400' },
              { label: 'Chờ Xác Thực GDT', value: kpi.total_unvalidated.toLocaleString('vi-VN'), color: 'text-yellow-600' },
            ].map((c) => (
              <div key={c.label} className="bg-white rounded-xl shadow-sm p-4">
                <p className="text-xs text-gray-500 mb-1">{c.label}</p>
                <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {/* Trend Chart */}
          {chartData.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Xu Hướng 12 Tháng — Hợp Nhất (triệu ₫)</h2>
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={chartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="grDt" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="grCp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#94a3b8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
                  <Tooltip formatter={(val: number) => formatVND(Number(val) * 1_000_000)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="Doanh thu" stroke="#10b981" fill="url(#grDt)" strokeWidth={2} dot={false} />
                  <Area type="monotone" dataKey="Chi phí" stroke="#94a3b8" fill="url(#grCp)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Entity breakdown */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-700">Đơn Vị Thành Viên</h2>
            </div>
            <div className="divide-y divide-gray-50">
              {kpi.by_entity.map((e) => (
                <div key={e.company_id} className="px-4 py-3 flex items-center gap-3">
                  <div className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${LEVEL_COLOR[e.level] ?? 'bg-gray-100 text-gray-500'}`}>
                    {LEVEL_LABEL[e.level] ?? `L${e.level}`}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{e.company_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{e.tax_code}</p>
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <p className="text-sm font-bold text-gray-900">{mVnd(Number(e.output_total))}</p>
                    <p className={`text-xs font-semibold ${Number(e.payable_vat) > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      VAT: {mVnd(Number(e.payable_vat))}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-20 text-gray-400">
          <p>Tổ chức không tồn tại hoặc bạn không có quyền truy cập</p>
          <Link href="/portfolio" className="text-sm text-primary-600 mt-2 block">
            Về danh mục
          </Link>
        </div>
      )}
    </div>
  );
}
