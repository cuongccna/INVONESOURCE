'use client';

/**
 * BOT-ENT-06 â€” Admin Bot Dashboard
 *
 * Full metrics dashboard: queue depth, circuit breaker, hourly charts,
 * per-company breakdown, circuit breaker panel. Auto-refresh every 30s.
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface HourBucket {
  hour: string;
  total: number;
  success: number;
  failed: number;
  captcha_attempts: number;
  captcha_fails: number;
}

interface CompanyRow {
  id: string;
  name: string;
  tax_code: string;
  is_active: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  consecutive_failures: number;
  blocked_until: string | null;
  next_auto_sync_at: string | null;
  invoices_today: number;
}

interface FailedByType {
  error_type: string;
  n: string;
}

interface Metrics {
  queues: { manualWaiting: number; manualActive: number; autoWaiting: number; autoActive: number };
  circuitBreaker: {
    tripped?: boolean; trippedAt?: string; errorCount: number; threshold: number; lastError?: string;
  };
  hourlyData: HourBucket[];
  summary: { todayTotal: number; todaySuccess: number; todayFailed: number; successRate: number; avgDurationMs: number };
  companies: CompanyRow[];
  failedByType: FailedByType[];
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fmtTime(iso: string | null): string {
  if (!iso) return 'â€”';
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
function getCompanyStatus(row: CompanyRow): { label: string; cls: string } {
  if (!row.is_active)                     return { label: 'â¸ ÄÃ£ táº¯t',   cls: 'bg-gray-100 text-gray-600' };
  if (row.blocked_until && new Date(row.blocked_until) > new Date())
                                          return { label: 'ðŸ”´ Bá»‹ cháº·n', cls: 'bg-red-100 text-red-700' };
  if (row.consecutive_failures >= 2)      return { label: 'âš ï¸ Cáº£nh bÃ¡o', cls: 'bg-yellow-100 text-yellow-700' };
  return { label: 'âœ… OK', cls: 'bg-green-100 text-green-700' };
}

const ERROR_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  GdtStructuralError:  { label: 'GDT thay Ä‘á»•i cáº¥u trÃºc', cls: 'bg-red-100 text-red-700' },
  UnrecoverableError:  { label: 'Sai thÃ´ng tin Ä‘Äƒng nháº­p', cls: 'bg-orange-100 text-orange-700' },
};

// â”€â”€ Simple bar chart using divs (no Recharts dependency) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function BarChart({ data }: { data: HourBucket[] }) {
  const maxTotal = Math.max(...data.map(h => h.total), 1);
  const last24 = data.slice(-24);
  return (
    <div className="flex items-end gap-0.5 h-20 w-full">
      {last24.map((h, i) => {
        const successH = Math.round((h.success / maxTotal) * 80);
        const failedH  = Math.round((h.failed  / maxTotal) * 80);
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end" title={`${h.hour}: ${h.success} ok, ${h.failed} fail`}>
            {failedH  > 0 && <div className="w-full bg-red-400 rounded-t" style={{ height: failedH }} />}
            {successH > 0 && <div className="w-full bg-green-400"           style={{ height: successH }} />}
          </div>
        );
      })}
    </div>
  );
}

// â”€â”€ Main Page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function AdminBotDashboard() {
  const [metrics,       setMetrics]       = useState<Metrics | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [cbResetting,   setCbResetting]   = useState(false);
  const [cbResetMsg,    setCbResetMsg]    = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Metrics }>('/api/bot/metrics');
      setMetrics(res.data.data);
      setLastRefreshed(new Date());
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMetrics();
    const interval = setInterval(() => void fetchMetrics(), 30_000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const resetCircuitBreaker = async () => {
    setCbResetting(true);
    setCbResetMsg('');
    try {
      await apiClient.post('/api/bot/circuit-breaker/reset', {});
      setCbResetMsg('âœ… Circuit breaker Ä‘Ã£ reset. Workers tiáº¿p tá»¥c.');
      await fetchMetrics();
    } catch {
      setCbResetMsg('âŒ Reset tháº¥t báº¡i â€” kiá»ƒm tra logs.');
    } finally {
      setCbResetting(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-gray-500">Äang táº£i dá»¯ liá»‡u bot metricsâ€¦</div>;
  }

  const m = metrics;
  const cb = m?.circuitBreaker;
  const cbPct = cb ? Math.round((cb.errorCount / cb.threshold) * 100) : 0;
  const failedToday = m?.failedByType.reduce((a, r) => a + parseInt(r.n, 10), 0) ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bot GDT â€” Tráº¡ng thÃ¡i há»‡ thá»‘ng</h1>
          {lastRefreshed && (
            <p className="text-xs text-gray-400 mt-0.5">
              Cáº­p nháº­t lÃºc {lastRefreshed.toLocaleTimeString('vi-VN')} Â· Tá»± Ä‘á»™ng refresh 30s
            </p>
          )}
        </div>
        <Link
          href="/admin/bot/failed-jobs"
          className="text-sm text-blue-600 hover:underline border border-blue-200 px-3 py-1.5 rounded-lg"
        >
          Xem Failed Jobs â†’
        </Link>
      </div>

      {/* Row 1: Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Manual queue */}
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Manual Queue</p>
          <p className="text-2xl font-bold text-gray-800">{m?.queues.manualWaiting ?? 0}</p>
          <p className="text-xs text-gray-400">Ä‘ang chá» Â· <span className="text-blue-600">{m?.queues.manualActive ?? 0} Ä‘ang cháº¡y</span></p>
        </div>
        {/* Auto queue */}
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Auto Queue</p>
          <p className="text-2xl font-bold text-gray-800">{m?.queues.autoWaiting ?? 0}</p>
          <p className="text-xs text-gray-400">Ä‘ang chá» Â· <span className="text-blue-600">{m?.queues.autoActive ?? 0} Ä‘ang cháº¡y</span></p>
        </div>
        {/* Circuit Breaker */}
        <div className={`border rounded-xl p-4 shadow-sm ${cb?.tripped ? 'bg-red-50 border-red-300' : 'bg-white'}`}>
          <p className="text-xs text-gray-500 mb-1">Circuit Breaker</p>
          {cb?.tripped
            ? <p className="text-lg font-bold text-red-700">ðŸš¨ ÄÃƒ KÃCH HOáº T</p>
            : <p className="text-lg font-bold text-green-700">âœ… BÃ¬nh thÆ°á»ng</p>
          }
          <p className="text-xs text-gray-400">{cb?.errorCount ?? 0}/{cb?.threshold ?? 20} lá»—i cáº¥u trÃºc</p>
        </div>
        {/* Failed jobs 24h */}
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <p className="text-xs text-gray-500 mb-1">Failed Jobs 24h</p>
          <Link href="/admin/bot/failed-jobs">
            <p className={`text-2xl font-bold ${failedToday > 0 ? 'text-red-600' : 'text-gray-800'}`}>{failedToday}</p>
          </Link>
          <p className="text-xs text-gray-400">
            {m?.failedByType.map(r => `${r.error_type?.split('.').pop()}: ${r.n}`).join(' Â· ') || 'â€”'}
          </p>
        </div>
      </div>

      {/* Row 2: Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-700">Jobs 24 giá» qua</p>
            <div className="flex gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-400 inline-block" />ThÃ nh cÃ´ng</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-400 inline-block" />Tháº¥t báº¡i</span>
            </div>
          </div>
          {m && <BarChart data={m.hourlyData} />}
        </div>

        {/* Performance metrics */}
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <p className="text-sm font-semibold text-gray-700 mb-3">Hiá»‡u suáº¥t hÃ´m nay</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs text-gray-500">Tá»•ng jobs</p>
              <p className="text-xl font-bold text-gray-800">{m?.summary.todayTotal ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Tá»· lá»‡ thÃ nh cÃ´ng</p>
              <p className="text-xl font-bold text-green-700">{m?.summary.successRate ?? 100}%</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Thá»i gian TB</p>
              <p className="text-xl font-bold text-gray-800">{fmtDuration(m?.summary.avgDurationMs ?? 0)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Tháº¥t báº¡i hÃ´m nay</p>
              <p className="text-xl font-bold text-red-600">{m?.summary.todayFailed ?? 0}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Row 3: Per-company breakdown */}
      <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b">
          <p className="text-sm font-semibold text-gray-700">Theo cÃ´ng ty (Top 20 hoáº¡t Ä‘á»™ng gáº§n nháº¥t)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left px-4 py-2">CÃ´ng ty</th>
                <th className="text-left px-4 py-2">Tráº¡ng thÃ¡i</th>
                <th className="text-left px-4 py-2">Sync cuá»‘i</th>
                <th className="text-right px-4 py-2">HÄ hÃ´m nay</th>
                <th className="text-right px-4 py-2">Lá»—i liÃªn tiáº¿p</th>
                <th className="text-left px-4 py-2">Sync tiáº¿p theo</th>
              </tr>
            </thead>
            <tbody>
              {(m?.companies ?? []).map(row => {
                const st = getCompanyStatus(row);
                return (
                  <tr key={row.id} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <p className="font-medium text-gray-800 truncate max-w-[180px]">{row.name}</p>
                      <p className="text-xs text-gray-400">{row.tax_code}</p>
                    </td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-2 text-gray-600">{fmtTime(row.last_run_at)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-gray-800">{row.invoices_today}</td>
                    <td className="px-4 py-2 text-right">
                      <span className={row.consecutive_failures >= 3 ? 'text-red-600 font-bold' : 'text-gray-600'}>
                        {row.consecutive_failures}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-500 text-xs">{fmtTime(row.next_auto_sync_at)}</td>
                  </tr>
                );
              })}
              {(m?.companies ?? []).length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">ChÆ°a cÃ³ cÃ´ng ty nÃ o cáº¥u hÃ¬nh bot.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row 4: Circuit Breaker panel */}
      <div className={`border rounded-xl p-5 shadow-sm ${cb?.tripped ? 'bg-red-50 border-red-300' : 'bg-white'}`}>
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-gray-700">Circuit Breaker â€” GDT Structural Change Guard</p>
          {cb?.tripped && (
            <button
              onClick={() => void resetCircuitBreaker()}
              disabled={cbResetting}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
            >
              {cbResetting ? 'Äang resetâ€¦' : 'ðŸ”„ Reset Circuit Breaker'}
            </button>
          )}
        </div>

        {cbResetMsg && (
          <div className="mb-3 text-sm text-gray-700 bg-gray-100 px-3 py-2 rounded">{cbResetMsg}</div>
        )}

        {/* Progress bar */}
        <div className="mb-2">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Lá»—i cáº¥u trÃºc trong 1 giá»</span>
            <span className={cbPct >= 75 ? 'text-red-600 font-bold' : ''}>{cb?.errorCount ?? 0} / {cb?.threshold ?? 20}</span>
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all ${cbPct >= 100 ? 'bg-red-600' : cbPct >= 75 ? 'bg-orange-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(100, cbPct)}%` }}
            />
          </div>
        </div>

        {cb?.tripped && cb.trippedAt && (
          <p className="text-xs text-red-700 mt-2">
            KÃ­ch hoáº¡t lÃºc: {fmtTime(cb.trippedAt)} â€” {cb.lastError}
          </p>
        )}
        {!cb?.tripped && (
          <p className="text-xs text-gray-400 mt-1">
            Sáº½ tá»± Ä‘á»™ng dá»«ng táº¥t cáº£ workers khi Ä‘áº¡t {cb?.threshold ?? 20} lá»—i GDT cáº¥u trÃºc trong 1 giá».
          </p>
        )}
      </div>

      {/* Failed by type breakdown */}
      {(m?.failedByType ?? []).length > 0 && (
        <div className="bg-white border rounded-xl p-4 shadow-sm">
          <p className="text-sm font-semibold text-gray-700 mb-3">PhÃ¢n loáº¡i lá»—i (24h)</p>
          <div className="flex flex-wrap gap-3">
            {(m?.failedByType ?? []).map(r => {
              const badge = ERROR_TYPE_BADGE[r.error_type] ?? { label: r.error_type, cls: 'bg-gray-100 text-gray-700' };
              return (
                <div key={r.error_type} className={`px-3 py-1.5 rounded-lg text-sm font-medium ${badge.cls}`}>
                  {badge.label}: {r.n}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

