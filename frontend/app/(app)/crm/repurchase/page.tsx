'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';

interface Prediction {
  id: string;
  buyer_tax_code: string;
  buyer_name: string | null;
  display_item_name: string | null;
  predicted_next_date: string;
  days_until_predicted: number;
  avg_quantity?: number;
  avg_interval_days?: number;
  unit?: string;
  confidence: 'high' | 'medium' | 'low';
  is_actioned: boolean;
}

interface PaginatedPredictions {
  data: Prediction[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

interface RepurchaseStats {
  total_opportunities: number;
  accuracy_pct: number;
  last_run_at: string | null;
}

const CONF_LABEL: Record<string, string> = { high: 'Cao ✓', medium: 'Trung bình ~', low: 'Thấp' };
const CONF_CLASS: Record<string, string> = {
  high: 'bg-emerald-100 text-emerald-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-500',
};

function urgencyCircle(days: number) {
  if (days <= 3) return 'bg-red-500';
  if (days <= 7) return 'bg-orange-400';
  return 'bg-blue-400';
}

function timeAgo(iso: string | null) {
  if (!iso) return 'chưa có';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diff < 60) return `${diff} phút trước`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)} ngày trước`;
}

const DAYS_TABS: Array<{ label: string; value: 7 | 14 | 30 }> = [
  { label: 'Tuần này (7 ngày)', value: 7 },
  { label: '2 tuần', value: 14 },
  { label: 'Tháng này (30 ngày)', value: 30 },
];

export default function RepurchasePage() {
  const [daysRange, setDaysRange] = useState<7 | 14 | 30>(7);
  const [rows, setRows] = useState<Prediction[]>([]);
  const [silent, setSilent] = useState<Prediction[]>([]);
  const [silentOpen, setSilentOpen] = useState(false);
  const [stats, setStats] = useState<RepurchaseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [noting, setNoting] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  const load = async (range: 7 | 14 | 30) => {
    setLoading(true);
    try {
      const [predRes, silentRes, statsRes] = await Promise.all([
        apiClient.get<PaginatedPredictions>(`/crm/repurchase?daysRange=${range}&page=1&pageSize=100`),
        apiClient.get<{ data: Prediction[] }>('/crm/repurchase/silent'),
        apiClient.get<{ data: RepurchaseStats }>('/crm/repurchase/stats').catch(() => ({ data: { data: null } })),
      ]);
      setRows(predRes.data.data);
      setSilent(silentRes.data.data);
      setStats((statsRes as { data: { data: RepurchaseStats | null } }).data.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(daysRange); }, [daysRange]); // eslint-disable-line react-hooks/exhaustive-deps

  const recalculate = async () => {
    setLoading(true);
    try {
      await apiClient.post('/crm/repurchase/calculate', {});
      await load(daysRange);
    } catch {
      setLoading(false);
    }
  };

  const actioned = async (id: string, note?: string) => {
    await apiClient.patch(`/crm/repurchase/${id}/action`, { note: note ?? 'Đã liên hệ khách hàng' });
    setRows((prev) => prev.filter((r) => r.id !== id));
    setNoting(null);
    setNoteText('');
  };

  const visibleRows = rows.filter((r) => !r.is_actioned && r.days_until_predicted <= daysRange && r.days_until_predicted >= 0);

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dự Đoán Mua Lại</h1>
          {stats && (
            <p className="text-xs text-gray-500 mt-0.5">
              Cập nhật: {timeAgo(stats.last_run_at)} ·{' '}
              {stats.total_opportunities} cơ hội · Độ chính xác: {stats.accuracy_pct}%
            </p>
          )}
        </div>
        <button onClick={() => void recalculate()}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
          ↺ Tính lại
        </button>
      </div>

      {/* Timeline tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {DAYS_TABS.map((t) => (
          <button key={t.value} onClick={() => setDaysRange(t.value)}
            className={`whitespace-nowrap text-xs px-3 py-1.5 rounded-full transition-colors ${
              daysRange === t.value ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600" />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400 space-y-3">
          <p className="text-4xl">📊</p>
          <p className="font-medium text-gray-600">Hệ thống đang phân tích dữ liệu</p>
          <p className="text-sm">Cần ít nhất 3 lần mua hàng từ cùng 1 khách để dự đoán.<br />
          Dự đoán sẽ xuất hiện tự động sau đồng bộ tiếp theo.</p>
        </div>
      ) : (
        <>
          {/* Opportunity cards */}
          <div className="space-y-3">
            {visibleRows.length === 0 && (
              <div className="bg-white rounded-xl shadow-sm p-6 text-center text-gray-400">
                <p>Không có cơ hội trong {daysRange} ngày tới</p>
              </div>
            )}
            {visibleRows.sort((a, b) => a.days_until_predicted - b.days_until_predicted).map((r) => (
              <div key={r.id} className="bg-white rounded-xl shadow-sm p-4 flex gap-3">
                {/* Urgency circle */}
                <div className="shrink-0 mt-0.5">
                  <div className={`w-3 h-3 rounded-full ${urgencyCircle(r.days_until_predicted)}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900 truncate">
                      {r.buyer_name ?? r.buyer_tax_code}
                    </p>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded shrink-0 ${CONF_CLASS[r.confidence]}`}>
                      {CONF_LABEL[r.confidence]}
                    </span>
                  </div>
                  {r.display_item_name && (
                    <p className="text-xs text-gray-500 mt-0.5">Sản phẩm: {r.display_item_name}</p>
                  )}
                  <p className="text-xs text-gray-500">
                    Dự kiến: {new Date(r.predicted_next_date).toLocaleDateString('vi-VN')}{' '}
                    <span className={`font-semibold ${r.days_until_predicted <= 3 ? 'text-red-600' : r.days_until_predicted <= 7 ? 'text-orange-600' : 'text-blue-600'}`}>
                      (còn {r.days_until_predicted} ngày)
                    </span>
                  </p>
                  {r.avg_interval_days && (
                    <p className="text-xs text-gray-400">
                      Trung bình: {r.avg_quantity ?? '?'} {r.unit ?? ''} / {r.avg_interval_days} ngày
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3">
                    {noting === r.id ? (
                      <div className="flex-1 flex gap-2">
                        <input
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="Ghi chú..."
                          className="flex-1 text-xs border border-gray-200 rounded px-2 py-1"
                          autoFocus
                        />
                        <button onClick={() => void actioned(r.id, noteText)}
                          className="text-xs px-2 py-1 bg-primary-600 text-white rounded">Lưu</button>
                        <button onClick={() => setNoting(null)}
                          className="text-xs px-2 py-1 border border-gray-200 rounded text-gray-500">Huỷ</button>
                      </div>
                    ) : (
                      <>
                        <button onClick={() => void actioned(r.id)}
                          className="text-xs text-primary-600 hover:underline font-medium">
                          ✓ Đã liên hệ
                        </button>
                        <button onClick={() => setNoting(r.id)}
                          className="text-xs text-gray-400 hover:text-gray-600">
                          📝 Ghi chú
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Silent customers section */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <button
              onClick={() => setSilentOpen(!silentOpen)}
              className="w-full px-4 py-3 flex items-center justify-between text-left"
            >
              <span className="text-sm font-semibold text-gray-700">
                👻 Khách hàng im lặng{' '}
                {silent.length > 0 && (
                  <span className="ml-1 text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-bold">
                    {silent.length}
                  </span>
                )}
              </span>
              <span className="text-gray-400 text-sm">{silentOpen ? '▲' : '▼'}</span>
            </button>
            {silentOpen && (
              <div className="border-t border-gray-100 divide-y divide-gray-50">
                {silent.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-gray-400">Không có khách im lặng bất thường</p>
                ) : (
                  silent.map((s) => (
                    <div key={s.id} className="px-4 py-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{s.buyer_name ?? s.buyer_tax_code}</p>
                        {s.display_item_name && (
                          <p className="text-xs text-gray-500">{s.display_item_name}</p>
                        )}
                        <p className="text-xs text-red-500 font-medium">
                          {Math.abs(s.days_until_predicted)} ngày quá hạn dự đoán
                        </p>
                      </div>
                      <a
                        href={`tel:?buyerTaxCode=${s.buyer_tax_code}`}
                        className="shrink-0 text-xs px-2.5 py-1.5 bg-red-50 text-red-600 rounded-lg font-medium hover:bg-red-100"
                      >
                        📞 Gọi ngay
                      </a>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
