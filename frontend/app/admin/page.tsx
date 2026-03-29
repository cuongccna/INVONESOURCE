'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../lib/apiClient';

interface Overview {
  users: { total: string; active: string; admins: string };
  subscriptions: { active: string; trial: string; suspended: string; expired_soon: string };
  invoices_synced_this_month: number;
  expiring_soon: Array<{
    user_id: string; email: string; full_name: string;
    plan_name: string; expires_at: string;
  }>;
  recent_history: Array<{
    id: string; user_name: string; admin_name: string;
    action: string; old_plan_name: string | null; new_plan_name: string | null;
    created_at: string; notes: string | null;
  }>;
}

function KCard({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? 'text-gray-800'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 60) return `${diff}m trước`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h trước`;
  return `${Math.floor(h / 24)}d trước`;
}

const ACTION_LABELS: Record<string, string> = {
  grant: 'Cấp license', renew: 'Gia hạn', upgrade: 'Nâng cấp', downgrade: 'Hạ cấp',
  suspend: 'Tạm khóa', enable: 'Kích hoạt', cancel: 'Hủy bỏ',
};

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    apiClient.get<{ data: Overview }>('/admin/overview')
      .then(r => setData(r.data.data))
      .catch(console.error);
  }, []);

  if (!data) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-400 text-sm">Đang tải…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl md:text-2xl font-bold text-gray-800">Tổng quan hệ thống</h1>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KCard label="Tổng người dùng" value={data.users.total} sub={`${data.users.active} đang hoạt động`} />
        <KCard label="Subscription active" value={data.subscriptions.active} sub={`${data.subscriptions.trial} trial`} accent="text-indigo-600" />
        <KCard label="Sắp hết hạn (7d)" value={data.subscriptions.expired_soon} accent={Number(data.subscriptions.expired_soon) > 0 ? 'text-amber-600' : undefined} />
        <KCard label="HĐ sync tháng này" value={data.invoices_synced_this_month.toLocaleString('vi-VN')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
        {/* Expiring Soon */}
        {data.expiring_soon.length > 0 && (
          <div className="bg-white rounded-xl border border-amber-200 p-5">
            <h2 className="text-sm font-semibold text-amber-700 mb-3">⚠ Sắp hết hạn</h2>
            <div className="space-y-2">
              {data.expiring_soon.map(u => (
                <div key={u.user_id} className="flex items-center justify-between text-sm">
                  <div>
                    <Link href={`/admin/users/${u.user_id}`} className="font-medium text-gray-800 hover:text-indigo-600">
                      {u.full_name || u.email}
                    </Link>
                    <span className="ml-2 text-xs text-gray-400">{u.plan_name}</span>
                  </div>
                  <span className="text-xs text-amber-600">{new Date(u.expires_at).toLocaleDateString('vi-VN')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent History */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Lịch sử gần đây</h2>
          <div className="space-y-2 text-sm">
            {data.recent_history.map(h => (
              <div key={h.id} className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-gray-800">{h.user_name}</span>
                  <span className="mx-1 text-gray-400">—</span>
                  <span className="text-indigo-600">{ACTION_LABELS[h.action] ?? h.action}</span>
                  {h.new_plan_name && (
                    <span className="ml-1 text-xs text-gray-500">({h.new_plan_name})</span>
                  )}
                </div>
                <span className="text-xs text-gray-400 shrink-0 ml-3">{timeAgo(h.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
