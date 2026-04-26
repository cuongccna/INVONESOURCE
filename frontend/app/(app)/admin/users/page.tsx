'use client';

/**
 * Admin User License Management
 * View all users, their subscription status, and grant/revoke licenses.
 */
import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  is_platform_admin: boolean;
  created_at: string;
  sub_status: string | null;
  quota_used: number | null;
  quota_total: number | null;
  expires_at: string | null;
  plan_code: string | null;
  plan_name: string | null;
  tier: string | null;
}

interface Plan {
  id: string;
  code: string;
  name: string;
  tier: string;
  invoice_quota: number;
  price_per_month: number;
}

interface Meta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-green-100 text-green-800',
  trial:     'bg-blue-100 text-blue-800',
  expired:   'bg-red-100 text-red-800',
  suspended: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-orange-100 text-orange-700',
};

export default function AdminUsersPage() {
  const [users, setUsers]     = useState<UserRow[]>([]);
  const [meta, setMeta]       = useState<Meta>({ total: 0, page: 1, pageSize: 20, totalPages: 1 });
  const [plans, setPlans]     = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Create user modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ email: '', full_name: '', password: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const handleCreateUser = async () => {
    if (!createForm.email || !createForm.password) return;
    setCreating(true);
    setCreateError('');
    try {
      await apiClient.post('/admin/users', createForm);
      setShowCreateModal(false);
      setCreateForm({ email: '', full_name: '', password: '' });
      void load(1);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Lỗi khi tạo tài khoản';
      setCreateError(msg);
    } finally {
      setCreating(false);
    }
  };

  // Grant license modal
  const [grantTarget, setGrantTarget]     = useState<UserRow | null>(null);
  const [grantPlan, setGrantPlan]         = useState('');
  const [grantMonths, setGrantMonths]     = useState(1);
  const [grantNotes, setGrantNotes]       = useState('');
  const [granting, setGranting]           = useState(false);
  const [grantError, setGrantError]       = useState('');

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search)       params.set('search', search);
      if (planFilter)   params.set('plan',   planFilter);
      if (statusFilter) params.set('status', statusFilter);
      const res = await apiClient.get<{ success: boolean; data: UserRow[]; meta: Meta }>(
        `/admin/users?${params}`
      );
      setUsers(res.data.data);
      setMeta(res.data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [search, planFilter, statusFilter]);

  const loadPlans = useCallback(async () => {
    try {
      const res = await apiClient.get<{ success: boolean; data: Plan[] }>('/admin/plans');
      setPlans(res.data.data);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void load(1); }, [load]);
  useEffect(() => { void loadPlans(); }, [loadPlans]);

  const handleGrantLicense = async () => {
    if (!grantTarget || !grantPlan) return;
    setGranting(true);
    setGrantError('');
    try {
      await apiClient.post(`/admin/users/${grantTarget.id}/grant-license`, {
        planCode: grantPlan,
        months: grantMonths,
        notes: grantNotes || undefined,
      });
      setGrantTarget(null);
      setGrantPlan('');
      setGrantMonths(1);
      setGrantNotes('');
      void load(meta.page);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Lỗi khi cấp license';
      setGrantError(msg);
    } finally {
      setGranting(false);
    }
  };

  const handleToggleStatus = async (user: UserRow) => {
    const newStatus = user.is_active ? 'suspended' : 'active';
    const reason = newStatus === 'suspended' ? 'Admin suspend' : 'Admin activate';
    try {
      await apiClient.patch(`/admin/users/${user.id}/status`, { status: newStatus, reason });
      void load(meta.page);
    } catch { alert('Lỗi khi thay đổi trạng thái'); }
  };

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      <BackButton fallbackHref="/admin" className="mb-3" />
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Quản lý Người dùng & License</h1>
          <p className="text-sm text-gray-500">{meta.total.toLocaleString('vi-VN')} người dùng</p>
        </div>
        <button
          onClick={() => { setShowCreateModal(true); setCreateError(''); }}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <span>+</span> Tạo tài khoản mới
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Tìm theo tên, email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <select
          value={planFilter}
          onChange={e => setPlanFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
        >
          <option value="">Tất cả gói</option>
          {plans.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="active">Active</option>
          <option value="trial">Trial</option>
          <option value="expired">Expired</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Người dùng</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Gói / Trạng thái</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Quota dùng</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Hết hạn</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Ngày tạo</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">Đang tải...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">Không có người dùng nào</td></tr>
              ) : users.map(user => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{user.full_name || '(Chưa đặt tên)'}</div>
                    <div className="text-xs text-gray-500">{user.email}</div>
                    {user.is_platform_admin && (
                      <span className="inline-block mt-1 px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded">Admin</span>
                    )}
                    {!user.is_active && (
                      <span className="inline-block mt-1 px-1.5 py-0.5 bg-red-100 text-red-700 text-xs rounded ml-1">Bị khóa</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{user.plan_name ?? 'Free (không gói)'}</div>
                    {user.sub_status && (
                      <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[user.sub_status] ?? 'bg-gray-100 text-gray-600'}`}>
                        {user.sub_status}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {user.quota_used !== null ? (
                      <div>
                        <span className="font-medium">{(user.quota_used ?? 0).toLocaleString('vi-VN')}</span>
                        {user.quota_total ? <span className="text-gray-400"> / {user.quota_total.toLocaleString('vi-VN')}</span> : null}
                      </div>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {user.expires_at
                      ? <span className={new Date(user.expires_at) < new Date() ? 'text-red-600 font-medium' : ''}>
                          {new Date(user.expires_at).toLocaleDateString('vi-VN')}
                        </span>
                      : <span className="text-gray-400">—</span>
                    }
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(user.created_at).toLocaleDateString('vi-VN')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 justify-end flex-wrap">
                      <button
                        onClick={() => { setGrantTarget(user); setGrantPlan(user.plan_code ?? plans[0]?.code ?? ''); setGrantError(''); }}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"
                      >
                        Cấp license
                      </button>
                      <button
                        onClick={() => void handleToggleStatus(user)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium ${user.is_active ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}
                      >
                        {user.is_active ? 'Khóa' : 'Mở khóa'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {meta.totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between">
            <span className="text-sm text-gray-500">Trang {meta.page} / {meta.totalPages}</span>
            <div className="flex gap-2">
              <button
                onClick={() => void load(meta.page - 1)}
                disabled={meta.page <= 1}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                onClick={() => void load(meta.page + 1)}
                disabled={meta.page >= meta.totalPages}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Grant License Modal */}
      {grantTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-1">Cấp License</h3>
            <p className="text-sm text-gray-500 mb-4">
              Người dùng: <b>{grantTarget.full_name || grantTarget.email}</b>
            </p>

            {grantError && (
              <div className="mb-3 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{grantError}</div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Gói license</label>
                <select
                  value={grantPlan}
                  onChange={e => setGrantPlan(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">-- Chọn gói --</option>
                  {plans.map(p => (
                    <option key={p.code} value={p.code}>
                      {p.name} — {p.invoice_quota.toLocaleString('vi-VN')} HĐ/tháng
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Số tháng</label>
                <input
                  type="number"
                  min={1}
                  max={36}
                  value={grantMonths}
                  onChange={e => setGrantMonths(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Ghi chú (tuỳ chọn)</label>
                <input
                  type="text"
                  placeholder="Lý do cấp, mã đơn hàng..."
                  value={grantNotes}
                  onChange={e => setGrantNotes(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={() => { setGrantTarget(null); setGrantError(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleGrantLicense()}
                disabled={granting || !grantPlan}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-blue-700"
              >
                {granting ? 'Đang cấp...' : 'Xác nhận cấp'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create User Modal ─────────────────────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Tạo tài khoản mới</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
                <input
                  type="email"
                  placeholder="user@example.com"
                  value={createForm.email}
                  onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Họ tên</label>
                <input
                  type="text"
                  placeholder="Nguyễn Văn A"
                  value={createForm.full_name}
                  onChange={e => setCreateForm(f => ({ ...f, full_name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Mật khẩu <span className="text-red-500">*</span></label>
                <input
                  type="password"
                  placeholder="Tối thiểu 8 ký tự"
                  value={createForm.password}
                  onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {createError && <p className="text-xs text-red-600">{createError}</p>}
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => { setShowCreateModal(false); setCreateForm({ email: '', full_name: '', password: '' }); setCreateError(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleCreateUser()}
                disabled={creating || !createForm.email || !createForm.password}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-blue-700"
              >
                {creating ? 'Đang tạo...' : 'Tạo tài khoản'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
