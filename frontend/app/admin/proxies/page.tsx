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
  assigned_users: AssignedUser[];   // many-to-many (migration 048)
  blocked_reason: string | null;
  blocked_at: string | null;
  last_health_check: string | null;
  last_health_status: boolean | null;
  expires_at: string | null;
  created_at: string;
}

interface Dashboard {
  total: number;
  active: number;
  blocked: number;
  quarantine: number;
  assigned: number;
  available: number;
  expired: number;
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

function toLocalInput(utcIso: string): string {
  if (!utcIso) return '';
  const d = new Date(utcIso);
  const vnMs  = d.getTime() + 7 * 3_600_000;
  const vn    = new Date(vnMs);
  const yyyy  = vn.getUTCFullYear();
  const mm    = String(vn.getUTCMonth() + 1).padStart(2, '0');
  const dd    = String(vn.getUTCDate()).padStart(2, '0');
  const HH    = String(vn.getUTCHours()).padStart(2, '0');
  const MM    = String(vn.getUTCMinutes()).padStart(2, '0');
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

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${color}`}>
      <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

/* ── Assigned Users badges ──────────────────────────────────────────────────── */

function AssignedUsersBadges({
  users,
  onRelease,
}: {
  users: AssignedUser[];
  onRelease: (userId: string, email: string) => void;
}) {
  if (users.length === 0) return <span className="text-xs text-gray-400">Chưa gán</span>;

  return (
    <div className="flex flex-col gap-1">
      {users.map(u => (
        <div key={u.user_id} className="flex items-center gap-1">
          <span className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 rounded px-1.5 py-0.5 max-w-[160px] truncate" title={u.email}>
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
  proxy,
  onHealthCheck,
  onReleaseUser,
  onReleaseAll,
  onDelete,
  onEdit,
  onAssign,
}: {
  proxy: Proxy;
  onHealthCheck: (id: string) => void;
  onReleaseUser: (proxyId: string, userId: string, email: string) => void;
  onReleaseAll: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (p: Proxy) => void;
  onAssign: (id: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const hasUsers = proxy.assigned_users.length > 0;

  return (
    <tr className={`border-t border-gray-100 transition-colors hover:bg-gray-50 ${proxy.status !== 'active' ? 'opacity-60' : ''}`}>
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

      {/* Status */}
      <td className="px-4 py-3">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE[proxy.status]}`}>
          {proxy.status}
        </span>
        {proxy.blocked_reason && (
          <p className="text-xs text-red-400 mt-1 max-w-[200px] truncate" title={proxy.blocked_reason}>
            {proxy.blocked_reason}
          </p>
        )}
      </td>

      {/* Assigned To (many-to-many) */}
      <td className="px-4 py-3 min-w-[180px]">
        <AssignedUsersBadges
          users={proxy.assigned_users}
          onRelease={(userId, email) => onReleaseUser(proxy.id, userId, email)}
        />
      </td>

      {/* Health */}
      <td className="px-4 py-3">
        {proxy.last_health_check ? (
          <div className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${proxy.last_health_status ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-xs text-gray-500">{fmtDate(proxy.last_health_check)}</span>
          </div>
        ) : (
          <span className="text-xs text-gray-400">Chưa kiểm tra</span>
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
            onClick={async () => { setChecking(true); await onHealthCheck(proxy.id); setChecking(false); }}
            disabled={checking}
            className="text-xs text-blue-600 hover:underline disabled:opacity-50"
          >
            {checking ? '...' : 'Check'}
          </button>
          <button onClick={() => onAssign(proxy.id)} className="text-xs text-green-600 hover:underline">
            + Gán
          </button>
          {hasUsers && (
            <button onClick={() => onReleaseAll(proxy.id)} className="text-xs text-orange-600 hover:underline">
              Gỡ tất cả
            </button>
          )}
          <button onClick={() => onEdit(proxy)} className="text-xs text-indigo-600 hover:underline">Sửa</button>
          <button onClick={() => onDelete(proxy.id)} className="text-xs text-red-500 hover:underline">Xóa</button>
        </div>
      </td>
    </tr>
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
  const [assignModal, setAssignModal] = useState<string | null>(null); // proxy id
  const [assignEmail, setAssignEmail] = useState('');

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
      alert(r.data.data.healthy ? '✅ Proxy hoạt động tốt' : '❌ Proxy không kết nối được');
      load();
    } catch (e) {
      alert(errMsg(e));
    }
  }

  async function handleReleaseUser(proxyId: string, userId: string, email: string) {
    if (!confirm(`Gỡ gán ${email} khỏi proxy này?`)) return;
    try {
      await apiClient.post(`/admin/proxies/${proxyId}/release`, {
        user_id: userId,
        reason: 'Admin manual release',
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
        user_id: user.id,
        reason: 'Admin manual assign',
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

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Static Proxy Pool</h1>
          <p className="text-sm text-gray-500 mt-1">
            Quản lý proxy tĩnh — 1 IP có thể gán cho nhiều user
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setEditProxy(null); setForm(BLANK); setErr(''); }}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          + Thêm Proxy
        </button>
      </div>

      {/* Dashboard Stats */}
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard label="Tổng" value={dashboard.total} color="border-gray-200" />
          <StatCard label="Hoạt động" value={dashboard.active} color="border-green-200 bg-green-50" />
          <StatCard label="Khả dụng" value={dashboard.available} color="border-blue-200 bg-blue-50" />
          <StatCard label="Đã gán" value={dashboard.assigned} color="border-indigo-200 bg-indigo-50" />
          <StatCard label="Bị chặn" value={dashboard.blocked} color="border-red-200 bg-red-50" />
          <StatCard label="Cách ly" value={dashboard.quarantine} color="border-yellow-200 bg-yellow-50" />
          <StatCard label="Hết hạn" value={dashboard.expired} color="border-gray-300 bg-gray-50" />
        </div>
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
          <h2 className="text-sm font-semibold text-gray-700">
            Gán thêm User vào Proxy
          </h2>
          <p className="text-xs text-gray-400">
            Nhập email user cần gán. IP này có thể được gán cho nhiều user đồng thời.
          </p>
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
        <table className="w-full text-sm min-w-[1000px]">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Host:Port</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Protocol</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Auth</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Trạng thái</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Gán cho</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Health</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Hạn</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {proxies.map(p => (
              <ProxyRow
                key={p.id}
                proxy={p}
                onHealthCheck={handleHealthCheck}
                onReleaseUser={handleReleaseUser}
                onReleaseAll={handleReleaseAll}
                onDelete={handleDelete}
                onEdit={startEdit}
                onAssign={id => { setAssignModal(id); setErr(''); }}
              />
            ))}
            {proxies.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
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
