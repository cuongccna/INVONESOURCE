'use client';

import { useEffect, useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import apiClient from '../../../lib/apiClient';

interface DailyFlow {
  date: string;
  expected_in: number;
  expected_out: number;
  net: number;
  cumulative: number;
}

interface OverdueAR {
  id: string;
  invoice_number: string;
  counterparty_name: string;
  counterparty_tax_code: string;
  total_amount: string;
  payment_due_date: string;
}

interface CashflowData {
  daily: DailyFlow[];
  summary: { ar_30: number; ap_30: number; tax_due: number; net_30: number };
  overdue_ar: OverdueAR[];
  tax_due_date: string | null;
}

const compact = (n: number) => n.toLocaleString('vi-VN', { notation: 'compact', maximumFractionDigits: 1 });

function daysOverdue(due: string) {
  return Math.floor((Date.now() - new Date(due).getTime()) / 86_400_000);
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function formatDateFull(iso: string) {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

export default function CashflowPage() {
  const [data, setData] = useState<CashflowData | null>(null);
  const [loading, setLoading] = useState(true);
  const [horizon, setHorizon] = useState(30);
  const [selected, setSelected] = useState<DailyFlow | null>(null);
  const [markingPaid, setMarkingPaid] = useState<string | null>(null);
  const [paidDate, setPaidDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [marking, setMarking] = useState(false);

  const loadData = () => {
    setLoading(true);
    apiClient.get<{ data: CashflowData }>(`/cashflow/projection?days=90`)
      .then((r) => setData(r.data.data))
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleMarkPaid = async (invoiceId: string) => {
    if (!paidDate) return;
    setMarking(true);
    try {
      await apiClient.patch(`/invoices/${invoiceId}/mark-paid`, { payment_date: paidDate });
      setMarkingPaid(null);
      loadData();
    } catch { /* silent */ } finally { setMarking(false); }
  };

  const chartData = (data?.daily ?? [])
    .slice(0, horizon)
    .map((d) => ({ ...d, label: formatDate(d.date) }));

  const summary = data?.summary;

  // Build critical dates: dates with largest absolute flows
  const criticalDates = [...(data?.daily ?? [])]
    .filter((d) => Math.abs(d.net) > 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 8);

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dự Báo Dòng Tiền</h1>
          <p className="text-sm text-gray-500">90 ngày tới — từ hóa đơn chưa thanh toán</p>
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {[30, 60, 90].map((d) => (
            <button key={d} onClick={() => setHorizon(d)}
              className={`text-xs px-3 py-1.5 rounded-md font-medium ${horizon === d ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Data quality banner */}
      {(!data || data.overdue_ar.length === 0) && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-2">
          <span className="text-blue-500 mt-0.5">💡</span>
          <p className="text-xs text-blue-700">
            Để dự báo chính xác hơn: đánh dấu hóa đơn đã thanh toán bên dưới.
          </p>
        </div>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-500">Thu dự kiến 30d</p>
            <p className="text-xl font-bold text-emerald-600">{compact(summary.ar_30)}₫</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-500">Chi dự kiến 30d</p>
            <p className="text-xl font-bold text-red-500">{compact(summary.ap_30)}₫</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-500">Thuế GTGT phải nộp</p>
            <p className="text-xl font-bold text-amber-600">{compact(summary.tax_due)}₫</p>
            {data?.tax_due_date && (
              <p className="text-xs text-gray-400">Hạn: {formatDate(data.tax_due_date)}</p>
            )}
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3">
            <p className="text-xs text-gray-500">Ròng 30 ngày</p>
            <p className={`text-xl font-bold ${summary.net_30 >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {compact(summary.net_30)}₫
            </p>
          </div>
        </div>
      )}

      {/* Waterfall chart */}
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary-500" />
        </div>
      ) : chartData.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
          <p className="text-3xl mb-2">📊</p>
          <p>Không có dữ liệu dòng tiền trong {horizon} ngày tới</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            Biểu đồ dòng tiền {horizon} ngày (triệu ₫)
          </h2>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 20, left: 4 }}
              onClick={(e) => e?.activePayload && setSelected(e.activePayload[0]?.payload as DailyFlow)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} angle={-35} textAnchor="end" interval={Math.floor(chartData.length / 8)} />
              <YAxis yAxisId="bar" tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${(v / 1e6).toFixed(0)}`} />
              <YAxis yAxisId="line" orientation="right" tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${(v / 1e6).toFixed(0)}`} />
              <Tooltip
                formatter={(v: number, name: string) => [`${compact(v)}₫`, name]}
                labelFormatter={(l) => `Ngày ${l}`}
              />
              <ReferenceLine yAxisId="bar" y={0} stroke="#e5e7eb" />
              <Bar yAxisId="bar" dataKey="net" name="Ròng ngày" radius={[3, 3, 0, 0]} maxBarSize={16}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={entry.net >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
              <Line yAxisId="line" type="monotone" dataKey="cumulative" name="Tích lũy"
                stroke="#6366f1" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>

          {selected && (
            <div className="mt-3 p-3 bg-indigo-50 rounded-lg text-sm flex flex-wrap gap-4">
              <span className="text-gray-600">📅 {selected.date}</span>
              <span className="text-emerald-700">↑ Thu: {compact(selected.expected_in)}₫</span>
              <span className="text-red-700">↓ Chi: {compact(selected.expected_out)}₫</span>
              <span className={`font-semibold ${selected.net >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                Ròng: {compact(selected.net)}₫
              </span>
            </div>
          )}
        </div>
      )}

      {/* Critical days alert */}
      {chartData.some((d) => d.cumulative < 0) && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-red-700 mb-2">⚠️ Nguy Cơ Thiếu Tiền</h2>
          <div className="space-y-1">
            {chartData.filter((d) => d.cumulative < 0).slice(0, 5).map((d) => (
              <p key={d.date} className="text-sm text-red-700">
                Ngày {formatDate(d.date)}: Dự kiến tích lũy <strong>{compact(d.cumulative)}₫</strong>
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Critical dates list (largest net flows) */}
      {criticalDates.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">📅 Ngày Cần Chú Ý</h2>
          <div className="space-y-2">
            {criticalDates.map((d) => (
              <div key={d.date} className={`flex items-center justify-between text-sm rounded-lg px-3 py-2 ${d.cumulative < 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${d.net >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <span className="text-gray-700 font-medium">{formatDateFull(d.date)}</span>
                  <span className="text-xs text-gray-400">{d.net >= 0 ? 'Thu tiền / Thanh toán đến' : 'Trả tiền / Nghĩa vụ đến hạn'}</span>
                </div>
                <span className={`font-bold ${d.net >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {d.net >= 0 ? '+' : ''}{compact(d.net)}₫
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Overdue AR */}
      {(data?.overdue_ar.length ?? 0) > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">🔴 Công Nợ Quá Hạn (AR)</h2>
          <div className="space-y-3">
            {data!.overdue_ar.map((inv) => (
              <div key={inv.id} className="border border-gray-100 rounded-lg p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{inv.counterparty_name}</p>
                    <p className="text-xs text-gray-400">{inv.invoice_number} · {inv.counterparty_tax_code}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-gray-900 text-sm">{compact(Number(inv.total_amount))}₫</p>
                    <p className="text-xs text-red-500">Trễ {daysOverdue(inv.payment_due_date)} ngày</p>
                  </div>
                </div>
                {/* Mark paid */}
                {markingPaid === inv.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)}
                      className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5" />
                    <button onClick={() => void handleMarkPaid(inv.id)} disabled={marking}
                      className="text-xs px-3 py-1.5 bg-emerald-600 text-white rounded-lg font-medium disabled:opacity-50">
                      {marking ? '…' : 'Xác nhận'}
                    </button>
                    <button onClick={() => setMarkingPaid(null)}
                      className="text-xs px-2.5 py-1.5 border border-gray-200 rounded-lg text-gray-500">
                      Huỷ
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setMarkingPaid(inv.id)}
                    className="mt-2 text-xs px-2.5 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg font-medium hover:bg-emerald-100">
                    ✓ Đánh dấu đã thu
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Tổng: <strong>{compact(data!.overdue_ar.reduce((s, r) => s + Number(r.total_amount), 0))}₫</strong>
          </p>
        </div>
      )}
    </div>
  );
}
