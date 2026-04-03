'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../../../lib/apiClient';

interface FailedJob {
  id: string;
  company_id: string;
  run_id: string;
  error_type: string;
  error_message: string;
  failed_at: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

const ERROR_TYPE_BADGE: Record<string, string> = {
  credential_failure: 'bg-red-100 text-red-700',
  structural_error:   'bg-purple-100 text-purple-700',
  quota_exceeded:     'bg-amber-100 text-amber-700',
  network_error:      'bg-gray-100 text-gray-600',
};
const ERROR_TYPE_LABEL: Record<string, string> = {
  credential_failure: 'Sai thông tin đăng nhập',
  structural_error:   'Lỗi cấu trúc GDT',
  quota_exceeded:     'Hết quota',
  network_error:      'Lỗi mạng',
};

export default function FailedJobsPage() {
  const [jobs,   setJobs]   = useState<FailedJob[]>([]);
  const [total,  setTotal]  = useState(0);
  const [page,   setPage]   = useState(1);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const PAGE_SIZE = 20;

  const load = async (p = page) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      if (filter !== 'all') params.set('errorType', filter);
      const res = await apiClient.get<{ data: { data: FailedJob[]; meta: { total: number } } }>(
        `/api/bot/failed-jobs?${params.toString()}`
      );
      setJobs(res.data.data.data ?? []);
      setTotal(res.data.data.meta?.total ?? 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [filter, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = async (id: string, resolution: string) => {
    await apiClient.post(`/api/bot/failed-jobs/${id}/resolve`, { resolution });
    setJobs(prev => prev.map(j => j.id === id ? { ...j, resolution, resolved_at: new Date().toISOString() } : j));
  };

  const ERROR_TYPES = ['all', 'credential_failure', 'structural_error', 'quota_exceeded', 'network_error'];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/admin/bot" className="text-sm text-blue-600 hover:underline">← Bot GDT</Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">Hàng đợi lỗi (DLQ)</h1>
          <p className="text-sm text-gray-500">Job thất bại vĩnh viễn — cần xử lý thủ công</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {ERROR_TYPES.map(et => (
          <button key={et}
            onClick={() => { setFilter(et); setPage(1); }}
            className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
              filter === et
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'
            }`}>
            {et === 'all' ? 'Tất cả' : (ERROR_TYPE_LABEL[et] ?? et)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không có job lỗi nào</p>
          <p className="text-sm mt-1">Hàng đợi lỗi trống — bot đang hoạt động tốt.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Thời gian</th>
                <th className="px-4 py-2 text-left">Loại lỗi</th>
                <th className="px-4 py-2 text-left">Chi tiết</th>
                <th className="px-4 py-2 text-left">Trạng thái xử lý</th>
                <th className="px-4 py-2 text-left">Hành động</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map(job => (
                <tr key={job.id} className={`hover:bg-gray-50 ${job.resolved_at ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {new Date(job.failed_at).toLocaleString('vi-VN')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ERROR_TYPE_BADGE[job.error_type] ?? 'bg-gray-100 text-gray-600'}`}>
                      {ERROR_TYPE_LABEL[job.error_type] ?? job.error_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-xs truncate" title={job.error_message}>
                    {job.error_message}
                  </td>
                  <td className="px-4 py-3">
                    {job.resolved_at ? (
                      <span className="text-xs text-green-600">
                        ✓ {job.resolution} — {new Date(job.resolved_at).toLocaleDateString('vi-VN')}
                      </span>
                    ) : (
                      <span className="text-xs text-amber-600">Chờ xử lý</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!job.resolved_at && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => resolve(job.id, 'reconfigured')}
                          className="px-2 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100">
                          Đã sửa
                        </button>
                        <button
                          onClick={() => resolve(job.id, 'dismissed')}
                          className="px-2 py-1 text-xs border border-gray-200 rounded hover:bg-gray-50">
                          Bỏ qua
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex justify-center gap-2">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 text-sm border rounded disabled:opacity-40">← Trước</button>
          <span className="px-3 py-1.5 text-sm text-gray-500">{page} / {Math.ceil(total / PAGE_SIZE)}</span>
          <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 text-sm border rounded disabled:opacity-40">Sau →</button>
        </div>
      )}
    </div>
  );
}
