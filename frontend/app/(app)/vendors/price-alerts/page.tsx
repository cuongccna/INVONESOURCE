'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';

interface PriceAlert {
  id: string;
  seller_name: string;
  seller_tax_code: string;
  item_name: string;
  unit_price: string;
  baseline_price: string;
  pct_deviation: string;
  invoice_number?: string;
  anomaly_type?: string;
  severity: 'critical' | 'warning' | 'info';
  ai_explanation?: string;
  ai_action?: string;
  is_acknowledged: boolean;
  created_at: string;
  // legacy fallback fields
  prev_price?: string;
  curr_price?: string;
  change_pct?: string;
  period_month?: number;
  period_year?: number;
}

interface AlertsResponse {
  data: PriceAlert[];
  meta: { total: number; total_overcharge_estimate?: number };
}

import { formatVND, formatVNDFull } from '../../../../utils/formatCurrency';

const fmt = (n: string | number) => formatVNDFull(n);
const fmtM = formatVND;

const SEV_BORDER: Record<string, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-amber-400',
  info: 'border-l-blue-400',
};
const SEV_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info: 'bg-blue-100 text-blue-700',
};
const SEV_LABEL: Record<string, string> = {
  critical: 'Nghiêm trọng',
  warning: 'Cần xem xét',
  info: 'Thông tin',
};
const TYPE_LABEL: Record<string, string> = {
  price_spike: 'Tăng giá đột biến',
  new_vendor_large: 'NCC mới giao dịch lớn',
  invoice_splitting: 'Chia nhỏ hóa đơn',
  multi_vendor_same_item: 'Chênh lệch NCC',
  higher_than_market: 'Cao hơn thị trường',
};

type SevFilter = 'all' | 'critical' | 'warning' | 'info' | 'acknowledged';

export default function PriceAlertsPage() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [overchargeEstimate, setOverchargeEstimate] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sevFilter, setSevFilter] = useState<SevFilter>('all');
  const [scanning, setScanning] = useState(false);
  const [page, setPage] = useState(1);
  const [ackModal, setAckModal] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const unack = sevFilter !== 'acknowledged';
      const sev = sevFilter !== 'all' && sevFilter !== 'acknowledged' ? `&severity=${sevFilter}` : '';
      const res = await apiClient.get<AlertsResponse>(
        `/vendors/price-alerts?page=${page}&pageSize=50&unacknowledged=${unack}${sev}`
      );
      setAlerts(res.data.data);
      setTotal(res.data.meta.total);
      setOverchargeEstimate(res.data.meta.total_overcharge_estimate ?? 0);
    } catch { /* silent */ } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [sevFilter, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setScanning(true);
    try {
      await apiClient.post('/vendors/price-alerts/scan', {});
      await load();
    } catch { /* silent */ } finally { setScanning(false); }
  };

  const acknowledge = async (id: string) => {
    await apiClient.patch(`/vendors/price-alerts/${id}/acknowledge`, {});
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    setAckModal(null);
  };

  const FILTERS: Array<{ key: SevFilter; label: string }> = [
    { key: 'all', label: 'Tất cả' },
    { key: 'critical', label: 'Nghiêm trọng' },
    { key: 'warning', label: 'Cần xem xét' },
    { key: 'info', label: 'Thông tin' },
    { key: 'acknowledged', label: 'Đã xử lý' },
  ];

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cảnh Báo Biến Động Giá</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} cảnh báo chưa xử lý</p>
        </div>
        <button onClick={scan} disabled={scanning}
          className="text-xs px-3 py-1.5 rounded-lg bg-primary-600 text-white font-semibold disabled:opacity-50 hover:bg-primary-700">
          {scanning ? 'Đang quét…' : '🔍 Quét ngay'}
        </button>
      </div>

      {/* Total overcharge estimate banner */}
      {overchargeEstimate > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-2">
          <span className="text-amber-500 text-lg mt-0.5">⚠️</span>
          <div>
            <p className="text-sm font-semibold text-amber-800">
              Phát hiện ~{fmtM(overchargeEstimate)} đồng chi phí bất thường tiềm tàng
            </p>
            <p className="text-xs text-amber-600 mt-0.5">Xem xét từng cảnh báo để xác minh</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => { setSevFilter(f.key); setPage(1); }}
            className={`whitespace-nowrap text-xs px-3 py-1.5 rounded-full transition-colors font-medium ${
              sevFilter === f.key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-amber-500" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">✅</p>
          <p>Không có cảnh báo giá</p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((a) => {
            // Support both new and legacy field names
            const currPrice = Number(a.unit_price ?? a.curr_price ?? 0);
            const basePrice = Number(a.baseline_price ?? a.prev_price ?? 0);
            const devPct = Number(a.pct_deviation ?? a.change_pct ?? 0);
            const isUp = devPct > 0;
            const sev = a.severity ?? (isUp ? 'warning' : 'info');
            const anomalyType = a.anomaly_type ?? (isUp ? 'price_spike' : '');

            return (
              <div key={a.id} className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${SEV_BORDER[sev] ?? 'border-l-gray-200'}`}>
                {/* Badge row */}
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${SEV_BADGE[sev]}`}>
                    {SEV_LABEL[sev]}
                  </span>
                  {anomalyType && (
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                      {TYPE_LABEL[anomalyType] ?? anomalyType}
                    </span>
                  )}
                  {a.invoice_number && (
                    <span className="text-[10px] text-gray-400">HĐ: {a.invoice_number}</span>
                  )}
                </div>

                {/* Item name + supplier */}
                <p className="text-sm font-semibold text-gray-900">{a.item_name}</p>
                <p className="text-xs text-gray-500 mt-0.5">Nhà cung cấp: {a.seller_name}</p>

                {/* Price comparison */}
                <div className="flex items-center gap-2 mt-2">
                  <div className="text-xs text-gray-500">
                    <span className="text-gray-400">Giá bình quân:</span>{' '}
                    <span className="font-medium">{fmt(basePrice)}₫</span>
                  </div>
                  <span className="text-gray-300">→</span>
                  <div className="text-xs">
                    <span className="text-gray-400">Giá hiện tại:</span>{' '}
                    <span className="font-bold">{fmt(currPrice)}₫</span>{' '}
                    <span className={`font-bold ${isUp ? 'text-red-600' : 'text-green-600'}`}>
                      {isUp ? '▲' : '▼'} {Math.abs(devPct).toFixed(1)}%
                    </span>
                  </div>
                </div>

                {/* AI explanation */}
                {(a.ai_explanation || a.ai_action) && (
                  <div className="mt-3 bg-blue-50 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <span className="text-base">🤖</span>
                      <div className="flex-1 text-xs text-blue-800 space-y-1">
                        {a.ai_explanation && <p>{a.ai_explanation}</p>}
                        {a.ai_action && (
                          <p className="font-semibold">Đề xuất: {a.ai_action}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  <button onClick={() => setAckModal(a.id)}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 font-medium">
                    ✓ Đánh dấu OK
                  </button>
                  <a href={`/invoices?number=${a.invoice_number ?? ''}`}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 font-medium">
                    📄 Xem hóa đơn
                  </a>
                  <button
                    onClick={async () => {
                      try {
                        await apiClient.post('/notifications', {
                          type: 'PRICE_ALERT_ESCALATED',
                          title: `Cảnh báo giá: ${a.item_name}`,
                          message: `NCC ${a.seller_name} — ${Math.abs(devPct).toFixed(1)}% ${isUp ? 'tăng' : 'giảm'}`,
                        });
                      } catch { /* silent */ }
                    }}
                    className="text-xs px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 font-medium">
                    🔔 Báo lên quản lý
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {total > 50 && (
        <div className="flex justify-between">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 disabled:opacity-40">← Trước</button>
          <span className="text-xs text-gray-500">Trang {page} / {Math.ceil(total / 50)}</span>
          <button disabled={page >= Math.ceil(total / 50)} onClick={() => setPage(p => p + 1)}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 disabled:opacity-40">Sau →</button>
        </div>
      )}

      {/* Acknowledge confirmation modal */}
      {ackModal !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-base font-bold text-gray-900">Xác nhận đã xử lý</h3>
            <p className="text-sm text-gray-500">Cảnh báo này sẽ được đánh dấu là đã xem xét và ẩn khỏi danh sách.</p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => void acknowledge(ackModal)}
                className="flex-1 py-2 rounded-xl bg-primary-600 text-white text-sm font-semibold hover:bg-primary-700">
                Xác nhận
              </button>
              <button onClick={() => setAckModal(null)}
                className="flex-1 py-2 rounded-xl border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
                Huỷ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
