'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';
import { useToast } from '../../../components/ToastProvider';

interface Invoice {
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
  vat_rate: number;
  gdt_validated: boolean;
  provider: string;
}

interface PaginatedResponse {
  data: Invoice[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  valid:    { label: 'Hợp lệ', color: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Đã hủy', color: 'bg-red-100 text-red-700' },
  replaced: { label: 'Thay thế', color: 'bg-yellow-100 text-yellow-700' },
  adjusted: { label: 'Điều chỉnh', color: 'bg-blue-100 text-blue-700' },
};

const PROVIDER_LABELS: Record<string, string> = {
  misa: 'MISA',
  viettel: 'Viettel',
  bkav: 'BKAV',
  gdt_intermediary: 'GDT',
};

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get('search') ?? '';
  const initialDirection = searchParams.get('direction');
  const importSessionId = searchParams.get('importSessionId');
  const toast = useToast();
  const router = useRouter();
  const { activeCompanyId, loading: companyLoading } = useCompany();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<'output' | 'input' | ''>(
    initialDirection === 'output' || initialDirection === 'input' ? initialDirection : ''
  );
  const [trashCount, setTrashCount] = useState(0);
  // Delete modal state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState<'duplicate' | 'invalid' | 'test_data' | 'other'>('other');
  const [deleting, setDeleting] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (page = 1) => {
    if (!activeCompanyId) return;
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, pageSize: 50 };
      if (direction) params.direction = direction;
      if (debouncedSearch) params.search = debouncedSearch;
      if (importSessionId) params.importSessionId = importSessionId;

      const [res, trashRes] = await Promise.all([
        apiClient.get<PaginatedResponse>('/invoices', { params }),
        apiClient.get<{ meta: { total: number } }>('/invoices/trash', { params: { tab: 'deleted', pageSize: 1 } }).catch(() => ({ data: { meta: { total: 0 } } })),
      ]);
      setInvoices(res.data.data);
      setMeta(res.data.meta);
      setTrashCount((trashRes as { data: { meta: { total: number } } }).data.meta?.total ?? 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, direction, debouncedSearch, importSessionId]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/invoices/${deleteTarget}`, { data: { reason: deleteReason } });
      toast.success('Hóa đơn đã được ẩn vào thùng rác');
      setDeleteTarget(null);
      void load(meta.page);
    } catch {
      toast.error('Lỗi khi ẩn hóa đơn. Vui lòng thử lại.');
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!companyLoading) void load(1);
  }, [load, companyLoading]);

  const triggerSync = async () => {
    try {
      await apiClient.post('/invoices/sync');
      toast.success('Đã kích hoạt đồng bộ hóa đơn!');
    } catch {
      toast.error('Lỗi kích hoạt đồng bộ. Vui lòng thử lại.');
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hóa Đơn</h1>
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-500">{meta.total.toLocaleString('vi-VN')} hóa đơn</p>
            {trashCount > 0 && (
              <button
                onClick={() => router.push('/invoices/trash')}
                className="text-xs text-gray-400 hover:text-red-500 underline"
              >
                Thùng rác ({trashCount})
              </button>
            )}
          </div>
        </div>
        <button
          onClick={triggerSync}
          className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium active:bg-primary-700"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Đồng Bộ
        </button>
      </div>

      {/* Import session banner */}
      {importSessionId && (
        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 mb-4 text-sm">
          <span className="text-blue-700 font-medium">📥 Đang xem hóa đơn mới nhập</span>
          <button
            onClick={() => { window.location.href = '/invoices'; }}
            className="text-blue-600 underline text-xs"
          >
            Xem tất cả
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Tìm số HĐ, tên..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as 'output' | 'input' | '')}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">Tất cả</option>
          <option value="output">Bán ra</option>
          <option value="input">Mua vào</option>
        </select>
      </div>

      {/* Invoice List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không có hóa đơn nào</p>
          <p className="text-sm mt-1">Nhấn &quot;Đồng Bộ&quot; để tải hóa đơn</p>
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((inv) => {
            const statusInfo = STATUS_LABELS[inv.status] ?? { label: inv.status, color: 'bg-gray-100 text-gray-700' };
            return (
              <div
                key={inv.id}
                className="bg-white rounded-xl shadow-sm p-4 relative cursor-pointer active:bg-gray-50"
                onClick={() => { setOpenMenu(null); router.push(`/invoices/${inv.id}`); }}
              >
                {/* Menu button — stopPropagation để không trigger navigate */}
                <button
                  onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === inv.id ? null : inv.id); }}
                  className="absolute top-3 right-3 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 z-10"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/>
                  </svg>
                </button>
                {openMenu === inv.id && (
                  <div className="absolute top-9 right-3 bg-white rounded-xl shadow-lg border border-gray-100 z-20 py-1 min-w-[140px]">
                    <button
                      onClick={(e) => { e.stopPropagation(); router.push(`/invoices/${inv.id}`); setOpenMenu(null); }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Xem chi tiết
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteTarget(inv.id); setOpenMenu(null); }}
                      className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                    >
                      Ẩn hóa đơn
                    </button>
                  </div>
                )}
                {/* pr-8 để nội dung không bị đè bởi nút ⋮ */}
                <div className="pr-8">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{inv.invoice_number}</p>
                    <p className="text-xs text-gray-400">{inv.serial_number} · {PROVIDER_LABELS[inv.provider] ?? inv.provider}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                    {!inv.gdt_validated && inv.status === 'valid' && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                        Chờ GDT
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-gray-500 mb-2">
                  <p>{inv.direction === 'output' ? '→ ' + inv.buyer_name : '← ' + inv.seller_name}</p>
                  <p>{format(new Date(inv.invoice_date), 'dd/MM/yyyy', { locale: vi })}</p>
                </div>

                <div className="flex justify-between items-end">
                  <div className="text-xs text-gray-400">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${inv.direction === 'output' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
                      {inv.direction === 'output' ? 'Bán ra' : 'Mua vào'}
                    </span>
                    <span className="ml-2">VAT {inv.vat_rate}%</span>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-gray-900 text-sm">
                      {Number(inv.total_amount).toLocaleString('vi-VN')}đ
                    </p>
                    <p className="text-xs text-gray-400">
                      VAT: {Number(inv.vat_amount).toLocaleString('vi-VN')}đ
                    </p>
                  </div>
                </div>
                </div>{/* end pr-8 wrapper */}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          {Array.from({ length: Math.min(meta.totalPages, 5) }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => load(p)}
              className={`w-9 h-9 rounded-lg text-sm font-medium ${p === meta.page ? 'bg-primary-600 text-white' : 'bg-white text-gray-700 border border-gray-300'}`}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-1">Ẩn hóa đơn này?</h3>
            <p className="text-sm text-gray-500 mb-4">
              Hóa đơn sẽ vào thùng rác và không xuất hiện trong báo cáo. Có thể khôi phục sau.
            </p>
            <div className="mb-4">
              <label className="text-xs font-medium text-gray-600 mb-1 block">Lý do</label>
              <select
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value as typeof deleteReason)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="duplicate">Trùng lặp</option>
                <option value="invalid">Không hợp lệ</option>
                <option value="test_data">Dữ liệu test</option>
                <option value="other">Lý do khác</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700"
              >
                Hủy
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium disabled:opacity-50"
              >
                {deleting ? 'Đang ẩn...' : 'Xác nhận ẩn'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
