'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';
import { useToast } from '../../../components/ToastProvider';
import { useSyncContext } from '../../../contexts/SyncContext';
import SyncDatePicker from '../../../components/SyncDatePicker';
import type { SyncJob } from '../../../components/SyncDatePicker';

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
  invoice_group: number | null;
  serial_has_cqt: boolean | null;
  has_line_items: boolean | null;
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
  gdt_bot: 'GDT Bot',
  manual: 'Nhập tay',
};

const GROUP_LABELS: Record<number, { label: string; color: string }> = {
  5: { label: 'Nhóm 5', color: 'bg-emerald-50 text-emerald-700' },
  6: { label: 'Nhóm 6', color: 'bg-orange-50 text-orange-700' },
  8: { label: 'Nhóm 8', color: 'bg-orange-50 text-orange-700' },
};

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const initialSearch = searchParams.get('search') ?? '';
  const initialDirection = searchParams.get('direction');
  const importSessionId = searchParams.get('importSessionId');
  const toast = useToast();
  const router = useRouter();
  const { activeCompany, activeCompanyId, loading: companyLoading } = useCompany();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<'output' | 'input' | ''>(
    initialDirection === 'output' || initialDirection === 'input' ? initialDirection : ''
  );
  const [invoiceGroup, setInvoiceGroup] = useState<number | ''>('');
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
      if (invoiceGroup !== '') params.invoiceGroup = invoiceGroup;

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
  }, [activeCompanyId, direction, debouncedSearch, importSessionId, invoiceGroup]);

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

  const [syncing, setSyncing] = useState(false);
  const [showBotSetup, setShowBotSetup] = useState(false);
  const [botPassword, setBotPassword] = useState('');
  const [botSetupLoading, setBotSetupLoading] = useState(false);
  const [showSyncPicker, setShowSyncPicker] = useState(false);
  const { syncJobIds, isSyncing, startSync } = useSyncContext();

  const openSyncPicker = () => {
    if (isSyncing) {
      toast.info('Đang có đồng bộ đang chạy. Nhấn Hủy đồng bộ nếu muốn dừng lại.');
      return;
    }
    setShowSyncPicker(true);
  };

  const handleSyncConfirm = async (jobs: SyncJob[]) => {
    if (syncing) return;
    setShowSyncPicker(false);
    setSyncing(true);
    try {
      const res = await apiClient.post<{ data: { jobIds: string[] } }>('/sync/start', { jobs });
      const ids = res.data.data.jobIds;
      startSync(ids, activeCompanyId ?? '');
      toast.success(`Đã kích hoạt đồng bộ ${jobs.length} kỳ. Theo dõi tiến trình bên dưới.`);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error('⚠️ Đang có đồng bộ đang chạy. Nhấn nút Hủy đồng bộ trên thanh tiến trình để dừng lại.');
      } else if (status === 428) {
        setShowBotSetup(true);
      } else {
        toast.error('Lỗi kích hoạt đồng bộ. Vui lòng thử lại.');
      }
    } finally {
      setSyncing(false);
    }
  };

  // Reload invoice list when sync finishes (panel closes)
  const prevSyncing = useRef(false);
  useEffect(() => {
    if (prevSyncing.current && !isSyncing) void load(1);
    prevSyncing.current = isSyncing;
  }, [isSyncing, load]);

  const handleBotSetup = async () => {
    if (!botPassword.trim()) {
      toast.error('Vui lòng nhập mật khẩu.');
      return;
    }
    setBotSetupLoading(true);
    try {
      await apiClient.post('/bot/setup', { password: botPassword });
      setShowBotSetup(false);
      setBotPassword('');
      // Now trigger sync
      await apiClient.post('/invoices/sync');
      toast.success('Đã cấu hình và kích hoạt đồng bộ. Hóa đơn sẽ cập nhật sau ít phút.');
      setTimeout(() => void load(1), 3000);
    } catch {
      toast.error('Lỗi cấu hình. Vui lòng kiểm tra lại mật khẩu cổng thuế.');
    } finally {
      setBotSetupLoading(false);
    }
  };

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load(meta.page)}
            disabled={loading}
            title="Tải lại danh sách"
            className="p-2 rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
          <button
            onClick={openSyncPicker}
            disabled={syncing}
            className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium active:bg-primary-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {syncing ? 'Đang xử lý...' : 'Đồng Bộ'}
          </button>
        </div>
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
      <div className="space-y-2 mb-4">
        {/* Search bar */}
        <input
          type="text"
          placeholder="Tìm số HĐ, tên..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        {/* Direction + Type filter tabs */}
        <div className="flex gap-1.5 flex-wrap">
          {/* Direction group */}
          {([
            { v: '',       label: 'Tất cả' },
            { v: 'input',  label: 'Mua vào' },
            { v: 'output', label: 'Bán ra' },
          ] as { v: '' | 'output' | 'input'; label: string }[]).map((opt) => (
            <button
              key={opt.v}
              onClick={() => { setDirection(opt.v); setInvoiceGroup(''); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                direction === opt.v && invoiceGroup === ''
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'
              }`}
            >
              {opt.label}
            </button>
          ))}
          {/* Separator */}
          <span className="self-center text-gray-300">|</span>
          {/* Invoice type group (5 / 6 / 8) */}
          {([
            { g: 5, label: 'Đã cấp mã',      color: 'emerald' },
            { g: 6, label: 'CQT nhận không mã', color: 'orange' },
            { g: 8, label: 'Máy tính tiền',   color: 'orange' },
          ] as { g: number; label: string; color: string }[]).map((opt) => (
            <button
              key={opt.g}
              onClick={() => { setInvoiceGroup(invoiceGroup === opt.g ? '' : opt.g); setDirection(''); }}
              title={opt.g === 5 ? 'Đã cấp mã hóa đơn' : opt.g === 6 ? 'Cục Thuế đã nhận không mã' : 'Cục Thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền'}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                invoiceGroup === opt.g
                  ? opt.color === 'emerald'
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-orange-500 text-white border-orange-500'
                  : opt.color === 'emerald'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:border-emerald-400'
                    : 'bg-orange-50 text-orange-700 border-orange-200 hover:border-orange-400'
              }`}
            >
              Loại {opt.g} · {opt.label}
            </button>
          ))}
        </div>
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
        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
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
                    {inv.invoice_group && inv.invoice_group !== 5 && (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${GROUP_LABELS[inv.invoice_group]?.color ?? 'bg-gray-100 text-gray-600'}`}>
                        {GROUP_LABELS[inv.invoice_group]?.label ?? `Nhóm ${inv.invoice_group}`}
                      </span>
                    )}
                    {inv.has_line_items === false && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                        Thiếu chi tiết
                      </span>
                    )}
                    {!inv.gdt_validated && inv.status === 'valid' && inv.invoice_group !== 6 && inv.invoice_group !== 8 && (
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

      {/* Sync date picker modal */}
      {showSyncPicker && (
        <SyncDatePicker
          onConfirm={(jobs) => void handleSyncConfirm(jobs)}
          onCancel={() => setShowSyncPicker(false)}
          syncing={syncing}
        />
      )}

      {/* GDT Bot setup modal — shown when bot not yet configured */}
      {showBotSetup && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-1">Cấu hình đồng bộ GDT</h3>
            <p className="text-sm text-gray-500 mb-4">
              Nhập mật khẩu cổng thuế điện tử để bắt đầu đồng bộ hóa đơn.
            </p>
            <div className="mb-3">
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                Tên đăng nhập (MST công ty — tự động)
              </label>
              <input
                type="text"
                disabled
                value={activeCompany?.tax_code ?? ''}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
              />
            </div>
            <div className="mb-5">
              <label className="text-xs font-medium text-gray-600 mb-1 block">
                Mật khẩu cổng thuế điện tử
              </label>
              <input
                type="password"
                value={botPassword}
                onChange={(e) => setBotPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleBotSetup(); }}
                placeholder="Nhập mật khẩu..."
                autoFocus
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { setShowBotSetup(false); setBotPassword(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleBotSetup()}
                disabled={botSetupLoading || !botPassword.trim()}
                className="flex-1 py-2.5 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
              >
                {botSetupLoading ? 'Đang lưu...' : 'Lưu & Đồng Bộ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
