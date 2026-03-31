'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { useToast } from '../../../../components/ToastProvider';

interface TrashedInvoice {
  id: string;
  invoice_number: string;
  serial_number: string;
  invoice_date: string;
  direction: 'output' | 'input';
  status: string;
  seller_name: string;
  buyer_name: string;
  total_amount: string;
  vat_amount: string;
  deleted_at: string | null;
  delete_reason: string | null;
  is_permanently_ignored: boolean;
  deleted_by_name: string | null;
}

interface PaginatedResponse {
  data: TrashedInvoice[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

const REASON_LABELS: Record<string, string> = {
  duplicate:  'Trùng lặp',
  invalid:    'Không hợp lệ',
  test_data:  'Dữ liệu test',
  other:      'Lý do khác',
};

export default function TrashPage() {
  const router = useRouter();
  const toast  = useToast();
  const { activeCompanyId, loading: companyLoading } = useCompany();

  const [tab, setTab]         = useState<'deleted' | 'ignored'>('deleted');
  const [invoices, setInvoices] = useState<TrashedInvoice[]>([]);
  const [meta, setMeta]         = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionLoading, setActionLoading] = useState(false);

  const load = useCallback(async (page = 1) => {
    if (!activeCompanyId) return;
    setLoading(true);
    try {
      const res = await apiClient.get<PaginatedResponse>('/invoices/trash', {
        params: { tab, page, pageSize: 50 },
      });
      setInvoices(res.data.data);
      setMeta(res.data.meta);
      setSelected(new Set());
    } catch {
      toast.error('Không thể tải thùng rác');
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, tab, toast]);

  useEffect(() => {
    if (!companyLoading) void load(1);
  }, [load, companyLoading]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(invoices.map(i => i.id)));
  const deselectAll = () => setSelected(new Set());

  const handleBulkRestore = async () => {
    if (!selected.size) return;
    setActionLoading(true);
    try {
      await apiClient.post('/invoices/bulk-restore', { ids: Array.from(selected) });
      toast.success(`Đã khôi phục ${selected.size} hóa đơn`);
      void load(1);
    } catch {
      toast.error('Lỗi khôi phục. Vui lòng thử lại.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestore = async (id: string) => {
    setActionLoading(true);
    try {
      await apiClient.post(`/invoices/${id}/restore`);
      toast.success('Đã khôi phục hóa đơn');
      void load(meta.page);
    } catch {
      toast.error('Không thể khôi phục hóa đơn này');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePermanentIgnore = async (id: string) => {
    if (!confirm('Bỏ qua vĩnh viễn hóa đơn này? Bot sẽ không bao giờ tải lại.')) return;
    setActionLoading(true);
    try {
      await apiClient.delete(`/invoices/${id}/permanent-ignore`, { data: { confirm: 'IGNORE_PERMANENTLY' } });
      toast.success('Đã bỏ qua vĩnh viễn');
      void load(meta.page);
    } catch {
      toast.error('Không thể thực hiện thao tác này');
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkPermanentIgnore = async () => {
    if (!selected.size) return;
    if (!confirm(`Bỏ qua vĩnh viễn ${selected.size} hóa đơn? Bot sẽ không bao giờ tải lại.`)) return;
    setActionLoading(true);
    try {
      await apiClient.post('/invoices/bulk-permanent-ignore', { ids: Array.from(selected) });
      toast.success(`Đã bỏ qua vĩnh viễn ${selected.size} hóa đơn`);
      void load(1);
    } catch {
      toast.error('Lỗi. Vui lòng thử lại.');
    } finally {
      setActionLoading(false);
    }
  };

  const fmtMoney = (v: string) => Number(v).toLocaleString('vi-VN') + ' ₫';
  const fmtDate  = (d: string) => format(new Date(d), 'dd/MM/yyyy', { locale: vi });

  const deletedCount  = tab === 'deleted' ? meta.total : 0;
  const ignoredCount  = tab === 'ignored' ? meta.total : 0;

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push('/invoices')}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Thùng Rác</h1>
          <p className="text-xs text-gray-500">
            Đã ẩn: {deletedCount} · Bỏ qua vĩnh viễn: {ignoredCount}
          </p>
        </div>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-700">
        Hóa đơn trong thùng rác không xuất hiện trong bất kỳ báo cáo nào.
        Khôi phục để đưa trở lại hệ thống, hoặc đặt &quot;bỏ qua vĩnh viễn&quot; nếu chắc chắn không cần.
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 mb-4">
        <button
          onClick={() => setTab('deleted')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            tab === 'deleted' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          }`}
        >
          Đã ẩn (có thể khôi phục)
        </button>
        <button
          onClick={() => setTab('ignored')}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            tab === 'ignored' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          }`}
        >
          ⛔ Bỏ qua vĩnh viễn
        </button>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between bg-gray-800 text-white rounded-xl px-4 py-2.5 mb-3 text-sm">
          <span>Đã chọn {selected.size} hóa đơn</span>
          <div className="flex gap-2">
            <button onClick={deselectAll} className="text-gray-400 text-xs underline">Bỏ chọn</button>
            {tab === 'deleted' && (
              <>
                <button
                  onClick={handleBulkRestore}
                  disabled={actionLoading}
                  className="bg-green-500 text-white px-3 py-1 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  Khôi phục {selected.size}
                </button>
                <button
                  onClick={handleBulkPermanentIgnore}
                  disabled={actionLoading}
                  className="bg-red-500 text-white px-3 py-1 rounded-lg text-xs font-medium disabled:opacity-50"
                >
                  ⛔ Bỏ qua vĩnh viễn
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Select all row */}
      {invoices.length > 0 && tab === 'deleted' && (
        <div className="flex items-center gap-2 mb-2 text-xs text-gray-500 px-1">
          <button onClick={selected.size === invoices.length ? deselectAll : selectAll} className="underline">
            {selected.size === invoices.length ? 'Bỏ chọn tất cả' : 'Chọn tất cả trang này'}
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          <p className="font-medium">Thùng rác trống</p>
          <p className="text-sm mt-1">
            {tab === 'deleted' ? 'Khi bạn ẩn hóa đơn, chúng sẽ xuất hiện ở đây' : 'Chưa có hóa đơn nào bị bỏ qua vĩnh viễn'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((inv) => (
            <div
              key={inv.id}
              className={`bg-white rounded-xl shadow-sm p-4 opacity-70 border-l-4 ${
                inv.is_permanently_ignored ? 'border-red-400' : 'border-gray-300'
              } ${selected.has(inv.id) ? 'ring-2 ring-primary-400' : ''}`}
            >
              <div className="flex items-start gap-3">
                {/* Checkbox (only for soft-deleted tab) */}
                {tab === 'deleted' && (
                  <input
                    type="checkbox"
                    checked={selected.has(inv.id)}
                    onChange={() => toggleSelect(inv.id)}
                    className="mt-1 w-4 h-4 accent-primary-600 flex-shrink-0"
                  />
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between mb-1">
                    <div>
                      <p className="font-semibold text-gray-700 text-sm">{inv.invoice_number}</p>
                      <p className="text-xs text-gray-400">{inv.serial_number}</p>
                    </div>
                    {inv.is_permanently_ignored && (
                      <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                        ⛔ Bot không tải lại
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-gray-500 mb-1">
                    {inv.direction === 'output' ? '→ ' + inv.buyer_name : '← ' + inv.seller_name}
                    {' · '}{fmtDate(inv.invoice_date)}
                  </p>

                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-400">
                      <span>Lý do: {REASON_LABELS[inv.delete_reason ?? ''] ?? inv.delete_reason ?? '—'}</span>
                      {inv.deleted_by_name && <span className="ml-2">bởi {inv.deleted_by_name}</span>}
                      {inv.deleted_at && <span className="ml-2">{fmtDate(inv.deleted_at)}</span>}
                    </div>
                    <p className="font-semibold text-gray-700 text-sm">
                      {fmtMoney(inv.total_amount)}
                    </p>
                  </div>

                  {/* Actions */}
                  {!inv.is_permanently_ignored && tab === 'deleted' && (
                    <div className="mt-2 flex gap-3">
                      <button
                        onClick={() => handleRestore(inv.id)}
                        disabled={actionLoading}
                        className="text-xs text-green-600 font-medium underline disabled:opacity-50"
                      >
                        Khôi phục
                      </button>
                      <button
                        onClick={() => handlePermanentIgnore(inv.id)}
                        disabled={actionLoading}
                        className="text-xs text-red-500 font-medium underline disabled:opacity-50"
                      >
                        ⛔ Bỏ qua vĩnh viễn
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            disabled={meta.page <= 1}
            onClick={() => load(meta.page - 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40"
          >
            ‹ Trước
          </button>
          <span className="text-sm text-gray-500">{meta.page}/{meta.totalPages}</span>
          <button
            disabled={meta.page >= meta.totalPages}
            onClick={() => load(meta.page + 1)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40"
          >
            Sau ›
          </button>
        </div>
      )}
    </div>
  );
}
