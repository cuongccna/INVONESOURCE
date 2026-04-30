'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../lib/apiClient';

/* ── Types ──────────────────────────────────────────────────────────────────── */

interface AssignedUser {
  user_id:     string;
  email:       string;
  name:        string | null;
  assigned_at: string;
}

type GdtCheckStatus = 'reachable' | 'gdt_blocked' | 'proxy_error' | 'proxy_auth_fail';

interface Proxy {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string | null;
  password: string | null;
  label: string | null;
  country: string;
  status: 'active' | 'blocked' | 'quarantine';
  assigned_users: AssignedUser[];
  blocked_reason: string | null;
  blocked_at: string | null;
  last_health_check: string | null;
  last_health_status: boolean | null;
  expires_at: string | null;
  created_at: string;
  /* GDT check columns (migration 051) */
  gdt_check_at:     string | null;
  gdt_check_status: GdtCheckStatus | null;
  gdt_check_ms:     number | null;
}

interface Dashboard {
  total: number;
  active: number;
  blocked: number;
  quarantine: number;
  assigned: number;
  available: number;
  expired: number;
  /* GDT stats */
  gdt_blocked:   number;
  gdt_reachable: number;
  gdt_checked:   number;
}

interface GdtBulkResult {
  checked:         number;
  reachable:       number;
  gdt_blocked:     number;
  proxy_error:     number;
  proxy_auth_fail: number;
  results: {
    proxyId:   string;
    host:      string;
    port:      number;
    label:     string | null;
    status:    GdtCheckStatus;
    latencyMs: number | null;
    detail:    string | null;
  }[];
}

interface FormState {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks5';
  username: string;
  password: string;
  label: string;
  country: string;
  expires_at: string;
}

const BLANK: FormState = {
  host: '', port: 0, protocol: 'http',
  username: '', password: '', label: '', country: 'VN', expires_at: '',
};

const STATUS_BADGE: Record<string, string> = {
  active:     'bg-green-100 text-green-700',
  blocked:    'bg-red-100 text-red-700',
  quarantine: 'bg-yellow-100 text-yellow-700',
};

/* ── GDT check status config ────────────────────────────────────────────────── */

const GDT_STATUS_CONFIG: Record<GdtCheckStatus, {
  icon: string; label: string; color: string; bg: string;
}> = {
  reachable:       { icon: '✅', label: 'GDT thông',      color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
  gdt_blocked:     { icon: '🔴', label: 'GDT chặn',       color: 'text-red-700',   bg: 'bg-red-50 border-red-200' },
  proxy_error:     { icon: '⚠️', label: 'Lỗi proxy',      color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
  proxy_auth_fail: { icon: '🔑', label: 'Sai xác thực',   color: 'text-orange-700',bg: 'bg-orange-50 border-orange-200' },
};

/* ── Helpers ────────────────────────────────────────────────────────────────── */

const VN_TZ = 'Asia/Ho_Chi_Minh';

function fmtDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('vi-VN', {
    timeZone: VN_TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateShort(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('vi-VN', {
    timeZone: VN_TZ,
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function toLocalInput(utcIso: string): string {
  if (!utcIso) return '';
  const d    = new Date(utcIso);
  const vnMs = d.getTime() + 7 * 3_600_000;
  const vn   = new Date(vnMs);
  const yyyy = vn.getUTCFullYear();
  const mm   = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(vn.getUTCDate()).padStart(2, '0');
  const HH   = String(vn.getUTCHours()).padStart(2, '0');
  const MM   = String(vn.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}`;
}

function fromLocalInput(localStr: string): string {
  if (!localStr) return '';
  const asUtcMs = new Date(localStr).getTime() - 7 * 3_600_000;
  return new Date(asUtcMs).toISOString();
}

function maskPass(p: string | null): string {
  if (!p) return '—';
  return p.length > 4 ? p.slice(0, 4) + '****' : '****';
}

function errMsg(e: unknown): string {
  return (e as { response?: { data?: { error?: { message?: string } } } })
    ?.response?.data?.error?.message ?? 'Lỗi không xác định';
}

/* ── Stats Card ─────────────────────────────────────────────────────────────── */

function StatCard({
  label, value, color, title,
}: {
  label: string; value: number | string; color: string; title?: string;
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${color}`} title={title}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

/* ── GDT Status Badge ────────────────────────────────────────────────────────── */

function GdtStatusBadge({
  status, checkedAt, latencyMs, checking,
}: {
  status: GdtCheckStatus | null;
  checkedAt: string | null;
  latencyMs: number | null;
  checking?: boolean;
}) {
  if (checking) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-500 animate-pulse">
        <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin inline-block" />
        Đang kiểm tra...
      </span>
    );
  }
  if (!status || !checkedAt) {
    return <span className="text-xs text-gray-400">Chưa kiểm tra</span>;
  }
  const cfg = GDT_STATUS_CONFIG[status];
  return (
    <div>
      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
        <span>{cfg.icon}</span>
        <span>{cfg.label}</span>
        {latencyMs != null && (
          <span className="opacity-70">({latencyMs}ms)</span>
        )}
      </span>
      <p className="text-[10px] text-gray-400 mt-0.5">{fmtDateShort(checkedAt)}</p>
    </div>
  );
}

/* ── Assigned Users badges ──────────────────────────────────────────────────── */

function AssignedUsersBadges({
  users, onRelease,
}: {
  users: AssignedUser[];
  onRelease: (userId: string, email: string) => void;
}) {
  if (users.length === 0) return <span className="text-xs text-gray-400">Chưa gán</span>;
  return (
    <div className="flex flex-col gap-1">
      {users.map(u => (
        <div key={u.user_id} className="flex items-center gap-1">
          <span
            className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 rounded px-1.5 py-0.5 max-w-[140px] truncate"
            title={u.email}
          >
            {u.name ?? u.email}
          </span>
          <button
            onClick={() => onRelease(u.user_id, u.email)}
            className="text-xs text-orange-500 hover:text-orange-700 shrink-0"
            title={`Gỡ ${u.email}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Proxy Row ──────────────────────────────────────────────────────────────── */

function ProxyRow({
  proxy, checkingGdt,
  onHealthCheck, onCheckGdt,
  onReleaseUser, onReleaseAll, onDelete, onEdit, onAssign,
}: {
  proxy: Proxy;
  checkingGdt: boolean;
  onHealthCheck: (id: string) => void;
  onCheckGdt:    (id: string) => void;
  onReleaseUser: (proxyId: string, userId: string, email: string) => void;
  onReleaseAll:  (id: string) => void;
  onDelete:      (id: string) => void;
  onEdit:        (p: Proxy) => void;
  onAssign:      (id: string) => void;
}) {
  const [tcpChecking, setTcpChecking] = useState(false);
  const hasUsers = proxy.assigned_users.length > 0;

  const rowHighlight =
    proxy.gdt_check_status === 'gdt_blocked'
      ? 'bg-red-50'
      : proxy.status !== 'active'
      ? 'opacity-60'
      : '';

  return (
    <tr className={`border-t border-gray-100 transition-colors hover:bg-gray-50 ${rowHighlight}`}>
      {/* Host:Port */}
      <td className="px-4 py-3">
        <p className="font-mono text-sm text-gray-800">{proxy.host}:{proxy.port}</p>
        {proxy.label && <p className="text-xs text-gray-400">{proxy.label}</p>}
      </td>

      {/* Protocol */}
      <td className="px-4 py-3 text-sm text-gray-600 uppercase">{proxy.protocol}</td>

      {/* Auth */}
      <td className="px-4 py-3">
        <p className="text-sm text-gray-700">{proxy.username ?? '—'}</p>
        <p className="text-xs text-gray-400 font-mono">{maskPass(proxy.password)}</p>
      </td>

      {/* Status (DB status) */}
      <td className="px-4 py-3">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE[proxy.status]}`}>
          {proxy.status}
        </span>
        {proxy.blocked_reason && (
          <p className="text-xs text-red-400 mt-1 max-w-[180px] truncate" title={proxy.blocked_reason}>
            {proxy.blocked_reason}
          </p>
        )}
      </td>

      {/* GDT Check Status */}
      <td className="px-4 py-3 min-w-[160px]">
        <GdtStatusBadge
          status={proxy.gdt_check_status}
          checkedAt={proxy.gdt_check_at}
          latencyMs={proxy.gdt_check_ms}
          checking={checkingGdt}
        />
      </td>

      {/* Assigned To */}
      <td className="px-4 py-3 min-w-[160px]">
        <AssignedUsersBadges
          users={proxy.assigned_users}
          onRelease={(uid, email) => onReleaseUser(proxy.id, uid, email)}
        />
      </td>

      {/* TCP Health */}
      <td className="px-4 py-3">
        {proxy.last_health_check ? (
          <div className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full shrink-0 ${proxy.last_health_status ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-500">{fmtDateShort(proxy.last_health_check)}</span>
          </div>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>

      {/* Expires */}
      <td className="px-4 py-3">
        {proxy.expires_at ? (
          <span className={`text-xs ${new Date(proxy.expires_at) < new Date() ? 'text-red-500 font-medium' : 'text-gray-500'}`}>
            {fmtDate(proxy.expires_at)}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>

      {/* Actions */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          <button
            onClick={async () => { setTcpChecking(true); await onHealthCheck(proxy.id); setTcpChecking(false); }}
            disabled={tcpChecking}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50"
            title="TCP ping proxy server"
          >
            {tcpChecking ? '...' : 'TCP'}
          </button>
          <button
            onClick={() => onCheckGdt(proxy.id)}
            disabled={checkingGdt}
            className="text-xs text-violet-600 hover:underline disabled:opacity-50"
            title="Kiểm tra GDT có bị chặn không"
          >
            {checkingGdt ? '...' : 'GDT?'}
          </button>
          <button onClick={() => onAssign(proxy.id)} className="text-xs text-green-600 hover:underline">
            + Gán
          </button>
          {hasUsers && (
            <button onClick={() => onReleaseAll(proxy.id)} className="text-xs text-orange-600 hover:underline">
              Gỡ all
            </button>
          )}
          <button onClick={() => onEdit(proxy)} className="text-xs text-indigo-600 hover:underline">Sửa</button>
          <button onClick={() => onDelete(proxy.id)} className="text-xs text-red-500 hover:underline">Xóa</button>
        </div>
      </td>
    </tr>
  );
}

/* ── GDT Bulk Result Panel ───────────────────────────────────────────────────── */

function GdtResultPanel({
  result, onClose,
}: {
  result: GdtBulkResult;
  onClose: () => void;
}) {
  const blocked = result.results.filter(r => r.status === 'gdt_blocked');
  const errors  = result.results.filter(r => r.status === 'proxy_error' || r.status === 'proxy_auth_fail');
  const ok      = result.results.filter(r => r.status === 'reachable');

  return (
    <div className="bg-white border border-violet-200 rounded-xl p-5 space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          Kết quả kiểm tra GDT Block ({result.checked} proxy)
        </h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-center">
          <p className="text-xs text-gray-500">✅ GDT thông</p>
          <p className="text-xl font-bold text-green-700">{result.reachable}</p>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-center">
          <p className="text-xs text-gray-500">🔴 GDT chặn</p>
          <p className="text-xl font-bold text-red-700">{result.gdt_blocked}</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center">
          <p className="text-xs text-gray-500">⚠️ Lỗi proxy</p>
          <p className="text-xl font-bold text-amber-700">{result.proxy_error}</p>
        </div>
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-center">
          <p className="text-xs text-gray-500">🔑 Sai xác thực</p>
          <p className="text-xl font-bold text-orange-700">{result.proxy_auth_fail}</p>
        </div>
      </div>

      {/* Blocked list — most important */}
      {blocked.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-red-700 mb-2">
            🔴 {blocked.length} proxy bị GDT TCP-blackhole — cần thay thế hoặc xoay IP:
          </p>
          <div className="space-y-1">
            {blocked.map(r => (
              <div
                key={r.proxyId}
                className="flex items-center gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-1.5"
              >
                <span className="font-mono text-sm text-red-800 font-medium">{r.host}:{r.port}</span>
                {r.label && <span className="text-xs text-red-500">({r.label})</span>}
                <span className="text-xs text-red-400 ml-auto">Timeout — IP bị GDT block</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Proxy errors */}
      {errors.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-amber-700 mb-2">
            ⚠️ {errors.length} proxy có vấn đề cấu hình (không liên quan GDT):
          </p>
          <div className="space-y-1">
            {errors.map(r => {
              const cfg = GDT_STATUS_CONFIG[r.status];
              return (
                <div
                  key={r.proxyId}
                  className="flex items-center gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5"
                >
                  <span className="text-sm">{cfg.icon}</span>
                  <span className="font-mono text-sm text-gray-700">{r.host}:{r.port}</span>
                  {r.label && <span className="text-xs text-gray-400">({r.label})</span>}
                  <span className="text-xs text-amber-600 ml-auto">{cfg.label}: {r.detail ?? ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Reachable — collapsed if no issues */}
      {ok.length > 0 && blocked.length === 0 && errors.length === 0 && (
        <p className="text-sm text-green-700">
          ✅ Tất cả {ok.length} proxy đều kết nối được với GDT — không có IP nào bị chặn.
        </p>
      )}
      {ok.length > 0 && (blocked.length > 0 || errors.length > 0) && (
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer hover:text-gray-700">
            ✅ {ok.length} proxy thông với GDT (xem chi tiết)
          </summary>
          <div className="mt-2 space-y-1">
            {ok.map(r => (
              <div key={r.proxyId} className="flex items-center gap-2">
                <span className="font-mono text-gray-600">{r.host}:{r.port}</span>
                {r.label && <span className="text-gray-400">({r.label})</span>}
                {r.latencyMs != null && <span className="text-green-600 ml-auto">{r.latencyMs}ms</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────────── */

export default function AdminProxiesPage() {
  const [proxies, setProxies]     = useState<Proxy[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [editProxy, setEditProxy] = useState<Proxy | null>(null);
  const [form, setForm]           = useState<FormState>(BLANK);
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');
  const [assignModal, setAssignModal] = useState<string | null>(null);
  const [assignEmail, setAssignEmail] = useState('');

  /* GDT check state */
  const [gdtChecking, setGdtChecking]   = useState(false);          // bulk check running
  const [gdtCheckingId, setGdtCheckingId] = useState<string | null>(null); // single proxy
  const [gdtResult, setGdtResult]       = useState<GdtBulkResult | null>(null);

  const load = useCallback(() => {
    apiClient.get<{ data: Proxy[] }>('/admin/proxies')
      .then(r => setProxies(r.data.data))
      .catch(console.error);
    apiClient.get<{ data: Dashboard }>('/admin/proxies/dashboard')
      .then(r => setDashboard(r.data.data))
      .catch(console.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── CRUD handlers ──────────────────────────────────────────────────────── */

  async function handleSave() {
    setSaving(true);
    setErr('');
    try {
      const body = {
        host:     form.host,
        port:     form.port,
        protocol: form.protocol,
        username: form.username || undefined,
        password: form.password || undefined,
        label:    form.label || undefined,
        country:  form.country,
        expires_at: form.expires_at || undefined,
      };
      if (editProxy) {
        await apiClient.patch(`/admin/proxies/${editProxy.id}`, body);
      } else {
        await apiClient.post('/admin/proxies', body);
      }
      setShowAdd(false);
      setEditProxy(null);
      setForm(BLANK);
      load();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Xóa proxy này?')) return;
    try {
      await apiClient.delete(`/admin/proxies/${id}`);
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  }

  async function handleHealthCheck(id: string) {
    try {
      const r = await apiClient.post<{ data: { healthy: boolean } }>(`/admin/proxies/${id}/health-check`);
      alert(r.data.data.healthy ? '✅ Proxy TCP hoạt động' : '❌ Proxy TCP không kết nối được');
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  }

  /* ── GDT check handlers ─────────────────────────────────────────────────── */

  /** Kiểm tra toàn bộ proxy xem IP nào bị GDT chặn */
  async function handleBulkGdtCheck() {
    if (!confirm(`Chạy kiểm tra GDT block cho tất cả proxy đang active?\n\n⏱ Thời gian tối đa: ~15 giây`)) return;
    setGdtChecking(true);
    setGdtResult(null);
    try {
      const r = await apiClient.post<{ data: GdtBulkResult }>('/admin/proxies/check-gdt-block', {});
      setGdtResult(r.data.data);
      load(); // reload table to show updated gdt_check_status
    } catch (e) {
      alert(`Lỗi kiểm tra GDT: ${errMsg(e)}`);
    } finally {
      setGdtChecking(false);
    }
  }

  /** Kiểm tra một proxy đơn lẻ */
  async function handleSingleGdtCheck(proxyId: string) {
    setGdtCheckingId(proxyId);
    try {
      await apiClient.post(`/admin/proxies/${proxyId}/check-gdt-block`, {});
      load();
    } catch (e) {
      alert(`Lỗi kiểm tra GDT: ${errMsg(e)}`);
    } finally {
      setGdtCheckingId(null);
    }
  }

  /* ── Assignment handlers ────────────────────────────────────────────────── */

  async function handleReleaseUser(proxyId: string, userId: string, email: string) {
    if (!confirm(`Gỡ gán ${email} khỏi proxy này?`)) return;
    try {
      await apiClient.post(`/admin/proxies/${proxyId}/release`, {
        user_id: userId, reason: 'Admin manual release',
      });
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  }

  async function handleReleaseAll(proxyId: string) {
    if (!confirm('Gỡ gán TẤT CẢ user khỏi proxy này?')) return;
    try {
      await apiClient.post(`/admin/proxies/${proxyId}/release-all`, { reason: 'Admin release-all' });
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  }

  async function handleAssign(proxyId: string) {
    if (!assignEmail.trim()) return;
    setErr('');
    try {
      const usersRes = await apiClient.get<{ data: { id: string; email: string; full_name: string }[] }>(
        '/admin/users',
        { params: { search: assignEmail.trim(), pageSize: 50 } },
      );
      const user = usersRes.data.data?.find(
        (u: { email: string }) => u.email.toLowerCase() === assignEmail.trim().toLowerCase(),
      );
      if (!user) { setErr(`Không tìm thấy user "${assignEmail}"`); return; }
      await apiClient.post(`/admin/proxies/${proxyId}/assign`, {
        user_id: user.id, reason: 'Admin manual assign',
      });
      setAssignModal(null);
      setAssignEmail('');
      load();
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  function startEdit(p: Proxy) {
    setEditProxy(p);
    setForm({
      host: p.host, port: p.port, protocol: p.protocol as FormState['protocol'],
      username: p.username ?? '', password: p.password ?? '',
      label: p.label ?? '', country: p.country,
      expires_at: p.expires_at ?? '',
    });
    setShowAdd(true);
  }

  /* ── Derived stats ──────────────────────────────────────────────────────── */

  const gdtBlockedCount = proxies.filter(p => p.gdt_check_status === 'gdt_blocked').length;

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Static Proxy Pool</h1>
          <p className="text-sm text-gray-500 mt-1">
            Quản lý proxy tĩnh — 1 IP có thể gán cho nhiều user
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {/* GDT Block Check — hero action */}
          <button
            onClick={handleBulkGdtCheck}
            disabled={gdtChecking}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center gap-2
              ${gdtChecking
                ? 'bg-violet-100 text-violet-500 cursor-not-allowed'
                : gdtBlockedCount > 0
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-violet-600 text-white hover:bg-violet-700'
              }`}
            title="Kiểm tra proxy nào bị GDT TCP-blackhole"
          >
            {gdtChecking
              ? <><span className="w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" /> Đang kiểm tra...</>
              : <><span>🔍</span> Kiểm tra GDT Block{gdtBlockedCount > 0 ? ` (${gdtBlockedCount} bị chặn)` : ''}</>
            }
          </button>
          <button
            onClick={() => { setShowAdd(true); setEditProxy(null); setForm(BLANK); setErr(''); }}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
          >
            + Thêm Proxy
          </button>
        </div>
      </div>

      {/* Dashboard Stats */}
      {dashboard && (
        <div className="space-y-2">
          {/* Row 1: pool stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard label="Tổng"       value={dashboard.total}     color="border-gray-200" />
            <StatCard label="Hoạt động"  value={dashboard.active}    color="border-green-200 bg-green-50" />
            <StatCard label="Khả dụng"   value={dashboard.available} color="border-blue-200 bg-blue-50" />
            <StatCard label="Đã gán"     value={dashboard.assigned}  color="border-indigo-200 bg-indigo-50" />
            <StatCard label="Bị chặn"    value={dashboard.blocked}   color="border-red-200 bg-red-50" />
            <StatCard label="Cách ly"    value={dashboard.quarantine}color="border-yellow-200 bg-yellow-50" />
            <StatCard label="Hết hạn"    value={dashboard.expired}   color="border-gray-300 bg-gray-50" />
          </div>
          {/* Row 2: GDT stats — only if at least one proxy has been checked */}
          {dashboard.gdt_checked > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <StatCard
                label="GDT thông"
                value={`${dashboard.gdt_reachable} / ${dashboard.gdt_checked}`}
                color="border-green-300 bg-green-50"
                title={`${dashboard.gdt_reachable} proxy kết nối được GDT`}
              />
              <StatCard
                label="🔴 GDT chặn IP"
                value={dashboard.gdt_blocked}
                color={dashboard.gdt_blocked > 0 ? 'border-red-400 bg-red-50' : 'border-gray-200'}
                title="Số proxy bị GDT TCP-blackhole (cần thay thế)"
              />
              <StatCard
                label="Chưa kiểm tra"
                value={dashboard.active - dashboard.gdt_checked}
                color="border-gray-200"
                title="Proxy active chưa từng chạy kiểm tra GDT"
              />
            </div>
          )}
        </div>
      )}

      {/* GDT Bulk Result Panel */}
      {gdtResult && (
        <GdtResultPanel result={gdtResult} onClose={() => setGdtResult(null)} />
      )}

      {/* Add / Edit Form */}
      {showAdd && (
        <div className="bg-white border border-indigo-200 rounded-xl p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700">
            {editProxy ? 'Sửa Proxy' : 'Thêm Proxy Mới'}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Host</label>
              <input
                value={form.host}
                onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="103.xxx.xxx.xxx"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
              <input
                type="number"
                value={form.port || ''}
                onChange={e => setForm(f => ({ ...f, port: parseInt(e.target.value, 10) || 0 }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="12345"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Protocol</label>
              <select
                value={form.protocol}
                onChange={e => setForm(f => ({ ...f, protocol: e.target.value as FormState['protocol'] }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Label</label>
              <input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="VN Residential #1"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
              <input
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
              <input
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                type="password"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
              <input
                value={form.country}
                onChange={e => setForm(f => ({ ...f, country: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                placeholder="VN"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Hạn sử dụng</label>
              <input
                type="datetime-local"
                value={form.expires_at ? toLocalInput(form.expires_at) : ''}
                onChange={e => setForm(f => ({ ...f, expires_at: e.target.value ? fromLocalInput(e.target.value) : '' }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>
          {err && <p className="text-sm text-red-500">{err}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !form.host || !form.port}
              className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Đang lưu...' : editProxy ? 'Cập nhật' : 'Thêm'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setEditProxy(null); setForm(BLANK); setErr(''); }}
              className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50"
            >
              Hủy
            </button>
          </div>
        </div>
      )}

      {/* Assign Modal */}
      {assignModal && (
        <div className="bg-white border border-blue-200 rounded-xl p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Gán thêm User vào Proxy</h2>
          <p className="text-xs text-gray-400">IP có thể gán cho nhiều user đồng thời.</p>
          <div className="flex gap-2">
            <input
              value={assignEmail}
              onChange={e => setAssignEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAssign(assignModal)}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="user@example.com"
              autoFocus
            />
            <button
              onClick={() => handleAssign(assignModal)}
              className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700"
            >
              Gán
            </button>
            <button
              onClick={() => { setAssignModal(null); setAssignEmail(''); setErr(''); }}
              className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50"
            >
              Hủy
            </button>
          </div>
          {err && <p className="text-sm text-red-500">{err}</p>}
        </div>
      )}

      {/* Proxy Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        {/* Legend */}
        <div className="px-4 py-2.5 border-b border-gray-100 flex flex-wrap items-center gap-4 text-xs text-gray-500">
          <span className="font-medium text-gray-600">GDT Block Check:</span>
          {Object.entries(GDT_STATUS_CONFIG).map(([key, cfg]) => (
            <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
              {cfg.icon} {cfg.label}
            </span>
          ))}
          <span className="ml-auto text-gray-400 italic">
            Nhấn &quot;GDT?&quot; trên từng proxy hoặc &quot;Kiểm tra GDT Block&quot; để quét toàn bộ
          </span>
        </div>

        <table className="w-full text-sm min-w-[1100px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Host:Port</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Protocol</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Auth</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Trạng thái</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">
                GDT Block Check
                <span className="normal-case font-normal text-gray-400 ml-1">(CONNECT tunnel)</span>
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Gán cho</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">TCP Health</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Hạn</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {proxies.map(p => (
              <ProxyRow
                key={p.id}
                proxy={p}
                checkingGdt={gdtChecking || gdtCheckingId === p.id}
                onHealthCheck={handleHealthCheck}
                onCheckGdt={handleSingleGdtCheck}
                onReleaseUser={handleReleaseUser}
                onReleaseAll={handleReleaseAll}
                onDelete={handleDelete}
                onEdit={startEdit}
                onAssign={id => { setAssignModal(id); setErr(''); }}
              />
            ))}
            {proxies.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-gray-400">
                  Chưa có proxy nào. Nhấn &quot;+ Thêm Proxy&quot; để bắt đầu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
