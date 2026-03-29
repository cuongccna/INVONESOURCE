'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import apiClient from '../../../../lib/apiClient';

interface UserDetail {
  id: string; email: string; full_name: string; phone: string | null;
  is_active: boolean; is_platform_admin: boolean; admin_notes: string | null; created_at: string;
  sub_id: string | null; sub_status: string | null; quota_used: number | null; quota_total: number | null;
  expires_at: string | null; started_at: string | null; granted_by: string | null;
  grant_notes: string | null; is_manually_set: boolean | null;
  payment_reference: string | null; last_paid_at: string | null;
  plan_code: string | null; plan_name: string | null; tier: string | null;
  invoice_quota: number | null; price_per_month: number | null;
}

interface Company { id: string; name: string; tax_code: string; role: string; invoice_count: number }

interface HistoryRow {
  id: string; action: string; old_plan_name: string | null; new_plan_name: string | null;
  old_status: string | null; new_status: string | null; admin_name: string;
  notes: string | null; expires_at: string | null; created_at: string;
}

interface PageData {
  user: UserDetail;
  companies: Company[];
  license_history: HistoryRow[];
  quota_history: Array<{ month: string; total: number }>;
}

const ACTION_LABELS: Record<string, string> = {
  grant: 'Cấp license', renew: 'Gia hạn', upgrade: 'Nâng cấp', downgrade: 'Hạ cấp',
  suspend: 'Tạm khóa', enable: 'Kích hoạt', cancel: 'Hủy bỏ',
};
const ACTION_COLORS: Record<string, string> = {
  grant: 'text-green-700', renew: 'text-blue-700', upgrade: 'text-indigo-700',
  downgrade: 'text-amber-700', suspend: 'text-red-700', enable: 'text-green-700', cancel: 'text-gray-500',
};

function formatVND(n: number) {
  return n.toLocaleString('vi-VN') + 'đ';
}

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router  = useRouter();
  const [data, setData]       = useState<PageData | null>(null);
  const [action, setAction]   = useState<string | null>(null);
  const [reason, setReason]   = useState('');
  const [months, setMonths]   = useState(12);
  const [adjustment, setAdj]  = useState(0);
  const [submitting, setSub]  = useState(false);
  const [msg, setMsg]         = useState('');

  const load = useCallback(() => {
    apiClient.get<{ data: PageData }>(`/admin/users/${id}`)
      .then(r => setData(r.data.data))
      .catch(() => router.replace('/admin/users'));
  }, [id, router]);

  useEffect(() => { load(); }, [load]);

  async function doAction() {
    if (!reason && action !== 'adjust') { setMsg('Nhập lý do'); return; }
    setSub(true); setMsg('');
    try {
      switch (action) {
        case 'suspend':
          await apiClient.patch(`/admin/users/${id}/suspend`, { reason }); break;
        case 'enable':
          await apiClient.patch(`/admin/users/${id}/enable`, { notes: reason }); break;
        case 'renew':
          await apiClient.patch(`/admin/users/${id}/renew`, { months, notes: reason }); break;
        case 'cancel':
          await apiClient.delete(`/admin/users/${id}/subscription`, { data: { confirm: 'CANCEL_SUBSCRIPTION', reason } }); break;
        case 'adjust':
          await apiClient.patch(`/admin/users/${id}/quota/adjust`, { adjustment, reason }); break;
      }
      setAction(null); setReason(''); setMsg('');
      load();
    } catch (e: unknown) {
      const m = (e as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi';
      setMsg(m);
    } finally { setSub(false); }
  }

  if (!data) {
    return <div className="flex items-center justify-center h-64"><p className="text-gray-400 text-sm">Đang tải…</p></div>;
  }

  const { user, companies, license_history, quota_history } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <button onClick={() => router.back()} className="text-xs text-gray-400 hover:text-gray-600 mb-1">← Quay lại</button>
          <h1 className="text-xl md:text-2xl font-bold text-gray-800">{user.full_name || user.email}</h1>
          <p className="text-sm text-gray-500">{user.email} · Đăng ký {new Date(user.created_at).toLocaleDateString('vi-VN')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {user.sub_status === 'active' || user.sub_status === 'trial'
            ? <button onClick={() => setAction('suspend')} className="px-3 py-1.5 text-xs rounded-lg bg-red-50 text-red-600 hover:bg-red-100 font-medium">Tạm khóa</button>
            : user.sub_status === 'suspended'
              ? <button onClick={() => setAction('enable')} className="px-3 py-1.5 text-xs rounded-lg bg-green-50 text-green-600 hover:bg-green-100 font-medium">Kích hoạt</button>
              : null}
          <button onClick={() => setAction('renew')} className="px-3 py-1.5 text-xs rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium">Gia hạn</button>
          <button onClick={() => setAction('adjust')} className="px-3 py-1.5 text-xs rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-100 font-medium">Quota</button>
          {user.sub_id && <button onClick={() => setAction('cancel')} className="px-3 py-1.5 text-xs rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200 font-medium">Hủy sub</button>}
        </div>
      </div>

      {/* Action panel */}
      {action && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-amber-800">
            {action === 'suspend' ? '⚠ Tạm khóa subscription'
              : action === 'enable' ? '✅ Kích hoạt lại subscription'
              : action === 'renew' ? '🔄 Gia hạn subscription'
              : action === 'cancel' ? '❌ Hủy subscription'
              : '📊 Điều chỉnh quota'}
          </p>
          {action === 'renew' && (
            <input type="number" min={1} max={36} value={months} onChange={e => setMonths(Number(e.target.value))}
              placeholder="Số tháng" className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-32 focus:outline-none" />
          )}
          {action === 'adjust' && (
            <input type="number" value={adjustment} onChange={e => setAdj(Number(e.target.value))}
              placeholder="Số lượng (+/-)" className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-40 focus:outline-none" />
          )}
          <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="Lý do / ghi chú…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400" />
          {msg && <p className="text-xs text-red-600">{msg}</p>}
          <div className="flex gap-2">
            <button onClick={doAction} disabled={submitting}
              className="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50">
              {submitting ? 'Đang xử lý…' : 'Xác nhận'}
            </button>
            <button onClick={() => { setAction(null); setMsg(''); }} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Hủy</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Subscription card */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Subscription</h2>
          <div className="space-y-2 text-sm">
            <Row label="Gói" value={user.plan_name ?? 'Free tier'} />
            <Row label="Trạng thái" value={user.sub_status ?? 'Free'} />
            <Row label="Quota" value={user.quota_used != null ? `${user.quota_used?.toLocaleString('vi-VN')} / ${user.quota_total?.toLocaleString('vi-VN')} HĐ` : '—'} />
            <Row label="Hết hạn" value={user.expires_at ? new Date(user.expires_at).toLocaleDateString('vi-VN') : '—'} />
            <Row label="Giá / tháng" value={user.price_per_month ? formatVND(user.price_per_month) : '—'} />
            {user.payment_reference && <Row label="Mã TT" value={user.payment_reference} />}
            {user.grant_notes && <Row label="Ghi chú" value={user.grant_notes} />}
          </div>
        </div>

        {/* Companies */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Công ty ({companies.length})</h2>
          <div className="space-y-2 text-sm">
            {companies.map(c => (
              <div key={c.id} className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-800">{c.name}</p>
                  <p className="text-xs text-gray-400">{c.tax_code} · {c.role}</p>
                </div>
                <span className="text-xs text-gray-500">{c.invoice_count.toLocaleString('vi-VN')} HĐ</span>
              </div>
            ))}
            {!companies.length && <p className="text-gray-400 text-xs">Chưa có</p>}
          </div>
        </div>

        {/* Quota history */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Quota đã dùng (6 tháng)</h2>
          <div className="space-y-2">
            {quota_history.map(h => (
              <div key={h.month} className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 w-20 shrink-0">{h.month}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-indigo-500 h-2 rounded-full"
                    style={{ width: `${Math.min(100, (h.total / (user.invoice_quota ?? 100)) * 100)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500 w-14 text-right">{h.total.toLocaleString('vi-VN')}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* License history timeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Lịch sử license</h2>
        <div className="relative pl-6 space-y-4">
          <div className="absolute left-2 top-0 bottom-0 w-px bg-gray-200" />
          {license_history.map(h => (
            <div key={h.id} className="relative">
              <div className="absolute -left-4 top-1 w-2.5 h-2.5 rounded-full bg-white border-2 border-indigo-400" />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <span className={`text-sm font-medium ${ACTION_COLORS[h.action] ?? 'text-gray-600'}`}>
                    {ACTION_LABELS[h.action] ?? h.action}
                  </span>
                  {(h.old_plan_name || h.new_plan_name) && (
                    <span className="text-xs text-gray-400 ml-2">
                      {h.old_plan_name && `${h.old_plan_name} → `}{h.new_plan_name}
                    </span>
                  )}
                  {h.expires_at && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Hết hạn: {new Date(h.expires_at).toLocaleDateString('vi-VN')}
                    </p>
                  )}
                  {h.notes && <p className="text-xs text-gray-500 mt-0.5 italic">{h.notes}</p>}
                  <p className="text-xs text-gray-400 mt-0.5">bởi {h.admin_name}</p>
                </div>
                <span className="text-xs text-gray-400 shrink-0">
                  {new Date(h.created_at).toLocaleDateString('vi-VN')}
                </span>
              </div>
            </div>
          ))}
          {!license_history.length && <p className="text-xs text-gray-400">Chưa có lịch sử</p>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-800 font-medium text-right max-w-[60%] break-words">{value}</span>
    </div>
  );
}
