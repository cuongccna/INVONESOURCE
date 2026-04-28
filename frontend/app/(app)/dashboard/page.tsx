'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Line, ComposedChart, Cell,
} from 'recharts';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';
import { ProfessionalTaxCalendar } from '../../../components/dashboard/TaxCalendar';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface TaxDeadline {
  label: string; due: string; days_left: number; type: string;
}

interface KpiData {
  period: { month: number; quarter?: number; periodType?: 'monthly' | 'quarterly' | 'yearly'; year: number };
  invoices: {
    total: string; output_count: string; input_count: string;
    invalid_count: string; unvalidated_count: string; input_above_20m_count?: string;
  };
  vat: { output_vat: string; input_vat: string; payable_vat: string; deductible_vat?: string } | null;
  recentSyncs: Array<{
    provider: string; errors_count: number; started_at: string; error_detail: string | null;
  }>;
  cit_estimate?: number;
  ytd_revenue?: number;
  ytd_cost?: number;
  ytd_profit?: number;
  risk_score?: number;
  carry_forward_vat?: number;
  carry_forward_source_label?: string;
  tax_deadlines?: TaxDeadline[];
}

interface HkdKpiData {
  period: { month: number; quarter?: number; periodType?: 'monthly' | 'quarterly' | 'yearly'; year: number };
  revenue: number;
  input_purchases: number;
  input_invoice_count: number;
  input_above_20m: number;
  khoan_tax: number;
  pit_tax: number;
  total_tax: number;
  mon_bai: number;
  profit_estimate: number;
  profit_margin: number;
  vat_rate_hkd: number;
  tax_regime: string;
  tax_deadlines: TaxDeadline[];
}

interface ChartData {
  periodType: 'monthly' | 'quarterly' | 'yearly';
  vatTrend: Array<{ key: string; label: string; output_vat: number; input_vat: number; payable_vat: number }>;
  invoiceTrend: Array<{ key: string; label: string; output_total: number; input_total: number; gross_profit: number }>;
}

interface HkdChartData {
  periodType: 'monthly' | 'quarterly' | 'yearly';
  invoiceTrend: Array<{ key: string; label: string; output_total: number; input_total: number; gross_profit: number }>;
}

interface VatForecast {
  forecast_output_vat: number;
  forecast_input_vat: number;
  forecast_payable: number;
  carry_forward: number;
  net_forecast: number;
  display_amount: number;
  direction: 'payable' | 'deductible';
  periods_used: number;
  confidence_note: string;
}

interface GhostSummary {
  critical: number;
  high: number;
  medium: number;
  total_vat_at_risk: number;
  acknowledged: number;
  total: number;
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const PROVIDER_LABELS: Record<string, string> = {
  gdt_intermediary: 'GDT',
};

/* ─── Formatters ──────────────────────────────────────────────────────────── */
import { formatVNDShort, formatVNDFull, formatVNDCompact } from '../../../utils/formatCurrency';

const compact = (n: number | string) => formatVNDFull(n).replace(/đ$/, '');
const full = (n: string | number) => Number(n).toLocaleString('vi-VN');
function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diff < 1) return 'vừa xong';
  if (diff < 60) return `${diff} phút trước`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)}d trước`;
}

/* ─── KCard — support dual badges ─────────────────────────────────────────── */
function KCard({ label, value, sub, color = 'text-gray-900', badge, badgeColor, badge2, badge2Color }: {
  label: string; value: string; sub?: string; color?: string;
  badge?: string; badgeColor?: string;
  badge2?: string; badge2Color?: string;
}) {
  // Auto-scale font size so large numbers (up to hàng chục tỷ) always fit
  // on 2-column mobile grid (~150px card width) without overflow.
  const len = value.length;
  const textSize =
    len <= 6  ? 'text-2xl' :
    len <= 9  ? 'text-xl'  :
    len <= 13 ? 'text-lg'  :
               'text-base';
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-start justify-between mb-1 gap-1">
        <p className="text-xs text-gray-500 leading-snug flex-1">{label}</p>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {badge && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${badgeColor ?? 'bg-gray-100 text-gray-600'}`}>
              {badge}
            </span>
          )}
          {badge2 && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${badge2Color ?? 'bg-gray-100 text-gray-600'}`}>
              {badge2}
            </span>
          )}
        </div>
      </div>
      <p className={`${textSize} font-bold leading-tight ${color} break-words tabular-nums`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5 leading-snug">{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { activeCompanyId, activeCompany } = useCompany();
  const isHousehold = activeCompany?.company_type === 'household';
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [hkdChart, setHkdChart] = useState<HkdChartData | null>(null);
  const [forecast, setForecast] = useState<VatForecast | null>(null);
  const [ghostSummary, setGhostSummary] = useState<GhostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [vatViewMode, setVatViewMode] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [hkdKpi, setHkdKpi] = useState<HkdKpiData | null>(null);

  // Period navigator: default to current month/year
  const now = new Date();
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(now.getFullYear());

  const quarterOf     = (m: number) => Math.ceil(m / 3);
  const quarterStart  = (q: number) => (q - 1) * 3 + 1;

  const buildPeriodQuery = useCallback((mode: 'monthly' | 'quarterly' | 'yearly', month: number, year: number) => {
    const params = new URLSearchParams({ periodType: mode, year: String(year) });
    if (mode === 'monthly') {
      params.set('month', String(month));
    }
    if (mode === 'quarterly') {
      params.set('quarter', String(Math.ceil(month / 3)));
    }
    return params.toString();
  }, []);

  const handleVatViewMode = (mode: 'monthly' | 'quarterly' | 'yearly') => {
    setVatViewMode(mode);
    if (mode === 'quarterly') {
      setPeriodMonth(quarterStart(quarterOf(periodMonth)));
    } else if (mode === 'yearly') {
      setPeriodMonth(1);
    }
  };

  const navigatePeriod = (delta: number) => {
    if (vatViewMode === 'yearly') {
      setPeriodYear(periodYear + delta);
      setPeriodMonth(1);
    } else if (vatViewMode === 'quarterly') {
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

  const loadEnterprise = useCallback(async (month = periodMonth, year = periodYear, mode = vatViewMode) => {
    if (isHousehold) {
      return;
    }

    const query = buildPeriodQuery(mode, month, year);
    try {
      const [kpiRes, chartRes, forecastRes] = await Promise.all([
        apiClient.get<{ data: KpiData }>(`/dashboard/kpi?${query}`),
        apiClient.get<{ data: ChartData }>(`/dashboard/charts?${query}`),
        apiClient.get<{ data: VatForecast }>(`/forecast/vat?${query}`).catch(() => ({ data: { data: null } })),
      ]);
      setKpi(kpiRes.data.data);
      setChart(chartRes.data.data);
      setForecast((forecastRes as { data: { data: VatForecast | null } }).data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [buildPeriodQuery, isHousehold, periodMonth, periodYear, vatViewMode]);

  const loadHkd = useCallback(async (month = periodMonth, year = periodYear, mode = vatViewMode) => {
    if (!isHousehold) return;
    const query = buildPeriodQuery(mode, month, year);
    try {
      const [kpiRes, chartRes] = await Promise.all([
        apiClient.get<{ data: HkdKpiData }>(`/hkd/dashboard/kpi?${query}`),
        apiClient.get<{ data: HkdChartData }>(`/hkd/dashboard/charts?${query}`),
      ]);
      setHkdKpi(kpiRes.data.data);
      setHkdChart(chartRes.data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [buildPeriodQuery, isHousehold, periodMonth, periodYear, vatViewMode]);

  useEffect(() => {
    setLoading(true);
    if (isHousehold) {
      setKpi(null);
      setChart(null);
      setForecast(null);
      void loadHkd(periodMonth, periodYear, vatViewMode);
      return;
    }

    setHkdKpi(null);
    setHkdChart(null);
    void loadEnterprise(periodMonth, periodYear, vatViewMode);
  }, [activeCompanyId, isHousehold, loadEnterprise, loadHkd, periodMonth, periodYear, vatViewMode]);

  useEffect(() => {
    if (isHousehold) {
      setGhostSummary(null);
      return;
    }

    apiClient
      .get<{ data: GhostSummary }>('/audit/ghost-companies/summary')
      .then((res) => setGhostSummary(res.data.data))
      .catch(() => setGhostSummary(null));
  }, [activeCompanyId, isHousehold]);

  /* ── Chart data — stored as raw VND (not pre-divided) so tooltip is exact ── */
  const vatChartData = chart?.vatTrend.map((r) => ({
    name: r.label,
    'Đầu Ra': r.output_vat,
    'Đầu Vào': r.input_vat,
    'Phải Nộp': r.payable_vat,
  })) ?? [];

  const smePlChartData = chart?.invoiceTrend.map((r) => ({
    name: r.label,
    'Doanh Thu': r.output_total,
    'Chi Phí': r.input_total,
    'Lãi Gộp': r.gross_profit,
  })) ?? [];

  const hkdPlChartData = hkdChart?.invoiceTrend.map((r) => ({
    name: r.label,
    'Doanh Thu': r.output_total,
    'Chi Phí': r.input_total,
    'Lãi Gộp': r.gross_profit,
  })) ?? [];

  const chartWindowSize = vatViewMode === 'yearly' ? 2 : 1;
  const visibleVatChartData = vatChartData.slice(-chartWindowSize);
  const visibleSmePlChartData = smePlChartData.slice(-chartWindowSize);
  const visibleHkdPlChartData = hkdPlChartData.slice(-chartWindowSize);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  /* ── Derived period values ── */
  const periodLabel = vatViewMode === 'yearly' ? `Năm ${periodYear}`
    : vatViewMode === 'quarterly' ? `Quý ${quarterOf(periodMonth)} / ${periodYear}`
    : `Tháng ${periodMonth} / ${periodYear}`;

  const periodDeadline = (() => {
    if (vatViewMode === 'yearly') return `31/3/${periodYear + 1}`;
    if (vatViewMode === 'quarterly') {
      // Điều 44 – Luật 38/2019/QH14: last day of first month of next quarter
      const q = quarterOf(periodMonth);
      const QUARTER_DEADLINES: Record<number, { day: number; month: number }> = {
        1: { day: 30, month: 4 },  // Q1 → 30/04
        2: { day: 31, month: 7 },  // Q2 → 31/07
        3: { day: 31, month: 10 }, // Q3 → 31/10
        4: { day: 31, month: 1 },  // Q4 → 31/01 next year
      };
      const { day, month } = QUARTER_DEADLINES[q]!;
      const y = q === 4 ? periodYear + 1 : periodYear;
      return `${day}/${month}/${y}`;
    }
    const nextM = periodMonth === 12 ? 1 : periodMonth + 1;
    const nextY = periodMonth === 12 ? periodYear + 1 : periodYear;
    return `20/${nextM}/${nextY}`;
  })();

  const isCurrentPeriod = vatViewMode === 'yearly'
    ? periodYear === now.getFullYear()
    : vatViewMode === 'quarterly'
    ? (quarterOf(periodMonth) === quarterOf(now.getMonth() + 1) && periodYear === now.getFullYear())
    : (periodMonth === now.getMonth() + 1 && periodYear === now.getFullYear());

  const resetPeriod = () => {
    const m = now.getMonth() + 1;
    setPeriodYear(now.getFullYear());
    if (vatViewMode === 'yearly') { setPeriodMonth(1); }
    else if (vatViewMode === 'quarterly') { setPeriodMonth(quarterStart(quarterOf(m))); }
    else { setPeriodMonth(m); }
  };

  /* Prev period label for carry forward */
  const prevLabel = (() => {
    if (vatViewMode === 'yearly') {
      return `Năm ${periodYear - 1}`;
    }

    if (vatViewMode === 'quarterly') {
      let prevQuarter = quarterOf(periodMonth) - 1;
      let prevYear = periodYear;
      if (prevQuarter === 0) {
        prevQuarter = 4;
        prevYear -= 1;
      }
      return `Q${prevQuarter}/${String(prevYear).slice(-2)}`;
    }

    const prevMonth = periodMonth === 1 ? 12 : periodMonth - 1;
    const prevYear = periodMonth === 1 ? periodYear - 1 : periodYear;
    return `T${prevMonth}/${String(prevYear).slice(-2)}`;
  })();

  /* Tax deadlines for calendar */
  const calendarDeadlines = kpi?.tax_deadlines ?? hkdKpi?.tax_deadlines ?? [];

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tổng Quan</h1>
        </div>
        <button
          onClick={() => void (isHousehold ? loadHkd() : loadEnterprise())}
          className="text-xs text-gray-400 hover:text-gray-700"
          title="Làm mới"
        >
          ↻ Làm mới
        </button>
      </div>

      {/* ── Professional Tax Calendar — đầu trang ── */}
      {calendarDeadlines.length > 0 && (
        <ProfessionalTaxCalendar
          deadlines={calendarDeadlines}
          year={periodYear}
          currentMonth={periodMonth}
          taxLabel={isHousehold ? 'Thuế khoán' : 'GTGT'}
          title={isHousehold ? 'Lịch Thuế Khoán' : 'Lịch Thuế GTGT'}
        />
      )}

      {/* ── Alert: input invoices >20M (DN only) ── */}
      {!isHousehold && kpi && Number(kpi.invoices.input_above_20m_count ?? '0') > 0 && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-amber-500 text-base shrink-0">⚠</span>
            <p className="text-sm text-amber-800 truncate">
              <strong>{kpi.invoices.input_above_20m_count}</strong> hóa đơn mua vào &gt;20Tr cần thanh toán phi tiền mặt để được khấu trừ
              {kpi.tax_deadlines?.[0]?.days_left != null && (
                <> — hạn chốt <strong>còn {kpi.tax_deadlines[0].days_left} ngày</strong></>
              )}
            </p>
          </div>
          <Link href="/invoices?direction=input" className="text-xs text-amber-700 font-semibold whitespace-nowrap hover:underline shrink-0">
            Xem danh sách →
          </Link>
        </div>
      )}

      {/* ── KPI Cards (DN) ── */}
      {!isHousehold && kpi && (
        <>
        {/* Period nav — 1 nơi duy nhất */}
        <div className="flex items-center gap-1.5 bg-white rounded-xl shadow-sm px-3 py-2">
          <button
            onClick={() => navigatePeriod(-1)}
            className="text-gray-400 hover:text-gray-900 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 font-bold text-lg transition-colors shrink-0"
            aria-label="Kỳ trước"
          >‹</button>
          <div className="flex-1 text-center min-w-0">
            <span className="text-sm font-bold text-gray-900">{periodLabel}</span>
            <span className="text-xs text-gray-400 ml-1.5 hidden xs:inline">· Hạn {periodDeadline}</span>
            {!isCurrentPeriod && (
              <button onClick={resetPeriod} className="ml-2 text-xs text-primary-600 hover:underline">↩</button>
            )}
          </div>
          <div className="flex gap-0.5 bg-gray-100 rounded-md p-0.5 shrink-0">
            {(['monthly', 'quarterly', 'yearly'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleVatViewMode(mode)}
                className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                  vatViewMode === mode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {mode === 'monthly' ? 'Tháng' : mode === 'quarterly' ? 'Quý' : 'Năm'}
              </button>
            ))}
          </div>
          <button
            onClick={() => navigatePeriod(1)}
            className="text-gray-400 hover:text-gray-900 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 font-bold text-lg transition-colors shrink-0"
            aria-label="Kỳ sau"
          >›</button>
        </div>

        {/* KPI Cards SME */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <KCard
            label="Tổng hóa đơn kỳ này"
            value={full(kpi.invoices.total)}
            sub={`Ra: ${kpi.invoices.output_count} · Vào: ${kpi.invoices.input_count}`}
          />
          <KCard
            label="Thuế GTGT phải nộp"
            value={kpi.vat ? `${compact(kpi.vat.payable_vat)} ₫` : '—'}
            sub={kpi.vat ? `ĐR ${compact(kpi.vat.output_vat)}₫ — ĐV ${compact(kpi.vat.input_vat)}₫` : ''}
            color={kpi.vat && Number(kpi.vat.payable_vat) > 0 ? 'text-red-600' : 'text-gray-400'}
            badge="Tạm tính"
            badgeColor="bg-orange-50 text-orange-500"
            badge2={`Hạn ${periodDeadline}`}
            badge2Color="bg-red-50 text-red-500"
          />
          <KCard
            label="Thuế GTGT KT kỳ trước chuyển sang"
            value={kpi.carry_forward_vat != null && kpi.carry_forward_vat > 0
              ? `${compact(kpi.carry_forward_vat)} ₫`
              : '—'}
            sub={kpi.carry_forward_vat && kpi.carry_forward_vat > 0
              ? `CT43 từ ${kpi.carry_forward_source_label ?? prevLabel}`
              : 'Chưa có tờ khai kỳ trước'}
            color="text-green-600"
            badge="Kỳ trước"
            badgeColor="bg-green-50 text-green-600"
          />
          <KCard
            label="Thuế GTGT được khấu trừ"
            value={kpi.vat?.deductible_vat != null
              ? `${compact(kpi.vat.deductible_vat)} ₫`
              : '—'}
            sub="Đầu vào đủ điều kiện khấu trừ theo 01/GTGT"
            color="text-blue-600"
            badge="Tạm tính"
            badgeColor="bg-orange-50 text-orange-500"
          />
        </div>
        </>
      )}

      {/* ── KPI Cards (HKD) ── */}
      {isHousehold && hkdKpi && (
        <>
        {/* Period nav HKD — có nút Tháng/Quý/Năm */}
        <div className="flex items-center gap-1.5 bg-white rounded-xl shadow-sm px-3 py-2">
          <button
            onClick={() => navigatePeriod(-1)}
            className="text-gray-400 hover:text-gray-900 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 font-bold text-lg transition-colors shrink-0"
            aria-label="Kỳ trước"
          >‹</button>
          <div className="flex-1 text-center min-w-0">
            <span className="text-sm font-bold text-gray-900">{periodLabel}</span>
            {!isCurrentPeriod && (
              <button onClick={resetPeriod} className="ml-2 text-xs text-primary-600 hover:underline">↩</button>
            )}
          </div>
          <div className="flex gap-0.5 bg-gray-100 rounded-md p-0.5 shrink-0">
            {(['monthly', 'quarterly', 'yearly'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => handleVatViewMode(mode)}
                className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                  vatViewMode === mode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {mode === 'monthly' ? 'Tháng' : mode === 'quarterly' ? 'Quý' : 'Năm'}
              </button>
            ))}
          </div>
          <button
            onClick={() => navigatePeriod(1)}
            className="text-gray-400 hover:text-gray-900 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-100 font-bold text-lg transition-colors shrink-0"
            aria-label="Kỳ sau"
          >›</button>
        </div>

        {/* KPI Cards HKD — 3 cột (bỏ Môn bài) */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <KCard
            label="Doanh thu bán hàng"
            value={`${compact(hkdKpi.revenue)} ₫`}
            sub="Hóa đơn bán ra hợp lệ kỳ này"
            color="text-blue-600"
          />
          <KCard
            label="Chi Phí Mua Vào"
            value={`${compact(hkdKpi.input_purchases)} ₫`}
            sub={`${hkdKpi.input_invoice_count} HĐ${hkdKpi.input_above_20m > 0 ? ` · ${hkdKpi.input_above_20m} >20Tr ⚠` : ''}`}
            color="text-gray-700"
          />
          <KCard
            label="Thuế GTGT Khoán"
            value={`${compact(hkdKpi.khoan_tax)} ₫`}
            sub={`Tỷ lệ ${hkdKpi.vat_rate_hkd}% · PIT: ${compact(hkdKpi.pit_tax)}₫`}
            color="text-red-600"
          />
        </div>
        </>
      )}

      {/* ── HKD: Revenue chart + Profit ── */}
      {isHousehold && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleHkdPlChartData.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">📊 Doanh Thu / Chi Phí / Lãi Gộp</h2>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={visibleHkdPlChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v)} />
                  <Tooltip formatter={(val: number) => formatVNDFull(Number(val))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Doanh Thu" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
                  <Bar dataKey="Chi Phí" fill="#f87171" radius={[3, 3, 0, 0]} maxBarSize={18} />
                  <Line type="monotone" dataKey="Lãi Gộp" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          {hkdKpi && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">💼 Lợi Nhuận Ước Tính</h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Doanh thu bán hàng</span>
                  <span className="font-medium text-blue-700">{compact(hkdKpi.revenue)} ₫</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Chi phí mua vào</span>
                  <span className="font-medium text-gray-700">- {compact(hkdKpi.input_purchases)} ₫</span>
                </div>
                <div className={`pt-1 border-t border-gray-100 flex justify-between font-semibold ${
                  hkdKpi.profit_estimate >= 0 ? 'text-green-700' : 'text-red-700'
                }`}>
                  <span>Lãi gộp ước tính</span>
                  <span>{compact(hkdKpi.profit_estimate)} ₫ ({hkdKpi.profit_margin}%)</span>
                </div>
                <div className="pt-1 border-t border-gray-100 flex justify-between text-sm">
                  <span className="text-gray-500">Thuế khoán phải nộp</span>
                  <span className="font-semibold text-red-600">{compact(hkdKpi.total_tax)} ₫</span>
                </div>
              </div>
              <p className="text-xs text-gray-400 mt-3">⚠️ Chưa trừ lương, khấu hao, chi phí vận hành</p>
            </div>
          )}
        </div>
      )}

      {/* ── DN Charts grid ── */}
      {!isHousehold && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* VAT Trend */}
        {visibleVatChartData.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Biến Động Thuế GTGT</h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={visibleVatChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v)} />
                <Tooltip formatter={(val: number) => formatVNDFull(Number(val))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Đầu Ra" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Bar dataKey="Đầu Vào" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Bar dataKey="Phải Nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* P&L chart */}
        {visibleSmePlChartData.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">📊 Lãi / Lỗ Tạm Thời</h2>
            <p className="text-xs text-gray-400 mb-3">Doanh thu bán ra − chi phí mua vào (chưa trừ thuế, lương, khấu hao)</p>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={visibleSmePlChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v)} />
                <Tooltip formatter={(val: number) => formatVNDFull(Number(val))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Doanh Thu" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Bar dataKey="Chi Phí" fill="#f87171" radius={[3, 3, 0, 0]} maxBarSize={18} />
                <Line type="monotone" dataKey="Lãi Gộp" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>}

      {/* ── VAT Payable Chart (DN only) — 1 bộ chọn duy nhất ở period nav bar ── */}
      {!isHousehold && visibleVatChartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">💰 Thuế GTGT Phải Nộp</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={visibleVatChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={52} tickFormatter={(v: number) => formatVNDShort(v)} />
              <Tooltip formatter={(val: number) => formatVNDFull(Number(val))} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Đầu Ra" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="Đầu Vào" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="Phải Nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
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

      {/* ── Ghost Company Widget ── */}
      {!isHousehold && ghostSummary !== null && (
        <div className={`rounded-xl shadow-sm p-4 ${
          ghostSummary.critical > 0
            ? 'bg-red-50 border border-red-200'
            : ghostSummary.high > 0
            ? 'bg-orange-50 border border-orange-200'
            : ghostSummary.medium > 0
            ? 'bg-amber-50 border border-amber-200'
            : 'bg-green-50 border border-green-200'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <span className="text-2xl mt-0.5">
                {ghostSummary.critical > 0 ? '🚨' : ghostSummary.high > 0 ? '⚠️' : ghostSummary.medium > 0 ? '⚠️' : '✅'}
              </span>
              <div>
                <h2 className={`text-sm font-semibold ${
                  ghostSummary.critical > 0 ? 'text-red-800'
                  : ghostSummary.high > 0 ? 'text-orange-800'
                  : ghostSummary.medium > 0 ? 'text-amber-800'
                  : 'text-green-800'
                }`}>
                  {ghostSummary.critical > 0
                    ? `Phát hiện ${ghostSummary.critical} nhà cung cấp nghiêm trọng`
                    : ghostSummary.high > 0
                    ? `${ghostSummary.high} nhà cung cấp cần kiểm tra`
                    : ghostSummary.medium > 0
                    ? `${ghostSummary.medium} nhà cung cấp cần lưu ý`
                    : 'Không phát hiện rủi ro nhà cung cấp'}
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
                  : ghostSummary.medium > 0
                  ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
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

      {/* ── VAT Forecast (DN only) ── */}
      {!isHousehold && forecast && forecast.periods_used > 0 && (() => {
        // Use the same periodDeadline already computed for the selected Tháng/Quý/Năm mode
        // so "Hạn nộp kỳ này" always matches the KPI card badge.
        const VN_OFFSET_MS = 7 * 60 * 60 * 1_000;
        const [ddStr, mmStr, yyyyStr] = periodDeadline.split('/');
        const deadlineUTC = new Date(Date.UTC(Number(yyyyStr), Number(mmStr) - 1, Number(ddStr)));
        const todayVN = Math.floor((Date.now() + VN_OFFSET_MS) / 86_400_000);
        const dueVN   = Math.floor((deadlineUTC.getTime() + VN_OFFSET_MS) / 86_400_000);
        const daysToDeadline = dueVN - todayVN;
        const currentPayable = kpi?.vat ? Number(kpi.vat.payable_vat) : 0;
        const forecastAmount = Math.abs(forecast.display_amount ?? forecast.net_forecast);
        const forecastSummaryLabel = forecast.direction === 'payable' ? 'Dự kiến phải nộp' : 'Dự kiến được khấu trừ';
        const forecastSummaryColor = forecast.direction === 'payable' ? 'text-amber-700' : 'text-green-700';
        const forecastBarColor = forecast.direction === 'payable' ? 'bg-amber-400' : 'bg-green-400';
        return (
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700">📈 Dự Báo Thuế GTGT Kỳ Sau</h2>
            <div className="space-y-2">
              {[
                { label: 'Kỳ này (tạm tính)', val: currentPayable, color: 'bg-blue-400' },
                { label: 'Dự báo kỳ sau', val: forecastAmount, color: forecastBarColor },
              ].map((row) => {
                const max = Math.max(currentPayable, forecastAmount, 1);
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
            <div className="border-t border-gray-100 pt-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Hạn nộp kỳ này</span>
                  <span className={`font-semibold ${daysToDeadline <= 5 ? 'text-red-600' : daysToDeadline <= 10 ? 'text-amber-600' : 'text-gray-800'}`}>
                    Ngày {periodDeadline}
                    &nbsp;({daysToDeadline > 0 ? `còn ${daysToDeadline} ngày` : daysToDeadline === 0 ? 'Hôm nay!' : 'Đã quá hạn'})
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{forecastSummaryLabel}</span>
                  <span className={`font-semibold ${forecastSummaryColor}`}>{compact(forecastAmount)}₫</span>
                </div>
                {forecast.carry_forward > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Khấu trừ chuyển kỳ</span>
                    <span className="font-semibold text-green-700">-{compact(forecast.carry_forward)}₫</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
