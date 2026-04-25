'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import apiClient from '../../../lib/apiClient';
import { useCompany } from '../../../contexts/CompanyContext';
import { useToast } from '../../../components/ToastProvider';
import InvoiceGrid from '../../../components/invoices/InvoiceGrid';
import type { GridInvoice, GridMeta } from '../../../components/invoices/InvoiceGrid';

interface PaginatedResponse {
  success: boolean;
  data: GridInvoice[];
  meta: GridMeta;
}

const DIR_OPTS: { v: '' | 'output' | 'input'; label: string }[] = [
  { v: '',       label: 'Tất cả hướng' },
  { v: 'output', label: '↑ Bán ra' },
  { v: 'input',  label: '↓ Mua vào' },
];

const GROUP_OPTS = [
  { v: ''  as const, label: 'Tất cả loại',    cls: 'border-gray-300 text-gray-600 hover:border-gray-500',       activeCls: 'bg-gray-900 text-white border-gray-900' },
  { v: 5   as const, label: '5 · Đã cấp mã',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:border-emerald-400', activeCls: 'bg-emerald-600 text-white border-emerald-600' },
  { v: 6   as const, label: '6 · CQT không mã', cls: 'bg-orange-50 text-orange-700 border-orange-200 hover:border-orange-400',  activeCls: 'bg-orange-600 text-white border-orange-600' },
  { v: 8   as const, label: '8 · MTT',         cls: 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-400',    activeCls: 'bg-amber-600 text-white border-amber-600' },
];

const SCO_OPTS: { v: boolean | null; label: string }[] = [
  { v: null,  label: 'Tất cả nguồn' },
  { v: false, label: 'HĐ điện tử' },
  { v: true,  label: 'HĐ máy tính tiền' },
];

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const importSessionId = searchParams.get('importSessionId');
  const toast = useToast();
  const router = useRouter();
  const { activeCompany, activeCompanyId, loading: companyLoading } = useCompany();

  const [invoices, setInvoices] = useState<GridInvoice[]>([]);
  const [meta, setMeta] = useState<GridMeta>({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<'output' | 'input' | ''>(
    (searchParams.get('direction') as 'output' | 'input') || ''
  );
  const [invoiceGroup, setInvoiceGroup] = useState<number | ''>('');
  const [isSco, setIsSco] = useState<boolean | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [trashCount, setTrashCount] = useState(0);
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [pageSize, setPageSize] = useState(50);

  // Count check modal state
  const [countChecking, setCountChecking] = useState(false);
  interface CountResult {
    db_output: number; db_input: number; db_total: number;
    last_run_output: number | null; last_run_input: number | null; last_run_total: number | null;
    last_run_at: string | null; from_date: string | null; to_date: string | null;
  }
  const [countResult, setCountResult] = useState<CountResult | null>(null);

  // Selection
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Delete / ignore modals
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState<'duplicate' | 'invalid' | 'test_data' | 'other'>('other');
  const [deleting, setDeleting] = useState(false);
  const [ignoreTarget, setIgnoreTarget] = useState<string | null>(null);
  const [ignoring, setIgnoring] = useState(false);

  // ── Smart filter logic (GDT rules) ────────────────────────────────────────
  // For Bán ra: no type 5/6/8 filter (GDT "Kết quả kiểm tra" = Tất cả).
  // For Mua vào: Row 2 (type 5/6/8) and Row 4 (nguồn) are INDEPENDENT filters.
  // Row 2 always shows all 3 types; Row 4 always shows both options.
  // Hierarchy: Row 2 → Row 4, not the other way around.
  const visibleGroupOpts = useMemo(() => {
    if (direction === 'output') return []; // Bán ra — no type filter
    return GROUP_OPTS; // Mua vào / Tất cả hướng: always show all types
  }, [direction]);

  const handleDirectionSelect = (v: '' | 'output' | 'input') => {
    setDirection(v);
    setInvoiceGroup('');  // clear type when switching direction
    setIsSco(null);       // reset source
    setSelectedIds([]);
  };

  const handleGroupSelect = (v: number | '') => {
    setInvoiceGroup(invoiceGroup === v ? '' : v as number | '');
    setSelectedIds([]);
  };

  const handleIsScoSelect = (v: boolean | null) => {
    setIsSco(isSco === v ? null : v);
    setSelectedIds([]);
  };

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (page = 1) => {
    if (!activeCompanyId) return;
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, pageSize };
      if (direction) params.direction = direction;
      if (statusFilter) params.status = statusFilter;
      if (debouncedSearch) params.search = debouncedSearch;
      if (importSessionId) params.importSessionId = importSessionId;
      if (invoiceGroup !== '') params.invoiceGroup = invoiceGroup;
      if (isSco !== null) params.isSco = String(isSco);
      if (fromDate) params.fromDate = fromDate;
      if (toDate) params.toDate = toDate;

      const [res, trashRes] = await Promise.all([
        apiClient.get<PaginatedResponse>('/invoices', { params }),
        apiClient.get<{ meta: { total: number } }>('/invoices/trash', { params: { pageSize: 1 } })
          .catch(() => ({ data: { meta: { total: 0 } } })),
      ]);
      setInvoices(res.data.data);
      setMeta(res.data.meta);
      setTrashCount((trashRes as { data: { meta: { total: number } } }).data.meta?.total ?? 0);
      setSelectedIds([]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [activeCompanyId, direction, statusFilter, debouncedSearch, importSessionId, invoiceGroup, isSco, fromDate, toDate, pageSize]);

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

  const handlePermanentIgnore = async () => {
    if (!ignoreTarget) return;
    setIgnoring(true);
    try {
      await apiClient.delete(`/invoices/${ignoreTarget}`, { data: { reason: 'permanent' } });
      toast.success('Hóa đơn đã bị bỏ qua vĩnh viễn');
      setIgnoreTarget(null);
      void load(meta.page);
    } catch {
      toast.error('Lỗi. Vui lòng thử lại.');
    } finally {
      setIgnoring(false);
    }
  };

  useEffect(() => {
    if (!companyLoading) void load(1);
  }, [load, companyLoading]);

  // ── Refresh handler — just re-fetch data, no GDT sync trigger ──────────
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const params: Record<string, unknown> = { page: 1, pageSize };
      if (direction)    params.direction    = direction;
      if (statusFilter) params.status       = statusFilter;
      if (invoiceGroup !== '') params.invoiceGroup = invoiceGroup;
      if (isSco !== null) params.isSco = String(isSco);
      if (fromDate)     params.fromDate     = fromDate;
      if (toDate)       params.toDate       = toDate;
      const res = await apiClient.get<PaginatedResponse>('/invoices', { params });
      setInvoices(res.data.data);
      setMeta(res.data.meta);
      setSelectedIds([]);
      toast.success('Đã làm mới dữ liệu');
    } catch {
      toast.error('Làm mới thất bại. Vui lòng thử lại.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleExcelExport = async () => {
    try {
      const params = new URLSearchParams();
      if (direction)            params.set('direction',    direction);
      if (debouncedSearch)      params.set('search',       debouncedSearch);
      if (invoiceGroup !== '')  params.set('invoiceGroup', String(invoiceGroup));
      if (isSco !== null)       params.set('isSco',        String(isSco));
      if (fromDate)             params.set('fromDate',     fromDate);
      if (toDate)               params.set('toDate',       toDate);
      const res = await apiClient.get(`/invoices/export?${params.toString()}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `HoaDon_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Xuất Excel thất bại. Vui lòng thử lại.');
    }
  };

  const handleCheckCount = async () => {
    if (countChecking) return;
    setCountChecking(true);
    setCountResult(null);
    try {
      const params = new URLSearchParams();
      if (fromDate) params.set('fromDate', fromDate);
      if (toDate)   params.set('toDate',   toDate);
      const res = await apiClient.get<{ success: boolean; data: CountResult }>(
        `/bot/invoice-count?${params.toString()}`
      );
      setCountResult(res.data.data);
    } catch {
      toast.error('Không thể kiểm tra số lượng. Vui lòng thử lại.');
    } finally {
      setCountChecking(false);
    }
  };

  const handleToggleNonDeductible = async (id: string, value: boolean) => {
    try {
      await apiClient.patch(`/invoices/${id}/non-deductible`, { non_deductible: value });
      setInvoices(prev => prev.map(inv => inv.id === id ? { ...inv, non_deductible: value } : inv));
      toast.success(value ? 'Đã loại khỏi khấu trừ thuế' : 'Đã đưa lại vào khấu trừ');
    } catch {
      toast.error('Cập nhật thất bại. Vui lòng thử lại.');
    }
  };

  return (
    <div className="p-4 max-w-[1400px] mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hóa Đơn</h1>
          <div className="flex items-center gap-3">
            <p className="text-sm text-gray-500">{meta.total.toLocaleString('vi-VN')} hóa đơn</p>
            {trashCount > 0 && (
              <button onClick={() => router.push('/invoices/trash')} className="text-xs text-gray-400 hover:text-red-500 underline">
                Thùng rác ({trashCount})
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Count check button — compare DB count vs last bot run */}
          <button
            onClick={() => void handleCheckCount()}
            disabled={countChecking}
            title="So sánh số lượng hóa đơn trong DB với lần đồng bộ cuối"
            className="flex items-center gap-2 bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60 hover:bg-gray-50 transition-colors"
          >
            <svg className={`w-4 h-4 ${countChecking ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            {countChecking ? 'Đang kiểm tra...' : 'Kiểm tra số lượng'}
          </button>
          {/* Refresh button — re-fetches data from DB, no GDT sync */}
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="flex items-center gap-2 bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-60 hover:bg-primary-700 transition-colors"
          >
            <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Đang tải...' : 'Làm mới'}
          </button>
        </div>
      </div>

      {/* ── Import session banner ── */}
      {importSessionId && (
        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 mb-4 text-sm">
          <span className="text-blue-700 font-medium">📥 Đang xem hóa đơn mới nhập</span>
          <button onClick={() => { window.location.href = '/invoices'; }} className="text-blue-600 underline text-xs">Xem tất cả</button>
        </div>
      )}

      {/* ── Filter Row 1: Direction ── */}
      <div className="flex gap-1.5 mb-2 flex-wrap">
        {DIR_OPTS.map(opt => (
          <button key={opt.v}
            onClick={() => handleDirectionSelect(opt.v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              direction === opt.v ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Filter Row 2: Invoice Group (Kết quả kiểm tra) ── */}
      {/* Bán ra has no type filter (GDT shows Tất cả for Kết quả kiểm tra). */}
      {/* Mua vào: types 5/6 → HĐ điện tử; type 8 → HĐ máy tính tiền. */}
      {visibleGroupOpts.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {direction === 'input' && (
            <span className="text-xs text-gray-400 font-medium mr-1">Kết quả KT:</span>
          )}
          {visibleGroupOpts.map(opt => (
            <button key={String(opt.v)}
              onClick={() => handleGroupSelect(opt.v as number | '')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                invoiceGroup === opt.v ? opt.activeCls : `bg-white ${opt.cls}`
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Filter Row 3: Source type (HĐ điện tử vs HĐ máy tính tiền) ── */}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {SCO_OPTS.map(opt => (
          <button key={String(opt.v)}
            onClick={() => handleIsScoSelect(opt.v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              isSco === opt.v
                ? opt.v === true
                  ? 'bg-purple-600 text-white border-purple-600'
                  : opt.v === false
                    ? 'bg-sky-600 text-white border-sky-600'
                    : 'bg-gray-900 text-white border-gray-900'
                : opt.v === true
                  ? 'bg-white text-purple-700 border-purple-200 hover:border-purple-400'
                  : opt.v === false
                    ? 'bg-white text-sky-700 border-sky-200 hover:border-sky-400'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Filter Row 3b: Status (trạng thái — trên ngày tháng để dễ lọc nhanh) ── */}
      <div className="flex gap-1.5 mb-3 flex-wrap">
        {([
          { v: '',                  label: 'Tất cả trạng thái', cls: 'border-gray-300 text-gray-600',                activeCls: 'bg-gray-900 text-white border-gray-900' },
          { v: 'valid',             label: '✅ Hợp lệ',          cls: 'bg-green-50 text-green-700 border-green-200',   activeCls: 'bg-green-600 text-white border-green-600' },
          { v: 'cancelled',         label: '⛔ Đã hủy',          cls: 'bg-red-50 text-red-700 border-red-200',         activeCls: 'bg-red-600 text-white border-red-600' },
          { v: 'replaced',          label: '↺ HĐ thay thế',      cls: 'bg-yellow-50 text-yellow-700 border-yellow-200', activeCls: 'bg-yellow-500 text-white border-yellow-500' },
          { v: 'replaced_original', label: '🔄 Bị thay thế',     cls: 'bg-orange-50 text-orange-700 border-orange-200', activeCls: 'bg-orange-600 text-white border-orange-600' },
          { v: 'adjusted',          label: '✏ HĐ điều chỉnh',    cls: 'bg-blue-50 text-blue-700 border-blue-200',      activeCls: 'bg-blue-600 text-white border-blue-600' },
          { v: 'invalid',           label: '⚠ Không hợp lệ',    cls: 'bg-orange-50 text-orange-700 border-orange-200', activeCls: 'bg-orange-600 text-white border-orange-600' },
        ] as const).map(opt => (
          <button key={opt.v}
            onClick={() => { setStatusFilter(statusFilter === opt.v ? '' : opt.v); setSelectedIds([]); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              statusFilter === opt.v ? opt.activeCls : `bg-white ${opt.cls} hover:border-gray-400`
            }`}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* ── Filter Row 4: Date range ── */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <span className="text-xs text-gray-500 font-medium">Ngày lập:</span>
        <input
          type="date"
          value={fromDate}
          onChange={e => { setFromDate(e.target.value); setSelectedIds([]); }}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <span className="text-xs text-gray-400">—</span>
        <input
          type="date"
          value={toDate}
          onChange={e => { setToDate(e.target.value); setSelectedIds([]); }}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        {(fromDate || toDate) && (
          <button
            onClick={() => { setFromDate(''); setToDate(''); setSelectedIds([]); }}
            className="text-xs text-gray-400 hover:text-gray-700 underline">
            Xóa
          </button>
        )}
      </div>

      {/* ── Filter Row 5: Search ── */}
      <div className="mb-4">
        <input
          type="text"
          placeholder="Tìm số HĐ, ký hiệu, tên NCC / KH, MST..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full border border-gray-300 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {/* ── Invoice Grid ── */}
      <InvoiceGrid
        invoices={invoices}
        meta={meta}
        loading={loading}
        direction={direction}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onDelete={(id) => setDeleteTarget(id)}
        onPermanentIgnore={(id) => setIgnoreTarget(id)}
        onToggleNonDeductible={(id, value) => void handleToggleNonDeductible(id, value)}
        onPageChange={(p) => void load(p)}
        onPageSizeChange={(size) => setPageSize(size)}
        onExcelExport={handleExcelExport}
        onRefresh={() => void load(meta.page)}
      />

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

      {/* ── Permanent Ignore modal ── */}
      {ignoreTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm p-5 shadow-xl">
            <h3 className="text-base font-bold text-gray-900 mb-1">Bỏ qua vĩnh viễn?</h3>
            <p className="text-sm text-gray-500 mb-5">
              Hóa đơn này sẽ không bao giờ xuất hiện lại trong danh sách, ngay cả sau khi đồng bộ mới.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setIgnoreTarget(null)} className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm font-medium text-gray-700">Hủy</button>
              <button onClick={() => void handlePermanentIgnore()} disabled={ignoring}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium disabled:opacity-50">
                {ignoring ? 'Đang xử lý...' : 'Bỏ qua vĩnh viễn'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Count Check Result Modal ── */}
      {countResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-gray-900">Kiểm tra số lượng hóa đơn</h3>
              <button onClick={() => setCountResult(null)} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {countResult.from_date || countResult.to_date ? (
              <p className="text-xs text-gray-500 mb-3">
                Khoảng thời gian: {countResult.from_date ?? '...'} — {countResult.to_date ?? 'nay'}
              </p>
            ) : (
              <p className="text-xs text-gray-500 mb-3">Tất cả hóa đơn (không lọc ngày)</p>
            )}

            <div className="space-y-3">
              {/* DB counts */}
              <div className="bg-blue-50 rounded-xl p-3">
                <p className="text-xs font-semibold text-blue-700 mb-2">📦 Trong database</p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div><p className="text-lg font-bold text-blue-800">{countResult.db_output.toLocaleString('vi-VN')}</p><p className="text-xs text-blue-600">📤 Bán ra</p></div>
                  <div><p className="text-lg font-bold text-blue-800">{countResult.db_input.toLocaleString('vi-VN')}</p><p className="text-xs text-blue-600">📥 Mua vào</p></div>
                  <div><p className="text-lg font-bold text-blue-900">{countResult.db_total.toLocaleString('vi-VN')}</p><p className="text-xs text-blue-700 font-medium">Tổng</p></div>
                </div>
              </div>

              {/* Last run counts */}
              {countResult.last_run_total !== null ? (
                <div className={`rounded-xl p-3 ${countResult.db_total < (countResult.last_run_total ?? 0) ? 'bg-red-50' : 'bg-green-50'}`}>
                  <p className="text-xs font-semibold mb-2" style={{ color: countResult.db_total < (countResult.last_run_total ?? 0) ? '#b91c1c' : '#15803d' }}>
                    🤖 Lần đồng bộ cuối {countResult.last_run_at ? `(${new Date(countResult.last_run_at).toLocaleDateString('vi-VN')})` : ''}
                  </p>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div><p className="text-lg font-bold">{(countResult.last_run_output ?? 0).toLocaleString('vi-VN')}</p><p className="text-xs">📤 Bán ra</p></div>
                    <div><p className="text-lg font-bold">{(countResult.last_run_input ?? 0).toLocaleString('vi-VN')}</p><p className="text-xs">📥 Mua vào</p></div>
                    <div><p className="text-lg font-bold">{countResult.last_run_total.toLocaleString('vi-VN')}</p><p className="text-xs font-medium">Tổng</p></div>
                  </div>
                  {countResult.db_total < (countResult.last_run_total ?? 0) && (
                    <p className="mt-2 text-xs text-red-700 font-medium">
                      ⚠️ DB thiếu {((countResult.last_run_total ?? 0) - countResult.db_total).toLocaleString('vi-VN')} hóa đơn so với lần đồng bộ cuối
                    </p>
                  )}
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-sm text-gray-500">Chưa có lịch sử đồng bộ thành công</p>
                </div>
              )}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setCountResult(null)}
                className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-medium"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
