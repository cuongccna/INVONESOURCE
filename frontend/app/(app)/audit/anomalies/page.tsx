'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';

interface Anomaly {
  id: string;
  anomaly_type: string;
  severity: 'critical' | 'warning' | 'info';
  seller_name: string | null;
  item_name: string | null;
  unit_price: number;
  baseline_price: number;
  pct_deviation: number;
  invoice_number?: string;
  ai_explanation: string | null;
  ai_action: string | null;
  is_acknowledged: boolean;
  created_at: string;
}

interface AnomalyResponse {
  data: {
    data: Anomaly[];
    summary: { critical: number; warning: number; info: number; total_overcharge_estimate: number };
    meta: { total: number; page: number; pageSize: number; totalPages: number };
  };
}

const SEV_BORDER: Record<string, string> = {
  critical: 'border-l-red-500',
  warning: 'border-l-amber-500',
  info: 'border-l-blue-500',
};
const SEV_BADGE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info: 'bg-blue-100 text-blue-700',
};
const SEV_LABEL: Record<string, string> = {
  critical: '?? NghiÃªm tr?ng',
  warning: '?? C?n xem xÃ©t',
  info: '?? ThÃ´ng tin',
};

const TYPE_LABEL: Record<string, string> = {
  price_spike: 'Tang giÃ¡ d?t bi?n',
  new_vendor_large: 'NCC m?i giao d?ch l?n',
  invoice_splitting: 'Chia nh? hÃ³a don',
  multi_vendor_same_item: 'ChÃªnh l?ch NCC',
};

import { formatVNDFull, formatVND } from '../../../../utils/formatCurrency';

const fmtVnd = formatVNDFull;
const fmtM = formatVND;

export default function AuditAnomaliesPage() {
  const [rows, setRows] = useState<Anomaly[]>([]);
  const [summary, setSummary] = useState({ critical: 0, warning: 0, info: 0, total_overcharge_estimate: 0 });
  const [loading, setLoading] = useState(true);
  const [severity, setSeverity] = useState('');
  const [ackNote, setAckNote] = useState('');
  const [ackId, setAckId] = useState<string | null>(null);
  const criticalRef = useRef<HTMLDivElement>(null);

  const load = async (sev = severity) => {
    setLoading(true);
    try {
      const q = sev ? `?severity=${sev}&unacknowledged=true` : '?unacknowledged=true';
      const res = await apiClient.get<AnomalyResponse>(`/audit/anomalies${q}`);
      setRows((res.data.data.data ?? []).map(r => ({
        ...r,
        pct_deviation:  Number(r.pct_deviation),
        unit_price:     Number(r.unit_price),
        baseline_price: Number(r.baseline_price),
      })));
      setSummary(res.data.data.summary);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(severity); }, [severity]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setLoading(true);
    try {
      await apiClient.post('/audit/scan', {});
    } catch { /* silent */ }
    await load(severity);
  };

  const confirmAck = async () => {
    if (!ackId) return;
    await apiClient.patch(`/audit/anomalies/${ackId}/acknowledge`, { note: ackNote });
    setAckId(null);
    setAckNote('');
    await load(severity);
  };

  const escalate = async (id: string) => {
    try {
      await apiClient.post(`/audit/anomalies/${id}/escalate`, {});
    } catch { /* silent */ }
  };

  const totalItems = summary.critical + summary.warning + summary.info;

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5 pb-8">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-2xl">???</span>
          <h1 className="text-2xl font-bold text-gray-900">Ki?m ToÃ¡n AI</h1>
        </div>
        <p className="text-sm text-gray-500">GiÃ¡m sÃ¡t 24/7 Â· C?p nh?t sau m?i l?n d?ng b?</p>
      </div>

      {/* Critical alert banner */}
      {summary.critical > 0 && (
        <div className="bg-red-600 text-white rounded-xl p-4 flex items-center justify-between gap-3">
          <div>
            <p className="font-bold text-sm">?? PhÃ¡t hi?n {summary.critical} b?t thu?ng nghiÃªm tr?ng</p>
            <p className="text-xs text-red-100 mt-0.5">
              U?c tÃ­nh ~{fmtM(summary.total_overcharge_estimate)} chi phÃ­ b?t thu?ng
            </p>
          </div>
          <button
            onClick={() => criticalRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="text-xs bg-white text-red-600 font-bold px-3 py-1.5 rounded-lg whitespace-nowrap"
          >
            Xem ngay
          </button>
        </div>
      )}

      {/* Summary cards + scan button */}
      <div className="flex items-center gap-2">
        <div className="flex-1 grid grid-cols-3 gap-2">
          <div className="bg-white rounded-xl shadow-sm p-3 text-center">
            <p className="text-xs text-gray-400">Critical</p>
            <p className="text-xl font-bold text-red-600">{summary.critical}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3 text-center">
            <p className="text-xs text-gray-400">Warning</p>
            <p className="text-xl font-bold text-amber-600">{summary.warning}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-3 text-center">
            <p className="text-xs text-gray-400">Info</p>
            <p className="text-xl font-bold text-blue-600">{summary.info}</p>
          </div>
        </div>
        <button
          onClick={() => void scan()}
          disabled={loading}
          className="text-xs px-3 py-2 rounded-xl bg-red-50 text-red-700 font-semibold hover:bg-red-100 disabled:opacity-50 shrink-0"
        >
          ? QuÃ©t l?i
        </button>
      </div>

      {/* Overcharge estimate */}
      {summary.total_overcharge_estimate > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <p className="text-xs text-amber-700">
            U?c tÃ­nh t?ng chi phÃ­ b?t thu?ng ti?m tÃ ng:{' '}
            <span className="font-bold text-amber-800">{fmtM(summary.total_overcharge_estimate)} d?ng</span>
          </p>
        </div>
      )}

      {/* Severity filter tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {[
          { key: '', label: `T?t c? (${totalItems})` },
          { key: 'critical', label: `?? NghiÃªm tr?ng (${summary.critical})` },
          { key: 'warning', label: `?? C?n xem (${summary.warning})` },
          { key: 'info', label: `?? ThÃ´ng tin (${summary.info})` },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSeverity(key)}
            className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap font-medium transition-colors ${
              severity === key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-5xl mb-4">?</p>
          <p className="font-semibold text-gray-700">KhÃ´ng phÃ¡t hi?n b?t thu?ng trong k? nÃ y</p>
          <p className="text-sm text-gray-400 mt-1">H? th?ng ki?m tra liÃªn t?c sau m?i l?n d?ng b? hÃ³a don</p>
        </div>
      ) : (
        <div ref={criticalRef} className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className={`bg-white rounded-xl shadow-sm p-4 space-y-3 border-l-4 ${SEV_BORDER[r.severity]}`}
            >
              {/* Card header */}
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${SEV_BADGE[r.severity]}`}>
                      {SEV_LABEL[r.severity]}
                    </span>
                    <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-medium">
                      {TYPE_LABEL[r.anomaly_type] ?? r.anomaly_type}
                    </span>
                  </div>
                  <p className="text-base font-bold text-gray-900">{r.item_name ?? 'M?t hÃ ng khÃ´ng xÃ¡c d?nh'}</p>
                  <p className="text-xs text-gray-500">
                    {r.seller_name} Â· {new Date(r.created_at).toLocaleDateString('vi-VN')}
                    {r.invoice_number && ` Â· HÃ #${r.invoice_number}`}
                  </p>
                </div>
              </div>

              {/* Price comparison */}
              <div className="bg-gray-50 rounded-lg p-2.5 flex items-center justify-between gap-2 text-sm">
                <div className="text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">GiÃ¡ bÃ¬nh quÃ¢n</p>
                  <p className="font-medium text-gray-700">{fmtVnd(r.baseline_price)}</p>
                </div>
                <span className="text-gray-300 text-lg">??</span>
                <div className="text-center">
                  <p className="text-[10px] text-gray-400 mb-0.5">GiÃ¡ nÃ y</p>
                  <p className="font-bold text-gray-900">{fmtVnd(r.unit_price)}</p>
                </div>
                <div className={`text-center ${r.pct_deviation > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  <p className="text-[10px] text-gray-400 mb-0.5">L?ch</p>
                  <p className="font-bold text-base">
                    {r.pct_deviation > 0 ? '+' : ''}{r.pct_deviation.toFixed(1)}% {r.pct_deviation > 0 ? '?' : '?'}
                  </p>
                </div>
              </div>

              {/* AI explanation */}
              {(r.ai_explanation || r.ai_action) && (
                <div className="bg-blue-50 rounded-lg p-3 space-y-1">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-base">??</span>
                    <span className="text-xs font-semibold text-blue-800">PhÃ¢n tÃ­ch AI</span>
                  </div>
                  {r.ai_explanation && (
                    <p className="text-xs text-blue-900 leading-relaxed">{r.ai_explanation}</p>
                  )}
                  {r.ai_action && (
                    <p className="text-xs text-blue-700 font-medium mt-1">Ã? xu?t: {r.ai_action}</p>
                  )}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <button
                  onClick={() => { setAckId(r.id); setAckNote(''); }}
                  className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium"
                >
                  ? ÃÃ¡nh d?u OK
                </button>
                <button
                  onClick={() => void escalate(r.id)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 font-medium"
                >
                  ?? BÃ¡o lÃªn GiÃ¡m d?c
                </button>
                {r.invoice_number && (
                  <Link
                    href={`/invoices?search=${r.invoice_number}`}
                    className="text-xs px-3 py-1.5 rounded-lg bg-primary-50 text-primary-700 hover:bg-primary-100 font-medium"
                  >
                    Xem hÃ³a don g?c
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Acknowledge modal */}
      {ackId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-sm p-5 space-y-4">
            <h3 className="font-semibold text-gray-900">ÃÃ¡nh d?u dÃ£ ki?m tra</h3>
            <textarea
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder="Ghi chÃº (tÃ¹y ch?n)..."
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-xl p-3 resize-none focus:outline-none focus:ring-2 focus:ring-primary-400"
            />
            <div className="flex gap-2">
              <button onClick={() => setAckId(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600">
                H?y
              </button>
              <button onClick={() => void confirmAck()} className="flex-1 py-2.5 rounded-xl bg-primary-600 text-white text-sm font-semibold">
                XÃ¡c nh?n
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


interface AnomalyResponse {
  data: {
    data: Anomaly[];
    summary: { critical: number; warning: number; info: number; total_overcharge_estimate: number };
    meta: { total: number; page: number; pageSize: number; totalPages: number };
  };
}
