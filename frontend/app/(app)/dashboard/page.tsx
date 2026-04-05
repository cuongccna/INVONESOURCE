'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Line, ComposedChart, Cell,
} from 'recharts';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface KpiData {
  period: { month: number; year: number };
  invoices: {
    total: string; output_count: string; input_count: string;
    invalid_count: string; unvalidated_count: string;
  };
  vat: { output_vat: string; input_vat: string; payable_vat: string } | null;
  recentSyncs: Array<{
    provider: string; errors_count: number; started_at: string; error_detail: string | null;
  }>;
}

interface ChartData {
  vatTrend: Array<{ period_month: number; period_year: number; output_vat: string; input_vat: string; payable_vat: string }>;
  invoiceTrend: Array<{ month: number; year: number; output_count: string; input_count: string; output_total: string; input_total: string }>;
}

interface AnomalyItem {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  type: string;
  description: string;
  amount: number;
  sellerName: string;
  risk: string;
  explanation: string;
  action: string;
}

interface AnomalyReport {
  totalAnomalies: number;
  anomalies: AnomalyItem[];
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const PROVIDER_LABELS: Record<string, string> = {
  misa: 'MISA', viettel: 'Viettel', bkav: 'BKAV', gdt_intermediary: 'GDT',
};
/* ─── Formatters ──────────────────────────────────────────────────────────── */
import { formatVND, formatVNDShort, formatVNDFull } from '../../../utils/formatCurrency';

const compact = formatVND;
const full = (n: string | number) => Number(n).toLocaleString('vi-VN');
function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diff < 1) return 'vừa xong';
  if (diff < 60) return `${diff} phút trước`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)}d trước`;
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */
function KCard({ label, value, sub, color = 'text-gray-900' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}



interface VatForecast {
  forecast_output_vat: number;
  forecast_input_vat: number;
  forecast_payable: number;
  carry_forward: number;
  net_forecast: number;
  periods_used: number;
  confidence_note: string;
}

interface EsgWidgetData {
  total_tco2e: number;
  by_category: Array<{ category_name: string; tco2e: number }>;
}

interface GhostSummary {
  critical: number;
  high: number;
  medium: number;
  total_vat_at_risk: number;
  acknowledged: number;
  total: number;
}

interface QuickAction {
  key: string;
  icon: string;
  label: string;
  href: string;
  count?: number;
  color: string;
}

export default function DashboardPage() {
  const { activeCompanyId } = useCompany();
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyReport | null>(null);
  const [loadingAnomalies, setLoadingAnomalies] = useState(false);
  const [forecast, setForecast] = useState<VatForecast | null>(null);
  const [esg, setEsg] = useState<EsgWidgetData | null>(null);
  const [ghostSummary, setGhostSummary] = useState<GhostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [quickActions, setQuickActions] = useState<QuickAction[]>([]);
  const [vatViewMode, setVatViewMode] = useState<'monthly' | 'quarterly'>('monthly');

  // Period navigator: default to current month/year
  const now = new Date();
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(now.getFullYear());

  const quarterOf     = (m: number) => Math.ceil(m / 3);
  const quarterStart  = (q: number) => (q - 1) * 3 + 1;

  const handleVatViewMode = (mode: 'monthly' | 'quarterly') => {
    setVatViewMode(mode);
    if (mode === 'quarterly') {
      // Snap periodMonth to the first month of the current quarter
      setPeriodMonth(quarterStart(quarterOf(periodMonth)));
    }
  };

  const navigatePeriod = (delta: number) => {
    if (vatViewMode === 'quarterly') {
      let q = quarterOf(periodMonth) + delta;
      let y = periodYear;
      if (q < 1) { y -= 1; q = 4; }
      if (q > 4) { y += 1; q = 1; }
      setPeriodMonth(quarterStart(q));
      setPeriodYear(y);
    } else {
      let newMonth = periodMonth + delta;
      let newYear = periodYear;
      if (newMonth < 1)  { newYear -= 1; newMonth = 12; }
      if (newMonth > 12) { newYear += 1; newMonth = 1; }
      setPeriodMonth(newMonth);
      setPeriodYear(newYear);
    }
  };

  const load = useCallback(async (month = periodMonth, year = periodYear) => {
    try {
      const [kpiRes, chartRes, forecastRes] = await Promise.all([
        apiClient.get<{ data: KpiData }>(`/dashboard/kpi?month=${month}&year=${year}`),
        apiClient.get<{ data: ChartData }>(`/dashboard/charts?month=${month}&year=${year}`),
        apiClient.get<{ data: VatForecast }>('/forecast/vat').catch(() => ({ data: { data: null } })),
      ]);
      setKpi(kpiRes.data.data);
      setChart(chartRes.data.data);
      setForecast((forecastRes as { data: { data: VatForecast | null } }).data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [periodMonth, periodYear]);

  useEffect(() => { void load(); }, [load, activeCompanyId]);

  useEffect(() => {
    setLoading(true);
    void load(periodMonth, periodYear);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodMonth, periodYear]);

  useEffect(() => {
    apiClient.get<{ data: { actions: QuickAction[] } }>('/dashboard/quick-actions')
      .then((res) => setQuickActions(res.data.data.actions))
      .catch(() => {});
  }, [activeCompanyId]);

  useEffect(() => {
    const year = new Date().getFullYear();
    apiClient
      .get<{ data: EsgWidgetData }>(`/esg/estimate?year=${year}`)
      .then((res) => setEsg(res.data.data))
      .catch(() => setEsg(null));
  }, [activeCompanyId]);

  useEffect(() => {
    apiClient
      .get<{ data: GhostSummary }>('/audit/ghost-companies/summary')
      .then((res) => setGhostSummary(res.data.data))
      .catch(() => setGhostSummary(null));
  }, [activeCompanyId]);

  const detectAnomalies = async () => {
    setLoadingAnomalies(true);
    try {
      const now = new Date();
      const res = await apiClient.get<{ data: AnomalyReport }>(
        `/ai/anomalies?month=${now.getMonth() + 1}&year=${now.getFullYear()}`
      );
      setAnomalies(res.data.data);
    } catch {
      // silent
    } finally {
      setLoadingAnomalies(false);
    }
  };

  /* ── Chart data ── */
  const vatChartData = chart?.vatTrend.map((r) => ({
    name: `T${r.period_month}/${String(r.period_year).slice(2)}`,
    'Đầu Ra': Math.round(Number(r.output_vat) / 1_000_000),
    'Đầu Vào': Math.round(Number(r.input_vat) / 1_000_000),
    'Phải Nộp': Math.round(Number(r.payable_vat) / 1_000_000),
  })) ?? [];

  /* P&L chart: revenue, cost, gross profit per month */
  const plChartData = chart?.invoiceTrend.map((r) => ({
    name: `T${r.month}/${String(r.year).slice(2)}`,
    'Doanh Thu': Math.round(Number(r.output_total) / 1_000_000),
    'Chi Phí': Math.round(Number(r.input_total) / 1_000_000),
    'Lãi Gộp': Math.round((Number(r.output_total) - Number(r.input_total)) / 1_000_000),
  })) ?? [];

  /* VAT quarterly grouping */
  const vatQuarterlyData = (() => {
    if (!chart?.vatTrend.length) return [] as typeof vatChartData;
    const qMap: Record<string, { name: string; 'Đầu Ra': number; 'Đầu Vào': number; 'Phải Nộp': number }> = {};
    chart.vatTrend.forEach((r) => {
      const q = Math.ceil(r.period_month / 3);
      const key = `Q${q}/${String(r.period_year).slice(2)}`;
      if (!qMap[key]) qMap[key] = { name: key, 'Đầu Ra': 0, 'Đầu Vào': 0, 'Phải Nộp': 0 };
      qMap[key]['Đầu Ra']   += Math.round(Number(r.output_vat)  / 1_000_000);
      qMap[key]['Đầu Vào']  += Math.round(Number(r.input_vat)   / 1_000_000);
      qMap[key]['Phải Nộp'] += Math.round(Number(r.payable_vat) / 1_000_000);
    });
    return Object.values(qMap);
  })();
  const activeVatData = vatViewMode === 'monthly' ? vatChartData : vatQuarterlyData;

  /* CIT (Corporate Income Tax) annual estimate — 20% on gross profit */
  const citYearData = chart?.invoiceTrend.filter(r => r.year === periodYear) ?? [];
  const annualRevenue   = citYearData.reduce((s, r) => s + Number(r.output_total), 0);
  const annualCost      = citYearData.reduce((s, r) => s + Number(r.input_total),  0);
  const annualProfit    = annualRevenue - annualCost;
  const estimatedCIT    = Math.max(0, annualProfit * 0.20);
  const monthsWithData  = citYearData.length;
  const projectedAnnualProfit = monthsWithData > 0 ? (annualProfit / monthsWithData) * 12 : 0;
  const projectedCIT    = Math.max(0, projectedAnnualProfit * 0.20);
  const citMonthlyData  = citYearData.map((r) => ({
    name: `T${r.month}`,
    'Lãi Gộp': Math.round((Number(r.output_total) - Number(r.input_total)) / 1_000_000),
  }));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tổng Quan</h1>
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-gray-400 hover:text-gray-700"
          title="Làm mới"
        >
          ↻ Làm mới
        </button>
      </div>

      {/* ── Period Navigator ── */}
      <div className="bg-white rounded-xl shadow-sm px-4 py-2.5 flex items-center justify-between gap-2">
        <button
          onClick={() => navigatePeriod(-1)}
          className="text-gray-500 hover:text-gray-900 text-lg font-bold px-2 py-0.5 rounded hover:bg-gray-100 transition-colors"
          aria-label="Kỳ trước"
        >
          ‹
        </button>
        <div className="flex flex-col items-center gap-1">
          <p className="text-sm font-semibold text-gray-800">
            Kỳ kê khai:{' '}
            {vatViewMode === 'quarterly'
              ? `Quý ${quarterOf(periodMonth)}/${periodYear}`
              : `Tháng ${periodMonth}/${periodYear}`}
          </p>
          {/* Tháng / Quý toggle — shared with bottom chart */}
          <div className="flex gap-0.5 bg-gray-100 rounded-lg p-0.5">
            {(['monthly', 'quarterly'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleVatViewMode(mode)}
                className={`text-xs px-2.5 py-0.5 rounded-md font-medium transition-colors ${
                  vatViewMode === mode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {mode === 'monthly' ? 'Tháng' : 'Quý'}
              </button>
            ))}
          </div>
          {(() => {
            const nowQ = quarterOf(now.getMonth() + 1);
            const curQ = quarterOf(periodMonth);
            const isCurrentPeriod = vatViewMode === 'quarterly'
              ? (curQ === nowQ && periodYear === now.getFullYear())
              : (periodMonth === now.getMonth() + 1 && periodYear === now.getFullYear());
            const resetPeriod = () => {
              const m = now.getMonth() + 1;
              setPeriodYear(now.getFullYear());
              setPeriodMonth(vatViewMode === 'quarterly' ? quarterStart(quarterOf(m)) : m);
            };
            return isCurrentPeriod ? (
              <p className="text-xs text-gray-400">
                {vatViewMode === 'quarterly' ? 'Quý hiện tại' : 'Tháng hiện tại'}
              </p>
            ) : (
              <button onClick={resetPeriod} className="text-xs text-primary-600 hover:underline">
                {vatViewMode === 'quarterly' ? 'Về quý hiện tại' : 'Về tháng hiện tại'}
              </button>
            );
          })()}
        </div>
        <button
          onClick={() => navigatePeriod(1)}
          className="text-gray-500 hover:text-gray-900 text-lg font-bold px-2 py-0.5 rounded hover:bg-gray-100 transition-colors"
          aria-label="Kỳ sau"
        >
          ›
        </button>
      </div>

      {/* ── KPI Cards ── */}
      {kpi && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KCard
            label="Tổng Hóa Đơn"
            value={full(kpi.invoices.total)}
            sub={`Ra: ${kpi.invoices.output_count} · Vào: ${kpi.invoices.input_count}`}
          />
          <KCard
            label="Thuế GTGT Phải Nộp"
            value={kpi.vat ? `${compact(kpi.vat.payable_vat)} ₫` : '—'}
            sub="Hạn: ngày 20 tháng sau"
            color={kpi.vat && Number(kpi.vat.payable_vat) > 0 ? 'text-red-600' : 'text-gray-400'}
          />
          <KCard
            label="Thuế Đầu Vào"
            value={kpi.vat ? `${compact(kpi.vat.input_vat)} ₫` : '—'}
            sub="Được khấu trừ kỳ này"
            color="text-green-600"
          />
        </div>
      )}

      {/* ── Charts grid — side by side on desktop ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ── VAT Trend ── */}
      {vatChartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Biến Động Thuế GTGT</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={vatChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
              <Tooltip formatter={(val: number) => formatVNDFull(Number(val) * 1_000_000)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Đầu Ra" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Bar dataKey="Đầu Vào" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Bar dataKey="Phải Nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Revenue Trend replaced by P&L chart ── */}
      {plChartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-1">📊 Lãi / Lỗ Tạm Thời</h2>
          <p className="text-xs text-gray-400 mb-3">Doanh thu bán ra − chi phí mua vào (chưa trừ thuế, lương, khấu hao)</p>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={plChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
              <Tooltip formatter={(val: number) => formatVNDFull(Number(val) * 1_000_000)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Doanh Thu" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Bar dataKey="Chi Phí" fill="#f87171" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Line type="monotone" dataKey="Lãi Gộp" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      </div>{/* end charts grid */}

      {/* ── VAT Payable Monthly/Quarterly ── */}
      {(vatChartData.length > 0 || vatQuarterlyData.length > 0) && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">💰 Thuế GTGT Phải Nộp</h2>
            <span className="text-xs text-gray-400">{vatViewMode === 'quarterly' ? 'Theo quý' : 'Theo tháng'}</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={activeVatData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
              <Tooltip formatter={(val: number) => formatVNDFull(Number(val) * 1_000_000)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Đầu Ra" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="Đầu Vào" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="Phải Nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── CIT Annual Estimate ── */}
      {citYearData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-gray-700">🏗️ Thuế TNDN Ước Tính Năm {periodYear}</h2>
            <span className="text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full font-medium">Thuế suất 20%</span>
          </div>
          <p className="text-xs text-gray-400 mb-3">Dựa trên hóa đơn — chưa trừ chi phí nhân công, khấu hao, lãi vay và các khoản ưu đãi</p>

          {/* Summary KPIs */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <div className="bg-blue-50 rounded-lg p-2.5">
              <p className="text-xs text-blue-500 mb-0.5">Doanh thu YTD</p>
              <p className="text-sm font-bold text-blue-800">{compact(annualRevenue)}₫</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-2.5">
              <p className="text-xs text-gray-400 mb-0.5">Chi phí YTD</p>
              <p className="text-sm font-bold text-gray-700">{compact(annualCost)}₫</p>
            </div>
            <div className={`rounded-lg p-2.5 ${annualProfit >= 0 ? 'bg-green-50' : 'bg-red-50'}`}>
              <p className={`text-xs mb-0.5 ${annualProfit >= 0 ? 'text-green-500' : 'text-red-500'}`}>Lãi gộp YTD</p>
              <p className={`text-sm font-bold ${annualProfit >= 0 ? 'text-green-800' : 'text-red-800'}`}>
                {compact(annualProfit)}₫
              </p>
            </div>
          </div>

          {/* CIT estimate banner */}
          <div className={`flex items-center justify-between rounded-lg px-4 py-3 mb-3 ${
            estimatedCIT > 0 ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200'
          }`}>
            <div>
              <p className="text-xs font-medium text-gray-600">Thuế TNDN phát sinh YTD ({monthsWithData} tháng)</p>
              <p className={`text-xl font-bold ${estimatedCIT > 0 ? 'text-amber-700' : 'text-green-700'}`}>
                {compact(estimatedCIT)}₫
              </p>
            </div>
            {monthsWithData < 12 && projectedCIT > 0 && (
              <div className="text-right">
                <p className="text-xs text-gray-400">Dự báo cả năm</p>
                <p className="text-sm font-semibold text-gray-600">{compact(projectedCIT)}₫</p>
              </div>
            )}
          </div>

          {/* Monthly profit bar chart */}
          {citMonthlyData.length > 0 && (
            <ResponsiveContainer width="100%" height={130}>
              <BarChart data={citMonthlyData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v * 1_000_000)} />
                <Tooltip
                  formatter={(val: number) => [formatVNDFull(Number(val) * 1_000_000), 'Lãi Gộp']}
                  labelFormatter={(label) => `Tháng ${label}`}
                />
                <Bar dataKey="Lãi Gộp" radius={[3, 3, 0, 0]} maxBarSize={22}>
                  {citMonthlyData.map((entry, i) => (
                    <Cell key={i} fill={(entry['Lãi Gộp'] ?? 0) >= 0 ? '#10b981' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          <p className="text-xs text-amber-600 mt-2">
            ⚠️ Chỉ mang tính tham khảo — chưa qua kiểm toán thuế chính thức
          </p>
        </div>
      )}

      {/* ── Recent Syncs ── */}
      {kpi?.recentSyncs && kpi.recentSyncs.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700">Đồng Bộ Gần Đây</h2>
            <Link href="/settings/sync-logs" className="text-xs text-primary-600 hover:underline">
              Xem tất cả →
            </Link>
          </div>
          <div className="space-y-2">
            {kpi.recentSyncs.slice(0, 5).map((s, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  {s.errors_count > 0
                    ? <span className="text-red-500">⚠</span>
                    : <span className="text-green-500">✓</span>
                  }
                  <span className="font-medium text-gray-700">
                    {PROVIDER_LABELS[s.provider] ?? s.provider}
                  </span>
                </div>
                <span className="text-xs text-gray-400">{timeAgo(s.started_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── AI Anomaly Detection ── */}
      <div className="bg-white rounded-xl shadow-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">🔍 Phát Hiện Bất Thường AI</h2>
            <p className="text-xs text-gray-400">Gemini phân tích hóa đơn kỳ này</p>
          </div>
          <button
            onClick={() => void detectAnomalies()}
            disabled={loadingAnomalies}
            className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-100 disabled:opacity-60 transition-colors"
          >
            {loadingAnomalies ? 'Đang phân tích...' : '▶ Phân tích'}
          </button>
        </div>

        {!anomalies && !loadingAnomalies && (
          <p className="text-sm text-gray-400 text-center py-3">
            Nhấn "Phân tích" để Gemini AI kiểm tra hóa đơn bất thường
          </p>
        )}

        {loadingAnomalies && (
          <div className="flex items-center gap-3 py-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-600" />
            <p className="text-sm text-gray-500">Đang phân tích dữ liệu hóa đơn...</p>
          </div>
        )}

        {anomalies && !loadingAnomalies && (
          <div className="space-y-3">
            {anomalies.totalAnomalies === 0 ? (
              <div className="flex items-center gap-2 bg-green-50 rounded-xl px-4 py-3">
                <span className="text-xl">✅</span>
                <p className="text-sm text-green-700 font-medium">Không phát hiện bất thường kỳ này</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 bg-orange-50 rounded-xl px-3 py-2">
                  <span className="text-lg">⚠️</span>
                  <p className="text-sm text-orange-700 font-medium">
                    Phát hiện <strong>{anomalies.totalAnomalies}</strong> điểm bất thường
                  </p>
                </div>
                {anomalies.anomalies.slice(0, 3).map((a, i) => (
                  <div key={i} className="border border-gray-100 rounded-xl p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        a.risk === 'HIGH' ? 'bg-red-100 text-red-700'
                        : a.risk === 'MEDIUM' ? 'bg-orange-100 text-orange-700'
                        : 'bg-yellow-100 text-yellow-700'
                      }`}>{a.risk}</span>
                      <span className="text-xs text-gray-400">{a.type}</span>
                    </div>
                    <p className="text-sm text-gray-800 font-medium">{a.sellerName}</p>
                    <p className="text-xs text-gray-600">{a.explanation}</p>
                    <Link
                      href={`/invoices?search=${encodeURIComponent(a.invoiceNumber)}&direction=input`}
                      className="inline-block text-xs text-blue-600 font-medium hover:underline"
                    >
                      → {a.action}
                    </Link>
                  </div>
                ))}
                {anomalies.totalAnomalies > 3 && (
                  <p className="text-xs text-center text-gray-400">
                    +{anomalies.totalAnomalies - 3} bất thường khác
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Ghost Company Widget (GHOST-05) ── */}
      {ghostSummary !== null && (
        <div className={`rounded-xl shadow-sm p-4 ${
          ghostSummary.critical > 0
            ? 'bg-red-50 border border-red-200'
            : ghostSummary.high > 0
            ? 'bg-orange-50 border border-orange-200'
            : 'bg-green-50 border border-green-200'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">
                {ghostSummary.critical > 0 ? '🚨' : ghostSummary.high > 0 ? '⚠️' : '✅'}
              </span>
              <div>
                <h2 className={`text-sm font-semibold ${
                  ghostSummary.critical > 0 ? 'text-red-800'
                  : ghostSummary.high > 0 ? 'text-orange-800'
                  : 'text-green-800'
                }`}>
                  {ghostSummary.critical > 0
                    ? `Phát hiện ${ghostSummary.critical} nhà cung cấp nghiêm trọng`
                    : ghostSummary.high > 0
                    ? `${ghostSummary.high} nhà cung cấp cần kiểm tra`
                    : 'Không phát hiện công ty ma'}
                </h2>
                {ghostSummary.total_vat_at_risk > 0 && (
                  <p className="text-xs mt-0.5 text-red-700">
                    VAT có thể bị loại:&nbsp;
                    <strong>{Math.round(Number(ghostSummary.total_vat_at_risk) / 1_000_000).toLocaleString('vi-VN')}M₫</strong>
                  </p>
                )}
                {ghostSummary.total === 0 && (
                  <p className="text-xs text-green-600 mt-0.5">Tất cả nhà cung cấp đều hợp lệ</p>
                )}
              </div>
            </div>
            <Link
              href="/audit/ghost-companies"
              className={`text-xs font-medium px-3 py-1.5 rounded-lg whitespace-nowrap ${
                ghostSummary.critical > 0
                  ? 'bg-red-100 text-red-700 hover:bg-red-200'
                  : ghostSummary.high > 0
                  ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                  : 'bg-green-100 text-green-700 hover:bg-green-200'
              }`}
            >
              Xem chi tiết →
            </Link>
          </div>
          {(ghostSummary.critical > 0 || ghostSummary.high > 0) && (
            <div className="mt-3 flex items-center gap-4 text-xs">
              {ghostSummary.critical > 0 && (
                <span className="flex items-center gap-1 text-red-700">
                  <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                  {ghostSummary.critical} nghiêm trọng
                </span>
              )}
              {ghostSummary.high > 0 && (
                <span className="flex items-center gap-1 text-orange-700">
                  <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
                  {ghostSummary.high} cảnh báo
                </span>
              )}
              {ghostSummary.medium > 0 && (
                <span className="flex items-center gap-1 text-amber-700">
                  <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" />
                  {ghostSummary.medium} lưu ý
                </span>
              )}
              {ghostSummary.acknowledged > 0 && (
                <span className="text-gray-400">{ghostSummary.acknowledged} đã kiểm tra</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── VAT Forecast + Tax Calendar ── */}
      {forecast && forecast.periods_used > 0 && (() => {
        const now2 = new Date();
        const deadlineDay = 20;
        const nextMonth = new Date(now2.getFullYear(), now2.getMonth() + 1, deadlineDay);
        const daysToDeadline = Math.ceil((nextMonth.getTime() - now2.getTime()) / 86_400_000);
        const currentPayable = kpi?.vat ? Number(kpi.vat.payable_vat) : 0;
        return (
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700">📈 Dự Báo Thuế GTGT Tháng Sau</h2>

            {/* Forecast compare bar */}
            <div className="space-y-2">
              {[
                { label: 'Tháng này (tt)', val: currentPayable, color: 'bg-blue-400' },
                { label: 'Dự báo tháng sau', val: forecast.net_forecast, color: 'bg-amber-400' },
              ].map((row) => {
                const max = Math.max(currentPayable, forecast.net_forecast, 1);
                return (
                  <div key={row.label} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-36 shrink-0">{row.label}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                      <div className={`h-full rounded-full ${row.color}`} style={{ width: `${Math.min((row.val / max) * 100, 100)}%` }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-800 w-20 text-right">
                      {compact(row.val)}₫
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-400">{forecast.confidence_note}</p>

            {/* Tax calendar */}
            <div className="border-t border-gray-100 pt-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">📅 Lịch Thuế</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Hạn nộp kỳ này</span>
                  <span className={`font-semibold ${daysToDeadline <= 5 ? 'text-red-600' : daysToDeadline <= 10 ? 'text-amber-600' : 'text-gray-800'}`}>
                    Ngày 20/{now2.getMonth() + 2 > 12 ? `01/${now2.getFullYear()+1}` : `${now2.getMonth() + 2}/${now2.getFullYear()}`}
                    &nbsp;({daysToDeadline > 0 ? `còn ${daysToDeadline} ngày` : 'Đã quá hạn'})
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Dự kiến phải nộp</span>
                  <span className="font-semibold text-amber-700">{compact(forecast.net_forecast)}₫</span>
                </div>
                {forecast.carry_forward > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Khấu trừ chuyển kỳ</span>
                    <span className="font-semibold text-green-700">-{compact(forecast.carry_forward)}₫</span>
                  </div>
                )}
              </div>
              {/* Visual timeline */}
              <div className="mt-3 flex items-center gap-1 text-xs text-gray-400">
                <div className="flex-1 h-px bg-gray-200" />
                <div className="flex flex-col items-center gap-0.5">
                  <div className={`w-3 h-3 rounded-full ${daysToDeadline <= 5 ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <span>20/{now2.getMonth() + 2 > 12 ? 1 : now2.getMonth() + 2}</span>
                </div>
                <div className="flex-1 h-px bg-gray-200" />
                <div className="flex flex-col items-center gap-0.5">
                  <div className="w-3 h-3 rounded-full bg-gray-300" />
                  <span>20/{now2.getMonth() + 3 > 12 ? 1 : now2.getMonth() + 3}</span>
                </div>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── ESG Quick Widget ── */}
      {esg && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">Ước Tính Phát Thải Carbon (ESG)</h2>
            <Link href="/insights/seasonal" className="text-xs text-primary-600 hover:underline">
              Phân Tích Mùa Vụ →
            </Link>
          </div>
          <p className="text-2xl font-bold text-emerald-700">
            {esg.total_tco2e.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tCO2e
          </p>
          <p className="text-xs text-gray-400 mt-1">Lượng CO₂ tương đương ước tính từ hóa đơn mua vào năm nay</p>
          <p className="text-xs text-amber-600 mt-1">⚠️ Chỉ mang tính tham khảo — chưa qua kiểm toán ESG chính thức</p>
          <div className="mt-3 space-y-1.5">
            {esg.by_category.slice(0, 3).map((c, i) => (
              <div key={`${c.category_name}-${i}`} className="flex items-center justify-between text-xs">
                <span className="text-gray-600 truncate">{c.category_name}</span>
                <span className="font-semibold text-gray-800">{c.tco2e.toFixed(2)} t</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Quick Actions ── */}
      <div className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Thao Tác Nhanh</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {(quickActions.length > 0
            ? quickActions
            : [
                { key: 'invoices', icon: '📄', label: 'Xem Hóa Đơn', href: '/invoices', color: 'bg-blue-50 text-blue-700' },
                { key: 'declarations', icon: '📊', label: 'Tờ Khai', href: '/declarations', color: 'bg-green-50 text-green-700' },
                { key: 'connectors', icon: '🔗', label: 'Kết Nối nhà mạng', href: '/settings/connectors', color: 'bg-purple-50 text-purple-700' },
                { key: 'ai', icon: '🤖', label: 'Trợ Lý AI', href: '/ai', color: 'bg-orange-50 text-orange-700' },
              ]
          ).map((action) => (
            <Link key={action.key} href={action.href}
              className={`flex items-center gap-2 p-3 rounded-lg text-sm font-medium relative ${action.color}`}>
              <span>{action.icon}</span>
              <span className="flex-1 leading-tight">{action.label}</span>
              {action.count != null && action.count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {action.count}
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
