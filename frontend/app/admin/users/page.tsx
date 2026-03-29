'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';

interface UserRow {
  id: string; email: string; full_name: string; is_active: boolean;
  is_platform_admin: boolean; created_at: string;
  sub_status: string | null; quota_used: number | null; quota_total: number | null;
  plan_code: string | null; plan_name: string | null; tier: string | null;
  expires_at: string | null;
}

interface PageMeta { total: number; page: number; pageSize: number; totalPages: number }
interface PlanOption { code: string; name: string; invoice_quota: number }

// ── Grant License Modal ───────────────────────────────────────────────────────
interface GrantModalProps { userId: string; plans: PlanOption[]; onClose: () => void; onDone: () => void }

function GrantLicenseModal({ userId, plans, onClose, onDone }: GrantModalProps) {
  const [planCode, setPlanCode] = useState('');
  const [months, setMonths]     = useState(12);
  const [notes, setNotes]       = useState('');
  const [payRef, setPayRef]     = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  async function submit() {
    if (!planCode) { setError('Chọn gói'); return; }
    setLoading(true); setError('');
    try {
      await apiClient.post(`/admin/users/${userId}/grant-license`, { planCode, months, notes, paymentRef: payRef });
      onDone();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi cấp license';
      setError(msg);
    } finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">Cấp / Cập nhật License</h2>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Gói dịch vụ</label>
          <select value={planCode} onChange={e => setPlanCode(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">— Chọn gói —</option>
            {plans.map(p => (
              <option key={p.code} value={p.code}>
                {p.name} ({p.invoice_quota.toLocaleString('vi-VN')} HĐ/tháng)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Số tháng</label>
          <input type="number" min={1} max={36} value={months}
            onChange={e => setMonths(Number(e.target.value))}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Mã thanh toán (tuỳ chọn)</label>
          <input type="text" value={payRef} onChange={e => setPayRef(e.target.value)} placeholder="VD: TXN-2024-001"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Ghi chú (tuỳ chọn)</label>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Hủy</button>
          <button onClick={submit} disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {loading ? 'Đang xử lý…' : 'Cấp license'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create User Modal ─────────────────────────────────────────────────────────
function CreateUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ email: '', full_name: '', password: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  async function submit() {
    setLoading(true); setError('');
    try {
      await apiClient.post('/admin/users', {
        email:     form.email,
        full_name: form.full_name,
        password:  form.password,
        ...(form.phone ? { phone: form.phone } : {}),
      });
      onDone();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi tạo người dùng';
      setError(msg);
    } finally { setLoading(false); }
  }

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(p => ({ ...p, [field]: e.target.value }));

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-800">Tạo người dùng mới</h2>
        {[
          { label: 'Email *',    field: 'email'     as const, type: 'email',    placeholder: 'user@example.com' },
          { label: 'Họ tên *',  field: 'full_name' as const, type: 'text',     placeholder: 'Nguyễn Văn A' },
          { label: 'Mật khẩu *', field: 'password' as const, type: 'password', placeholder: 'Tối thiểu 8 ký tự' },
          { label: 'Số điện thoại', field: 'phone' as const, type: 'tel',      placeholder: '0901234567 (tuỳ chọn)' },
        ].map(({ label, field, type, placeholder }) => (
          <div key={field}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input type={type} value={form[field]} onChange={f(field)} placeholder={placeholder}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        ))}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Hủy</button>
          <button onClick={submit} disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {loading ? 'Đang tạo…' : 'Tạo người dùng'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Badges ────────────────────────────────────────────────────────────────────
const SUB_BADGES: Record<string, string> = {
  active:    'bg-green-100 text-green-700',
  trial:     'bg-blue-100 text-blue-700',
  suspended: 'bg-red-100 text-red-700',
  expired:   'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-100 text-gray-600',
};
const SUB_LABELS: Record<string, string> = {
  active: 'Active', trial: 'Trial', suspended: 'Suspended', expired: 'Expired', cancelled: 'Cancelled',
};

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdminUsersPage() {
  const [users, setUsers]         = useState<UserRow[]>([]);
  const [meta, setMeta]           = useState<PageMeta | null>(null);
  const [search, setSearch]       = useState('');
  const [status, setStatus]       = useState('');
  const [page, setPage]           = useState(1);
  const [plans, setPlans]         = useState<PlanOption[]>([]);
  const [grantFor, setGrantFor]   = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [toggling, setToggling]   = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    apiClient.get<{ data: UserRow[]; meta: PageMeta }>(`/admin/users?${params}`)
      .then(r => { setUsers(r.data.data); setMeta(r.data.meta); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, search, status]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    apiClient.get<{ data: PlanOption[] }>('/admin/plans')
      .then(r => setPlans(r.data.data.filter(p => (p as { is_active?: boolean }).is_active !== false)))
      .catch(console.error);
  }, []);

  const toggleActive = async (userId: string) => {
    setToggling(userId);
    try {
      await apiClient.patch(`/admin/users/${userId}/toggle-active`);
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, is_active: !u.is_active } : u));
    } catch { /* silent */ } finally { setToggling(null); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-bold text-gray-800">Người dùng</h1>
        <div className="flex items-center gap-2">
          {meta && <p className="text-sm text-gray-400 hidden sm:block">{meta.total.toLocaleString('vi-VN')} người</p>}
          <button
            onClick={() => setShowCreate(true)}
            className="px-3 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 whitespace-nowrap"
          >
            + Tạo người dùng
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text" placeholder="Tìm email / tên…" value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 sm:max-w-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {/* ── Desktop table ───────────────────────────────────────────────── */}
      <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Người dùng', 'Gói', 'Trạng thái', 'Quota', 'Hết hạn', 'Tài khoản', ''].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">Đang tải…</td></tr>
            )}
            {!loading && users.map(u => (
              <tr key={u.id} className={`hover:bg-gray-50 transition-colors ${!u.is_active ? 'opacity-60' : ''}`}>
                <td className="px-4 py-3">
                  <Link href={`/admin/users/${u.id}`} className="font-medium text-gray-800 hover:text-indigo-600">
                    {u.full_name || u.email}
                  </Link>
                  <p className="text-xs text-gray-400">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  <span className="text-gray-700">{u.plan_name ?? 'Free'}</span>
                  {u.tier && <span className="ml-1 text-xs text-gray-400">({u.tier})</span>}
                </td>
                <td className="px-4 py-3">
                  {u.sub_status ? (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${SUB_BADGES[u.sub_status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {SUB_LABELS[u.sub_status] ?? u.sub_status}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">Free</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {u.quota_used != null && u.quota_total != null
                    ? `${u.quota_used.toLocaleString('vi-VN')} / ${u.quota_total.toLocaleString('vi-VN')}`
                    : '—'}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {u.expires_at ? new Date(u.expires_at).toLocaleDateString('vi-VN') : '—'}
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => toggleActive(u.id)}
                    disabled={toggling === u.id}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full transition-colors ${
                      u.is_active
                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                        : 'bg-green-50 text-green-700 hover:bg-green-100'
                    } disabled:opacity-50`}
                  >
                    {toggling === u.id ? '…' : u.is_active ? 'Vô hiệu hóa' : 'Kích hoạt'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => setGrantFor(u.id)}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium whitespace-nowrap"
                  >
                    Cấp license
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile cards ─────────────────────────────────────────────────── */}
      <div className="md:hidden space-y-3">
        {loading && (
          <p className="text-center py-8 text-gray-400 text-sm">Đang tải…</p>
        )}
        {!loading && users.map(u => (
          <div key={u.id} className={`bg-white rounded-xl border border-gray-200 p-4 space-y-3 ${!u.is_active ? 'opacity-60' : ''}`}>
            {/* Header row */}
            <div className="flex items-start justify-between gap-2">
              <div>
                <Link href={`/admin/users/${u.id}`} className="font-medium text-gray-800 hover:text-indigo-600 text-sm">
                  {u.full_name || u.email}
                </Link>
                <p className="text-xs text-gray-400 mt-0.5">{u.email}</p>
              </div>
              {u.sub_status ? (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${SUB_BADGES[u.sub_status] ?? 'bg-gray-100 text-gray-600'}`}>
                  {SUB_LABELS[u.sub_status] ?? u.sub_status}
                </span>
              ) : (
                <span className="text-xs text-gray-400 shrink-0">Free</span>
              )}
            </div>

            {/* Details grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
              <span className="text-gray-400">Gói</span>
              <span>{u.plan_name ?? 'Free'}{u.tier ? ` (${u.tier})` : ''}</span>
              <span className="text-gray-400">Quota</span>
              <span>{u.quota_used != null && u.quota_total != null
                ? `${u.quota_used.toLocaleString('vi-VN')} / ${u.quota_total.toLocaleString('vi-VN')}`
                : '—'}
              </span>
              <span className="text-gray-400">Hết hạn</span>
              <span>{u.expires_at ? new Date(u.expires_at).toLocaleDateString('vi-VN') : '—'}</span>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-1 border-t border-gray-100">
              <button
                onClick={() => setGrantFor(u.id)}
                className="flex-1 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100"
              >
                Cấp license
              </button>
              <button
                onClick={() => toggleActive(u.id)}
                disabled={toggling === u.id}
                className={`flex-1 py-1.5 text-xs font-medium rounded-lg disabled:opacity-50 ${
                  u.is_active
                    ? 'text-red-600 bg-red-50 hover:bg-red-100'
                    : 'text-green-700 bg-green-50 hover:bg-green-100'
                }`}
              >
                {toggling === u.id ? '…' : u.is_active ? 'Vô hiệu hóa' : 'Kích hoạt'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 disabled:opacity-40"
          >
            ‹
          </button>
          <span className="text-sm text-gray-600">{page} / {meta.totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page >= meta.totalPages}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      )}

      {grantFor && (
        <GrantLicenseModal
          userId={grantFor}
          plans={plans}
          onClose={() => setGrantFor(null)}
          onDone={() => { setGrantFor(null); load(); }}
        />
      )}

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}
