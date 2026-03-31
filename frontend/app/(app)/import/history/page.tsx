'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../../lib/apiClient';
import BackButton from '../../../../components/BackButton';

interface ImportSession {
  id:              string;
  filename:        string;
  format:          string;
  direction:       string;
  period_month:    number | null;
  period_year:     number | null;
  total_rows:      number;
  success_count:   number;
  error_count:     number;
  duplicate_count: number;
  status:          string;
  created_at:      string;
  user_name:       string;
}

const STATUS_BADGE: Record<string, string> = {
  completed:  'bg-green-100 text-green-700',
  processing: 'bg-blue-100 text-blue-700',
  failed:     'bg-red-100 text-red-700',
};

const FORMAT_LABEL: Record<string, string> = {
  gdt_xml:      'XML GDT',
  gdt_excel:    'Excel GDT',
  csv:          'CSV',
  htkk_xml:     'HTKK XML',
  custom_excel: 'Excel tùy chỉnh',
};

export default function ImportHistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [loading, setLoading]   = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirm, setConfirm]   = useState<ImportSession | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: ImportSession[] }>('/import/sessions');
      setSessions(res.data.data);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const deleteSession = async (session: ImportSession) => {
    setDeleting(session.id);
    try {
      await apiClient.delete(`/import/sessions/${session.id}`);
      setConfirm(null);
      await load();
    } catch { /* silent */ } finally {
      setDeleting(null);
    }
  };

  const dirLabel = (d: string) =>
    d === 'output' ? '↑ Ra' : d === 'input' ? '↓ Vào' : d === 'both' ? '↕ Cả hai' : d;

  if (loading) return (
    <div className="flex justify-center py-24">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto pb-24 space-y-4">
      <BackButton fallbackHref="/import" />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Lịch sử Import</h1>
        <button onClick={() => router.push('/import')}
          className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg font-medium">
          + Import mới
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📭</p>
          <p className="font-medium">Chưa có lần import nào</p>
          <button onClick={() => router.push('/import')}
            className="mt-4 text-sm text-blue-600 underline">
            Bắt đầu import hóa đơn
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => (
            <div key={s.id} className="bg-white rounded-xl border border-gray-100 p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 truncate text-sm">{s.filename}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {new Date(s.created_at).toLocaleString('vi-VN')} · {s.user_name}
                  </p>
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[s.status] ?? 'bg-gray-100 text-gray-600'}`}>
                  {s.status}
                </span>
              </div>

              <div className="flex flex-wrap gap-2 text-xs mb-3">
                <span className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                  {FORMAT_LABEL[s.format] ?? s.format}
                </span>
                <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                  {dirLabel(s.direction)}
                </span>
                {s.period_month && (
                  <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    T{s.period_month}/{s.period_year}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
                <div className="bg-green-50 rounded-lg p-2">
                  <p className="font-bold text-green-700">{s.success_count}</p>
                  <p className="text-gray-400">Thành công</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <p className="font-bold text-gray-600">{s.duplicate_count}</p>
                  <p className="text-gray-400">Trùng lặp</p>
                </div>
                <div className={`rounded-lg p-2 ${s.error_count > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <p className={`font-bold ${s.error_count > 0 ? 'text-red-600' : 'text-gray-400'}`}>{s.error_count}</p>
                  <p className="text-gray-400">Lỗi</p>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => router.push(`/invoices?importSessionId=${s.id}`)}
                  className="flex-1 border border-gray-300 rounded-lg py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                  Xem HĐ đã nhập
                </button>
                <button
                  onClick={() => setConfirm(s)}
                  className="border border-red-200 text-red-600 rounded-lg px-3 py-1.5 text-xs hover:bg-red-50">
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirm modal */}
      {confirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <p className="font-bold text-gray-900">Xóa session import?</p>
            <p className="text-sm text-gray-600">
              Thao tác này sẽ xóa <strong>{confirm.success_count} hóa đơn</strong> đã nhập từ file{' '}
              <em>{confirm.filename}</em>. Không thể hoàn tác.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirm(null)}
                className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">
                Hủy
              </button>
              <button onClick={() => void deleteSession(confirm)} disabled={!!deleting}
                className="flex-1 bg-red-600 text-white rounded-xl py-2.5 text-sm font-medium disabled:opacity-50">
                {deleting ? 'Đang xóa...' : 'Xóa'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
