'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../lib/apiClient';

interface MonthlyUsage { month: string; invoices_synced: number; active_users: number }
interface NewUsers     { month: string; new_users: number }
interface UserStat     { id: string; email: string; full_name: string; total_invoices: number; last_sync_at: string | null; active_months: number }

interface AnalyticsData {
  monthly_usage: MonthlyUsage[];
  new_users: NewUsers[];
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-100 rounded-full h-2.5">
        <div className={`h-2.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-16 text-right shrink-0">
        {value.toLocaleString('vi-VN')}
      </span>
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const [data, setData]           = useState<AnalyticsData | null>(null);
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: AnalyticsData }>('/admin/analytics/usage'),
      apiClient.get<{ data: UserStat[] }>('/admin/analytics/users'),
    ])
      .then(([usage, users]) => {
        setData(usage.data.data);
        setUserStats(users.data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-400 text-sm">Đang tải…</p>
      </div>
    );
  }

  if (!data) return null;

  const maxInvoices = Math.max(...data.monthly_usage.map(d => d.invoices_synced), 1);
  const maxUsers    = Math.max(...data.monthly_usage.map(d => d.active_users), 1);
  const maxNew      = Math.max(...data.new_users.map(d => d.new_users), 1);

  const totalInvoices = data.monthly_usage.reduce((s, d) => s + d.invoices_synced, 0);
  const totalNewUsers = data.new_users.reduce((s, d) => s + d.new_users, 0);
  const avgActive     = data.monthly_usage.length
    ? Math.round(data.monthly_usage.reduce((s, d) => s + d.active_users, 0) / data.monthly_usage.length)
    : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-xl md:text-2xl font-bold text-gray-800">Phân tích sử dụng</h1>

      {/* Summary KPIs — 1 col on mobile, 3 on desktop */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs text-gray-500 mb-1">Tổng HĐ sync (12 tháng)</p>
          <p className="text-2xl font-bold text-indigo-600">{totalInvoices.toLocaleString('vi-VN')}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs text-gray-500 mb-1">User active TB/tháng</p>
          <p className="text-2xl font-bold text-green-600">{avgActive.toLocaleString('vi-VN')}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs text-gray-500 mb-1">User mới (12 tháng)</p>
          <p className="text-2xl font-bold text-blue-600">{totalNewUsers.toLocaleString('vi-VN')}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Invoices synced per month */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">HĐ đồng bộ theo tháng</h2>
          <div className="space-y-3">
            {data.monthly_usage.length === 0 && <p className="text-xs text-gray-400">Chưa có dữ liệu</p>}
            {data.monthly_usage.map(row => (
              <div key={row.month}>
                <span className="text-xs text-gray-500">{row.month}</span>
                <Bar value={row.invoices_synced} max={maxInvoices} color="bg-indigo-500" />
              </div>
            ))}
          </div>
        </div>

        {/* Active users per month */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">User active theo tháng</h2>
          <div className="space-y-3">
            {data.monthly_usage.length === 0 && <p className="text-xs text-gray-400">Chưa có dữ liệu</p>}
            {data.monthly_usage.map(row => (
              <div key={row.month}>
                <span className="text-xs text-gray-500">{row.month}</span>
                <Bar value={row.active_users} max={maxUsers} color="bg-green-500" />
              </div>
            ))}
          </div>
        </div>

        {/* New users per month */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">User mới đăng ký theo tháng</h2>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {data.new_users.length === 0 && <p className="text-xs text-gray-400 col-span-full">Chưa có dữ liệu</p>}
            {data.new_users.map(row => {
              const pct = maxNew > 0 ? Math.round((row.new_users / maxNew) * 100) : 0;
              return (
                <div key={row.month} className="flex flex-col items-center gap-1">
                  <div className="w-full bg-gray-100 rounded-lg h-16 sm:h-20 flex items-end overflow-hidden">
                    <div className="w-full bg-blue-400 rounded-b-lg transition-all" style={{ height: `${pct}%` }} />
                  </div>
                  <span className="text-xs text-gray-500 text-center leading-tight">{row.month}</span>
                  <span className="text-xs font-medium text-blue-600">{row.new_users}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Per-user invoice sync stats ──────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">
          Thống kê HĐ đồng bộ theo người dùng
          <span className="ml-2 text-xs font-normal text-gray-400">(12 tháng gần nhất)</span>
        </h2>

        {userStats.length === 0 && <p className="text-xs text-gray-400">Chưa có dữ liệu đồng bộ</p>}

        {userStats.length > 0 && (
          <>
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Người dùng</th>
                    <th className="text-right py-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tổng HĐ sync</th>
                    <th className="text-right py-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Tháng hoạt động</th>
                    <th className="text-right py-2 pl-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">Lần cuối</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {userStats.map((u, i) => (
                    <tr key={u.id} className="hover:bg-gray-50">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-400 w-5 text-right shrink-0">{i + 1}</span>
                          <div>
                            <p className="font-medium text-gray-800 text-sm">{u.full_name || u.email}</p>
                            <p className="text-xs text-gray-400">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <span className="font-semibold text-indigo-600">{u.total_invoices.toLocaleString('vi-VN')}</span>
                      </td>
                      <td className="py-2.5 px-4 text-right text-gray-600">{u.active_months}</td>
                      <td className="py-2.5 pl-4 text-right text-xs text-gray-400">
                        {u.last_sync_at ? new Date(u.last_sync_at).toLocaleDateString('vi-VN') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="sm:hidden space-y-2">
              {userStats.map((u, i) => (
                <div key={u.id} className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-gray-400 w-5 shrink-0">{i + 1}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{u.full_name || u.email}</p>
                      <p className="text-xs text-gray-400 truncate">{u.email}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-sm font-bold text-indigo-600">{u.total_invoices.toLocaleString('vi-VN')}</p>
                    <p className="text-xs text-gray-400">HĐ</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
