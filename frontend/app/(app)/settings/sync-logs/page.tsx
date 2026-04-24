'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface SyncLog {
  id: string;
  provider: string;
  started_at: string;
  finished_at: string | null;
  records_fetched: number;
  records_created: number;
  records_updated: number;
  errors_count: number;
  error_detail: string | null;
}

interface PaginatedResponse {
  data: SyncLog[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
const PROVIDER_LABELS: Record<string, string> = {
  gdt_intermediary: 'GDT Intermediary',
};

function duration(start: string, end: string | null): string {
  if (!end) return '…';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

/* ─── Main Page ───────────────────────────────────────────────────────────── */
export default function SyncLogsPage() {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [provider, setProvider] = useState('');
  const [selected, setSelected] = useState<SyncLog | null>(null);

  const load = useCallback(async (p = 1, prov = provider) => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page: p, pageSize: 20 };
      if (prov) params.provider = prov;
      const res = await apiClient.get<PaginatedResponse>('/connectors/sync-logs', { params });
      setLogs(res.data.data);
      setPage(res.data.pagination.page);
      setTotalPages(res.data.pagination.totalPages);
      setTotal(res.data.pagination.total);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => { void load(1, provider); }, [provider, load]);

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <BackButton fallbackHref="/dashboard" className="mb-4" />
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Lịch sử đồng bộ</h1>
          <p className="text-sm text-gray-500 mt-1">{total} bản ghi</p>
        </div>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-primary-300"
        >
          <option value="">Tất cả providers</option>
          {Object.entries(PROVIDER_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-3xl mb-3">📋</p>
          <p className="font-medium">Chưa có lịch sử đồng bộ</p>
          <p className="text-sm mt-1">Dữ liệu sẽ xuất hiện sau khi chạy sync lần đầu</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Provider</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Thời gian</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Kéo về</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Tạo mới</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Cập nhật</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Thời lượng</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="hover:bg-gray-50/70 cursor-pointer"
                  onClick={() => setSelected(log)}
                >
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {PROVIDER_LABELS[log.provider] ?? log.provider}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    <span title={new Date(log.started_at).toLocaleString('vi-VN')}>
                      {timeAgo(log.started_at)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">{log.records_fetched}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-green-600 font-medium">{log.records_created}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-blue-600">{log.records_updated}</td>
                  <td className="px-4 py-3 text-right text-gray-500 font-mono text-xs">
                    {duration(log.started_at, log.finished_at)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {log.errors_count > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                        ⚠ {log.errors_count} lỗi
                      </span>
                    ) : log.finished_at ? (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                        ✓ OK
                      </span>
                    ) : (
                      <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium animate-pulse">
                        Đang chạy
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => void load(page - 1)}
            disabled={page <= 1}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            ← Trang trước
          </button>
          <span className="text-sm text-gray-500">
            Trang {page} / {totalPages}
          </span>
          <button
            onClick={() => void load(page + 1)}
            disabled={page >= totalPages}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50"
          >
            Trang sau →
          </button>
        </div>
      )}

      {/* ── Detail Modal ── */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4 mb-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900 text-lg">
                {PROVIDER_LABELS[selected.provider] ?? selected.provider}
              </h2>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Bắt đầu</p>
                <p className="font-medium text-gray-800">{new Date(selected.started_at).toLocaleString('vi-VN')}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Kết thúc</p>
                <p className="font-medium text-gray-800">
                  {selected.finished_at ? new Date(selected.finished_at).toLocaleString('vi-VN') : 'Đang chạy'}
                </p>
              </div>
              <div className="bg-green-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Hóa đơn kéo về</p>
                <p className="font-bold text-green-700 text-xl">{selected.records_fetched}</p>
              </div>
              <div className="bg-blue-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-1">Tạo mới / Cập nhật</p>
                <p className="font-bold text-blue-700 text-xl">
                  {selected.records_created} / {selected.records_updated}
                </p>
              </div>
            </div>
            {selected.errors_count > 0 && selected.error_detail && (
              <div className="bg-red-50 rounded-xl p-3">
                <p className="text-xs font-semibold text-red-600 mb-1">Chi tiết lỗi ({selected.errors_count})</p>
                <pre className="text-xs text-red-700 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-40 overflow-y-auto">
                  {selected.error_detail}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
