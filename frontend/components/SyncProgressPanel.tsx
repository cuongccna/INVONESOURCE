'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getAccessToken } from '../lib/apiClient';
import apiClient from '../lib/apiClient';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// If all jobs are still unresolved after this many ms, show a force-close button
const STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
// Max SSE reconnect attempts per job before giving up
const MAX_SSE_RETRIES = 4;
// Backoff delays (ms): 2s, 4s, 8s, 16s
const SSE_BACKOFF = [2000, 4000, 8000, 16000];

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

/** Format seconds → "Xm Ys" or "Xs" */
function formatSec(sec: number): string {
  if (sec <= 0) return '...';
  if (sec < 60) return `${Math.ceil(sec)}s`;
  return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
}

/**
 * Map a statusMessage from the bot into a human-readable Vietnamese label.
 * Known patterns come from sync.worker.ts job.updateProgress calls.
 */
function formatStatusMsg(msg: string, pct: number, fetched: number, page: number, totalPages: number | null): string {
  if (!msg) return pct > 0 ? `${pct}% — ${fetched} HĐ` : 'Đang khởi động...';

  const m = msg.toLowerCase();
  if (m.includes('kiểm tra proxy') || m.includes('proxy'))    return '🔌 Kiểm tra proxy...';
  if (m.includes('đăng nhập') || m.includes('login'))         return '🔐 Đang đăng nhập GDT...';
  if (m.includes('đầu ra') || m.includes('output')) {
    const stage = m.includes('sco') ? ' (SCO)' : '';
    const pageLabel = page > 0 ? `trang ${page}${totalPages ? '/' + totalPages : ''}` : 'đang quét';
    return `📤 HĐ đầu ra${stage} — ${pageLabel}${fetched > 0 ? ` · ${fetched} HĐ` : ''}`;
  }
  if (m.includes('đầu vào') || m.includes('input') || m.includes('mua vào')) {
    const stage = m.includes('sco') ? ' (SCO)' : '';
    const filter = msg.match(/TTXL\s*\d/i)?.[0]?.toUpperCase() ?? '';
    const pageLabel = page > 0 ? `trang ${page}${totalPages ? '/' + totalPages : ''}` : 'đang quét';
    return `📥 HĐ đầu vào${stage}${filter ? ` ${filter}` : ''} — ${pageLabel}${fetched > 0 ? ` · ${fetched} HĐ` : ''}`;
  }
  if (m.includes('xml'))                                       return `📄 Đang lấy XML (${fetched} HĐ)`;
  if (m.includes('hoàn thành') || m.includes('done'))         return `✅ Xong — ${fetched} HĐ`;

  // Generic: show message as-is with progress suffix
  return `${msg}${pct > 0 ? ` (${pct}%)` : ''}`;
}

export default function SyncProgressPanel({ jobIds, companyId, onClose, onDone }: SyncProgressPanelProps) {
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({});
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  // Jobs where SSE exhausted all retries — treated as timed-out
  const [stalledJobs, setStalledJobs] = useState<Set<string>>(new Set());
  // Whether the stall timeout has elapsed (shows force-close button)
  const [showForceClose, setShowForceClose] = useState(false);
  // Per-job: timestamp when state first became 'active'
  const activeStartRef = useRef<Record<string, number>>({});

  const eventSourcesRef = useRef<EventSource[]>([]);
  const retryCountRef = useRef<Record<string, number>>({});
  const retryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedAtRef = useRef(Date.now());
  const doneNotifiedRef = useRef(false);

  const cleanup = useCallback(() => {
    eventSourcesRef.current.forEach((es) => es.close());
    eventSourcesRef.current = [];
    Object.values(retryTimersRef.current).forEach(clearTimeout);
    retryTimersRef.current = {};
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
  }, []);

  const openSSE = useCallback((jobId: string) => {
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
        // Reset error counter on successful message
        retryCountRef.current[jobId] = 0;
        // Record when this job first became active (for ETA)
        if (data.state === 'active' && !activeStartRef.current[jobId]) {
          activeStartRef.current[jobId] = Date.now();
        }
        setJobs((prev) => ({ ...prev, [data.jobId]: data }));
        // Close SSE when terminal state received — no need to keep connection open
        if (data.state === 'completed' || data.state === 'failed') {
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      es.close();
      const attempts = (retryCountRef.current[jobId] ?? 0);
      if (attempts >= MAX_SSE_RETRIES) {
        // All retries exhausted — mark job as stalled (treat as done to unblock UI)
        setStalledJobs((prev) => new Set([...prev, jobId]));
        return;
      }
      retryCountRef.current[jobId] = attempts + 1;
      const delay = SSE_BACKOFF[Math.min(attempts, SSE_BACKOFF.length - 1)] ?? 16000;
      retryTimersRef.current[jobId] = setTimeout(() => {
        openSSE(jobId);
      }, delay);
    };
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (cancelled) return;
    cleanup();
    retryCountRef.current = {};
    activeStartRef.current = {};
    doneNotifiedRef.current = false;
    openedAtRef.current = Date.now();

    for (const jobId of jobIds) {
      openSSE(jobId);
    }

    // Stall safety-net: if some jobs are still unresolved after STALL_TIMEOUT_MS, show force-close
    stallTimerRef.current = setTimeout(() => {
      setShowForceClose(true);
    }, STALL_TIMEOUT_MS);

    return cleanup;
  }, [jobIds, cancelled, cleanup, openSSE]);

  const handleCancel = async () => {
    if (cancelling || cancelled) return;
    setCancelling(true);
    try {
      await apiClient.delete('/sync/cancel');
      cleanup();
      setCancelled(true);
    } catch {
      cleanup();
      setCancelled(true);
    } finally {
      setCancelling(false);
    }
  };

  // Job is done if: completed, failed, or SSE retries exhausted (stalled)
  const isJobDone = (id: string) => {
    const j = jobs[id];
    return stalledJobs.has(id) || (j != null && (j.state === 'completed' || j.state === 'failed'));
  };

  const allDone = cancelled || (jobIds.length > 0 && jobIds.every(isJobDone));
  const anyFailed = !cancelled && jobIds.some((id) => {
    return stalledJobs.has(id) || jobs[id]?.state === 'failed';
  });
  const totalFetched = Object.values(jobs).reduce((s, j) => s + (j.invoicesFetched ?? 0), 0);

  useEffect(() => {
    if (!allDone) {
      doneNotifiedRef.current = false;
      return;
    }

    if (!anyFailed && !cancelled && onDone && !doneNotifiedRef.current) {
      doneNotifiedRef.current = true;
      onDone();
    }
  }, [allDone, anyFailed, cancelled, onDone]);

  const retryCount = (id: string) => retryCountRef.current[id] ?? 0;
  const overallProgress = jobIds.length === 0
    ? 0
    : Math.round(jobIds.reduce((sum, id) => {
      const job = jobs[id];
      if (stalledJobs.has(id)) return sum + 100;
      if (!job) return sum;
      if (job.state === 'completed') return sum + 100;
      return sum + Math.min(100, Math.max(0, job.progress));
    }, 0) / jobIds.length);

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
        <div className="flex items-center gap-2">
          {!allDone && (
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">
              {overallProgress}%
            </span>
          )}
          {(allDone || showForceClose) && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
          )}
        </div>
      </div>

      {/* Job rows */}
      <div className="space-y-2">
        {jobIds.map((id) => {
          const j = jobs[id];
          const stalled = stalledJobs.has(id);
          const pct = j ? Math.min(100, Math.max(0, j.progress)) : 0;
          const label = j?.currentMonth || id.split('-').pop() || '';

          let stateLabel: string;
          if (cancelled) {
            stateLabel = j?.state === 'completed' ? `✅ ${j.invoicesFetched} HĐ` : '⏹ Đã hủy';
          } else if (stalled) {
            stateLabel = '⚠️ Mất kết nối — chạy nền';
          } else if (!j) {
            stateLabel = retryCount(id) > 0
              ? `Đang kết nối lại (${retryCount(id)}/${MAX_SSE_RETRIES})...`
              : '⏳ Đang kết nối...';
          } else if (j.state === 'waiting') {
            stateLabel = '⏳ Chờ trong hàng...';
          } else if (j.state === 'delayed') {
            stateLabel = '⏳ Đã lên lịch...';
          } else if (j.state === 'active') {
            stateLabel = formatStatusMsg(j.message, pct, j.invoicesFetched, j.currentPage, j.totalPages);
          } else if (j.state === 'completed') {
            stateLabel = `✅ ${j.invoicesFetched} HĐ`;
          } else {
            // Failed — show concise error
            const err = j.error ?? 'Lỗi không xác định';
            const isProxy = /proxy|407|PROXY_DEAD/i.test(err);
            stateLabel = isProxy ? '🔌 Lỗi proxy / IP' : `❌ ${err}`;
          }

          return (
            <div key={id}>
              <div className="mb-1 flex items-start justify-between gap-3 text-xs">
                <span className="font-medium text-gray-600">{label}</span>
                <div className="text-right">
                  <p className="font-semibold text-slate-700">{stalled ? 100 : pct}%</p>
                  <span className={`${stalled ? 'text-amber-500' : j?.state === 'failed' ? 'text-red-500' : 'text-gray-500'} block max-w-[210px] truncate`}>
                    {stateLabel}
                  </span>
                </div>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    cancelled && j?.state !== 'completed' ? 'bg-amber-400'
                    : stalled ? 'bg-amber-400'
                    : j?.state === 'completed' ? 'bg-green-500'
                    : j?.state === 'failed' ? 'bg-red-500'
                    : 'bg-primary-500'
                  }`}
                  style={{ width: stalled ? '100%' : `${pct}%` }}
                />
              </div>
              {/* Sub-detail: page counter for active jobs */}
              {j?.state === 'active' && j.totalPages && j.totalPages > 1 && (
                <div className="text-[10px] text-gray-400 mt-0.5 text-right">
                  Trang {j.currentPage}/{j.totalPages} · {j.invoicesFetched} hóa đơn
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!allDone && showForceClose && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Không nhận được cập nhật mới sau {formatSec(STALL_TIMEOUT_MS / 1000)}. Bạn có thể đóng bảng này, BOT sẽ tiếp tục chạy nền nếu worker chưa dừng.
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        {!allDone && !showForceClose && (
          <button
            onClick={() => void handleCancel()}
            disabled={cancelling}
            className="flex-1 text-sm py-2 border border-red-200 text-red-600 rounded-xl font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            {cancelling ? 'Đang hủy...' : '⏹ Hủy đồng bộ'}
          </button>
        )}
        {!allDone && showForceClose && (
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2 border border-gray-300 rounded-xl text-gray-600 font-medium hover:bg-gray-50"
          >
            Đóng (chạy nền)
          </button>
        )}
        {allDone && !anyFailed && !cancelled && (
          <button
            onClick={onClose}
            className="flex-1 text-sm py-2 bg-primary-600 text-white rounded-xl font-medium"
          >
            Đóng process board
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