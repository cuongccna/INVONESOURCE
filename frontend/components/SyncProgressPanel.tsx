'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getAccessToken } from '../lib/apiClient';
import apiClient from '../lib/apiClient';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface JobProgress {
  jobId: string;
  state: 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';
  progress: number;
  invoicesFetched: number;
  currentPage: number;
  totalPages: number | null;
  currentMonth: string;
  message: string;
  error: string | null;
}

interface SyncProgressPanelProps {
  jobIds: string[];
  companyId: string;
  onClose: () => void;
  onDone?: () => void;
}

export default function SyncProgressPanel({ jobIds, companyId, onClose, onDone }: SyncProgressPanelProps) {
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({});
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const eventSourcesRef = useRef<EventSource[]>([]);

  const cleanup = useCallback(() => {
    eventSourcesRef.current.forEach((es) => es.close());
    eventSourcesRef.current = [];
  }, []);

  useEffect(() => {
    if (cancelled) return; // don't reconnect after cancel
    cleanup();

    for (const jobId of jobIds) {
      const token = getAccessToken();
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (companyId) params.set('companyId', companyId);
      const url = `${API_URL}/api/sync/progress/${encodeURIComponent(jobId)}?${params.toString()}`;
      const es = new EventSource(url);
      eventSourcesRef.current.push(es);

      es.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as JobProgress;
          setJobs((prev) => ({ ...prev, [data.jobId]: data }));
        } catch { /* ignore parse errors */ }
      };

      es.onerror = () => {
        es.close();
      };
    }

    return cleanup;
  }, [jobIds, cancelled, cleanup]);

  const handleCancel = async () => {
    if (cancelling || cancelled) return;
    setCancelling(true);
    try {
      await apiClient.delete('/sync/cancel');
      cleanup();
      setCancelled(true);
    } catch {
      // Even if backend call fails, mark cancelled so the UI unblocks
      cleanup();
      setCancelled(true);
    } finally {
      setCancelling(false);
    }
  };

  // Check if all jobs are done
  const allDone = cancelled || (jobIds.length > 0 && jobIds.every((id) => {
    const j = jobs[id];
    return j && (j.state === 'completed' || j.state === 'failed');
  }));
  const anyFailed = !cancelled && jobIds.some((id) => jobs[id]?.state === 'failed');
  const totalFetched = Object.values(jobs).reduce((s, j) => s + (j.invoicesFetched ?? 0), 0);

  useEffect(() => {
    if (allDone && !anyFailed && !cancelled && onDone) {
      const t = setTimeout(onDone, 1500);
      return () => clearTimeout(t);
    }
  }, [allDone, anyFailed, cancelled, onDone]);

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {!allDone && (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary-600 border-t-transparent" />
          )}
          {allDone && cancelled && <span className="text-amber-500 text-lg">⏹</span>}
          {allDone && !cancelled && !anyFailed && <span className="text-green-600 text-lg">✅</span>}
          {allDone && !cancelled && anyFailed && <span className="text-red-600 text-lg">❌</span>}
          <h4 className="font-semibold text-sm text-gray-900">
            {cancelled
              ? `Đã hủy — đã xử lý ${totalFetched} hóa đơn`
              : allDone
              ? anyFailed ? 'Đồng bộ gặp lỗi' : `Hoàn thành — ${totalFetched} hóa đơn`
              : 'Đang đồng bộ hóa đơn...'}
          </h4>
        </div>
        {allDone && (
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
        )}
      </div>

      {/* Job rows */}
      <div className="space-y-2">
        {jobIds.map((id) => {
          const j = jobs[id];
          const pct = j ? Math.min(100, Math.max(0, j.progress)) : 0;
          const label = j?.currentMonth || id.split('-').pop() || '';
          const stateLabel = cancelled
            ? (j?.state === 'completed' ? `✅ ${j.invoicesFetched} HĐ` : '⏹ Đã hủy')
            : !j ? 'Đang kết nối...'
            : j.state === 'waiting' || j.state === 'delayed' ? 'Chờ...'
            : j.state === 'active' ? j.message || `${pct}%`
            : j.state === 'completed' ? `✅ ${j.invoicesFetched} HĐ`
            : `❌ ${j.error?.slice(0, 80) ?? 'Lỗi'}`;

          return (
            <div key={id}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-gray-600 font-medium">{label}</span>
                <span className="text-gray-500">{stateLabel}</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    cancelled && j?.state !== 'completed' ? 'bg-amber-400'
                    : j?.state === 'completed' ? 'bg-green-500'
                    : j?.state === 'failed' ? 'bg-red-500'
                    : 'bg-primary-500'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {!allDone && (
          <button
            onClick={() => void handleCancel()}
            disabled={cancelling}
            className="flex-1 text-sm py-2 border border-red-200 text-red-600 rounded-xl font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            {cancelling ? 'Đang hủy...' : '⏹ Hủy đồng bộ'}
          </button>
        )}
        {allDone && !anyFailed && !cancelled && (
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2 bg-primary-600 text-white rounded-xl font-medium"
          >
            Xem hóa đơn vừa đồng bộ
          </button>
        )}
        {allDone && (anyFailed || cancelled) && (
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2 border border-gray-300 rounded-xl text-gray-700"
          >
            Đóng
          </button>
        )}
      </div>
    </div>
  );
}