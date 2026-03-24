'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, LineChart, Line, PieChart, Pie, Cell,
} from 'recharts';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';

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

interface Analytics {
  topCustomers: Array<{ counterparty_name: string; counterparty_tax_code: string; invoice_count: string; total_amount: string }>;
  topSuppliers: Array<{ counterparty_name: string; counterparty_tax_code: string; invoice_count: string; total_amount: string }>;
  statusBreakdown: Array<{ status: string; direction: string; count: string }>;
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
const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const PROVIDER_LABELS: Record<string, string> = {
  misa: 'MISA', viettel: 'Viettel', bkav: 'BKAV', gdt_intermediary: 'GDT',
};
const STATUS_VN: Record<string, string> = {
  valid: 'Hợp lệ', cancelled: 'Hủy', replaced: 'Thay thế', adjusted: 'Điều chỉnh',
};

/* ─── Formatters ──────────────────────────────────────────────────────────── */
const compact = (n: string | number) =>
  Number(n).toLocaleString('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });
const full = (n: string | number) => Number(n).toLocaleString('vi-VN');
const mVnd = (n: string | number) => `${Math.round(Number(n) / 1_000_000).toLocaleString('vi-VN')}M`;
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

function TopTable({ rows, caption }: { rows: Analytics['topCustomers']; caption: string }) {
  if (rows.length === 0) return <p className="text-sm text-center text-gray-400 py-4">Chưa có dữ liệu</p>;
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">{caption}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-bold text-gray-400 w-4">{i + 1}</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{r.counterparty_name}</p>
                <p className="text-xs text-gray-400 font-mono">{r.counterparty_tax_code}</p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-gray-900">{mVnd(r.total_amount)}</p>
              <p className="text-xs text-gray-400">{r.invoice_count} HĐ</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [chart, setChart] = useState<ChartData | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [anomalies, setAnomalies] = useState<AnomalyReport | null>(null);
  const [loadingAnomalies, setLoadingAnomalies] = useState(false);
  const [loading, setLoading] = useState(true);
  const [analyticsPeriod, setAnalyticsPeriod] = useState(3);

  const load = useCallback(async (period = analyticsPeriod) => {
    try {
      const [kpiRes, chartRes, analyticsRes] = await Promise.all([
        apiClient.get<{ data: KpiData }>('/dashboard/kpi'),
        apiClient.get<{ data: ChartData }>('/dashboard/charts'),
        apiClient.get<{ data: Analytics }>(`/dashboard/analytics?months=${period}`),
      ]);
      setKpi(kpiRes.data.data);
      setChart(chartRes.data.data);
      setAnalytics(analyticsRes.data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [analyticsPeriod]);

  useEffect(() => { void load(); }, [load]);

  const handlePeriodChange = (p: number) => {
    setAnalyticsPeriod(p);
    void load(p);
  };

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

  const revenueChartData = chart?.invoiceTrend.map((r) => ({
    name: `T${r.month}/${String(r.year).slice(2)}`,
    'Bán Ra': Math.round(Number(r.output_total) / 1_000_000),
    'Mua Vào': Math.round(Number(r.input_total) / 1_000_000),
  })) ?? [];

  const pieData = analytics?.statusBreakdown
    .filter((r) => r.direction === 'output')
    .map((r) => ({ name: STATUS_VN[r.status] ?? r.status, value: Number(r.count) })) ?? [];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tổng Quan</h1>
          {kpi && (
            <p className="text-sm text-gray-500 mt-0.5">
              Kỳ kê khai: Tháng {kpi.period.month}/{kpi.period.year}
            </p>
          )}
        </div>
        <button
          onClick={() => void load()}
          className="text-xs text-gray-400 hover:text-gray-700"
          title="Làm mới"
        >
          ↻ Làm mới
        </button>
      </div>

      {/* ── KPI Cards ── */}
      {kpi && (
        <div className="grid grid-cols-2 gap-3">
          <KCard
            label="Tổng Hóa Đơn"
            value={full(kpi.invoices.total)}
            sub={`Ra: ${kpi.invoices.output_count} · Vào: ${kpi.invoices.input_count}`}
          />
          <KCard
            label="Chờ Xét Duyệt GDT"
            value={full(kpi.invoices.unvalidated_count)}
            sub="Hóa đơn chưa được GDT xác nhận"
            color="text-yellow-600"
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

      {/* ── VAT Trend ── */}
      {vatChartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Biến Động Thuế GTGT (triệu ₫)</h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={vatChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={45} />
              <Tooltip formatter={(val: number) => `${val.toLocaleString('vi-VN')} triệu`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Đầu Ra" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Bar dataKey="Đầu Vào" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={18} />
              <Bar dataKey="Phải Nộp" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Revenue Trend ── */}
      {revenueChartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Doanh Thu / Chi Phí (triệu ₫)</h2>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={revenueChartData} margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} width={45} />
              <Tooltip formatter={(val: number) => `${val.toLocaleString('vi-VN')} triệu`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="Bán Ra" stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Mua Vào" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Analytics period selector ── */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">Phân Tích</h2>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[1, 3, 6, 12].map((m) => (
            <button
              key={m}
              onClick={() => handlePeriodChange(m)}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
                analyticsPeriod === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              {m}T
            </button>
          ))}
        </div>
      </div>

      {/* ── Top Customers & Suppliers ── */}
      {analytics && (
        <div className="grid grid-cols-1 gap-4">
          <div className="bg-white rounded-xl shadow-sm p-4">
            <TopTable rows={analytics.topCustomers} caption="Top 5 khách hàng (đầu ra)" />
          </div>
          <div className="bg-white rounded-xl shadow-sm p-4">
            <TopTable rows={analytics.topSuppliers} caption="Top 5 nhà cung cấp (đầu vào)" />
          </div>
        </div>
      )}

      {/* ── Status Breakdown Pie ── */}
      {pieData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Trạng Thái HĐ Đầu Ra</h2>
          <div className="flex items-center gap-4">
            <ResponsiveContainer width={120} height={120}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={30} outerRadius={55} dataKey="value" paddingAngle={2}>
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-1.5">
              {pieData.map((d, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-gray-600">{d.name}</span>
                  </div>
                  <span className="font-semibold text-gray-800">{d.value.toLocaleString('vi-VN')}</span>
                </div>
              ))}
            </div>
          </div>
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

      {/* ── Quick Actions ── */}
      <div className="bg-white rounded-xl shadow-sm p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Thao Tác Nhanh</h2>
        <div className="grid grid-cols-2 gap-2">
          <Link href="/invoices" className="flex items-center gap-2 p-3 rounded-lg bg-blue-50 text-blue-700 text-sm font-medium">
            <span>📄</span> Xem Hóa Đơn
          </Link>
          <Link href="/declarations" className="flex items-center gap-2 p-3 rounded-lg bg-green-50 text-green-700 text-sm font-medium">
            <span>📊</span> Tờ Khai
          </Link>
          <Link href="/settings/connectors" className="flex items-center gap-2 p-3 rounded-lg bg-purple-50 text-purple-700 text-sm font-medium">
            <span>🔗</span> Kết Nối nhà mạng
          </Link>
          <Link href="/ai" className="flex items-center gap-2 p-3 rounded-lg bg-orange-50 text-orange-700 text-sm font-medium">
            <span>🤖</span> Trợ Lý AI
          </Link>
        </div>
      </div>
    </div>
  );
}
