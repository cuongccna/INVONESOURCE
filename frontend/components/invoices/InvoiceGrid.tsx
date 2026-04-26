'use client';

import React, { useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useRouter } from 'next/navigation';
import InvoiceEditPanel from './InvoiceEditPanel';
import { useToast } from '../ToastProvider';

export interface GridInvoice {
  id: string;
  invoice_number: string;
  serial_number: string;
  invoice_date: string;
  direction: 'output' | 'input';
  status: string;
  seller_name: string;
  seller_tax_code: string;
  buyer_name: string;
  buyer_tax_code: string;
  subtotal: string | null;
  total_amount: string;
  vat_amount: string;
  vat_rate: number;
  gdt_validated: boolean;
  provider: string;
  invoice_group: number | null;
  serial_has_cqt: boolean | null;
  has_line_items: boolean | null;
  payment_method: string | null;
  customer_code: string | null;
  item_code: string | null;
  notes: string | null;
  tc_hdon: number | null;
  khhd_cl_quan: string | null;
  so_hd_cl_quan: string | null;
  non_deductible: boolean | null;
}

export interface GridMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary?: {
    count: number;
    subtotal: number;
    vat: number;
    by_status?: Record<string, { count: number; subtotal: number; vat: number }>;
  };
}

interface Props {
  invoices: GridInvoice[];
  meta: GridMeta;
  loading: boolean;
  direction: 'output' | 'input' | '';
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onDelete: (id: string) => void;
  onPermanentIgnore: (id: string) => void;
  onToggleNonDeductible?: (id: string, value: boolean) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onExcelExport?: () => void;
  onRefresh: () => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  valid:             { label: 'Hợp lệ',       color: 'bg-green-100 text-green-700' },
  cancelled:         { label: 'Đã hủy',       color: 'bg-red-100 text-red-700' },
  replaced:          { label: 'Thay thế',     color: 'bg-yellow-100 text-yellow-700' },
  replaced_original: { label: 'Bị thay thế',  color: 'bg-orange-100 text-orange-700' },
  adjusted:          { label: 'Điều chỉnh',   color: 'bg-blue-100 text-blue-700' },
  adjusted_original: { label: 'Bị điều chỉnh', color: 'bg-purple-100 text-purple-700' },
};

const PAGE_SIZES = [15, 30, 50, 100];

function rowBg(inv: GridInvoice): string {
  if (inv.status === 'cancelled' || inv.status === 'invalid') return 'bg-red-50/60';
  if (inv.status === 'replaced_original') return 'bg-red-50/60';
  if (inv.status === 'replaced')  return 'bg-yellow-50/50';
  if (inv.status === 'adjusted')  return 'bg-blue-50/50';
  if (!inv.payment_method && Number(inv.total_amount) >= 5_000_000 && inv.direction === 'input') return 'bg-amber-50/40';
  return '';
}

const STATUS_LEFT_BORDER: Record<string, string> = {
  cancelled:         'border-l-2 border-l-red-400',
  invalid:           'border-l-2 border-l-red-400',
  replaced_original: 'border-l-2 border-l-red-400',
  replaced:          'border-l-2 border-l-yellow-400',
  adjusted:          'border-l-2 border-l-blue-400',
};

function fmtVND(n: string | number | null | undefined): string {
  if (n == null) return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('vi-VN');
}

export default function InvoiceGrid({
  invoices, meta, loading, direction,
  selectedIds, onSelectionChange,
  onDelete, onPermanentIgnore, onToggleNonDeductible,
  onPageChange, onPageSizeChange,
  onExcelExport, onRefresh,
}: Props) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLTableCellElement | null>(null);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenuId(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allPageSelected = invoices.length > 0 && invoices.every(inv => selectedIds.includes(inv.id));
  const someSelected    = selectedIds.length > 0;

  const toggleAll = () => {
    if (allPageSelected) {
      onSelectionChange(selectedIds.filter(id => !invoices.find(inv => inv.id === id)));
    } else {
      const newIds = new Set(selectedIds);
      invoices.forEach(inv => newIds.add(inv.id));
      onSelectionChange(Array.from(newIds));
    }
  };

  const toggleOne = (id: string) => {
    if (selectedIds.includes(id)) onSelectionChange(selectedIds.filter(x => x !== id));
    else onSelectionChange([...selectedIds, id]);
  };

  const handleRowClick = (inv: GridInvoice) => {
    setOpenMenuId(null);
    setExpandedId(expandedId === inv.id ? null : inv.id);
  };

  const sum = meta.summary;
  const partyLabel = direction === 'output' ? 'Người mua' : direction === 'input' ? 'Người bán' : 'Đối tác';

  return (
    <div className="space-y-2">
      {/* ── Summary Bar ── */}
      {sum && (() => {
        const bs = sum.by_status ?? {};
        // tthai=1 → valid (normal invoice)
        const valid        = bs['valid']             ?? { count: 0, subtotal: 0, vat: 0 };
        // tthai=3 → cancelled (true cancellation)
        const cancelled    = bs['cancelled']         ?? { count: 0, subtotal: 0, vat: 0 };
        // tthai=5 → replaced = the NEW replacement invoice (valid for VAT)
        const replaced     = bs['replaced']          ?? { count: 0, subtotal: 0, vat: 0 };
        // tthai=4 → replaced_original = the OLD original that was superseded (excluded from VAT)
        const replacedOrig = bs['replaced_original'] ?? { count: 0, subtotal: 0, vat: 0 };
        // tthai=6 → adjusted = adjustment invoice (valid for VAT, creates a delta)
        const adjusted     = bs['adjusted']          ?? { count: 0, subtotal: 0, vat: 0 };
        const invalid      = bs['invalid']           ?? { count: 0, subtotal: 0, vat: 0 };

        // Excluded from VAT: cancelled + replaced_original (old superseded) + invalid
        // NOTE: replaced (new replacement, tthai=5) and adjusted (tthai=6) ARE valid for VAT
        const notValidCount = cancelled.count + replacedOrig.count + invalid.count;
        const hasExtraInfo  = replaced.count > 0 || adjusted.count > 0;

        // VAT-valid total: valid + replaced (new replacement) + adjusted
        const vatValidSubtotal = valid.subtotal + replaced.subtotal + adjusted.subtotal;
        const vatValidVat      = valid.vat      + replaced.vat      + adjusted.vat;
        const vatValidCount    = valid.count    + replaced.count    + adjusted.count;

        return (
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 text-sm shadow-sm space-y-2">
            {/* Dòng 1: Tổng + Hợp lệ (= valid + replaced + adjusted đều tính VAT) */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3 flex-wrap gap-y-1">
                <span className="text-gray-500">Tổng: <strong className="text-gray-900">{sum.count.toLocaleString('vi-VN')}</strong> HĐ</span>
                <span className="text-green-700 font-semibold">
                  Hợp lệ: <strong>{vatValidCount.toLocaleString('vi-VN')}</strong> HĐ
                  {vatValidSubtotal > 0 && (
                    <> &mdash; <span className="font-normal">{fmtVND(vatValidSubtotal)}đ</span> | VAT: <span className="font-normal">{fmtVND(vatValidVat)}đ</span></>
                  )}
                </span>
              </div>
              {onExcelExport && (
                <button onClick={onExcelExport}
                  className="text-xs border border-gray-300 rounded-lg px-3 py-1.5 text-gray-600 hover:bg-gray-100 flex items-center gap-1 shrink-0">
                  📊 Xuất Excel
                </button>
              )}
            </div>
            {/* Dòng 2: Breakdown — hiển thị khi có hóa đơn đặc biệt hoặc không hợp lệ */}
            {(notValidCount > 0 || hasExtraInfo) && (
              <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs border-t border-gray-100 pt-2">
                {/* Không hợp lệ — loại khỏi khấu trừ VAT */}
                {cancelled.count > 0 && (
                  <span className="flex items-center gap-1 text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                    ⛔ Hủy: <strong>{cancelled.count}</strong> HĐ &middot; {fmtVND(cancelled.subtotal)}đ
                  </span>
                )}
                {replacedOrig.count > 0 && (
                  <span className="flex items-center gap-1 text-orange-700 bg-orange-50 px-2 py-0.5 rounded-full">
                    🔄 Bị thay thế: <strong>{replacedOrig.count}</strong> HĐ &middot; {fmtVND(replacedOrig.subtotal)}đ
                  </span>
                )}
                {invalid.count > 0 && (
                  <span className="flex items-center gap-1 text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
                    ⚠ Không hợp lệ: <strong>{invalid.count}</strong> HĐ
                  </span>
                )}
                {/* Hợp lệ nhưng là loại đặc biệt — vẫn tính VAT */}
                {replaced.count > 0 && (
                  <span className="flex items-center gap-1 text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full">
                    ↺ Thay thế: <strong>{replaced.count}</strong> HĐ &middot; {fmtVND(replaced.subtotal)}đ
                  </span>
                )}
                {adjusted.count > 0 && (
                  <span className="flex items-center gap-1 text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                    ✏ Điều chỉnh: <strong>{adjusted.count}</strong> HĐ &middot; {fmtVND(adjusted.subtotal)}đ
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Bulk Action Bar ── */}
      {someSelected && (
        <BulkActionBar
          selectedIds={selectedIds}
          onClear={() => onSelectionChange([])}
          onRefresh={onRefresh}
        />
      )}

      {/* ── Table ── */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <p className="text-lg">Không có hóa đơn nào</p>
            <p className="text-sm mt-1">Thay đổi bộ lọc hoặc nhấn Đồng Bộ để tải về</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="w-10 px-3 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAll}
                    className="rounded border-gray-300 text-primary-600"
                  />
                </th>
                <th className="w-10 px-2 py-3 text-left text-xs font-semibold text-gray-500">STT</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 hidden md:table-cell">{partyLabel} MST</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 hidden lg:table-cell">Ký hiệu</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">Số HĐ</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 hidden sm:table-cell">Ngày lập</th>
                <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500">Tên {partyLabel}</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 hidden xl:table-cell">Tiền hàng</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500 hidden sm:table-cell">Tổng tiền</th>
                <th className="px-3 py-3 text-right text-xs font-semibold text-gray-500">Thuế VAT</th>
                {/* Status column hidden — status is conveyed by row color + left border */}
                <th className="w-10 px-2 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv, idx) => {
                const isSelected = selectedIds.includes(inv.id);
                const isExpanded = expandedId === inv.id;
                const bg = rowBg(inv);
                const leftBorder = STATUS_LEFT_BORDER[inv.status] ?? '';
                const statusInfo = STATUS_LABELS[inv.status] ?? { label: inv.status, color: 'bg-gray-100 text-gray-700' };
                const partyName    = direction === 'output' ? inv.buyer_name  : direction === 'input' ? inv.seller_name  : (inv.direction === 'output' ? inv.buyer_name : inv.seller_name);
                const partyTaxCode = direction === 'output' ? inv.buyer_tax_code : direction === 'input' ? inv.seller_tax_code : (inv.direction === 'output' ? inv.buyer_tax_code : inv.seller_tax_code);

                return (
                  <React.Fragment key={inv.id}>
                    <tr
                      className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50/30 transition-colors ${bg} ${leftBorder} ${isSelected ? 'bg-primary-50/40' : ''} ${isExpanded ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="px-3 py-3" onClick={e => { e.stopPropagation(); toggleOne(inv.id); }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(inv.id)}
                          className="rounded border-gray-300 text-primary-600"
                        />
                      </td>
                      <td className="px-2 py-3 text-gray-400 text-xs" onClick={() => handleRowClick(inv)}>
                        {(meta.page - 1) * meta.pageSize + idx + 1}
                      </td>
                      <td className="px-3 py-3 hidden md:table-cell" onClick={() => handleRowClick(inv)}>
                        <span className="text-xs font-mono text-gray-500">{partyTaxCode || '—'}</span>
                      </td>
                      <td className="px-3 py-3 hidden lg:table-cell" onClick={() => handleRowClick(inv)}>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs text-gray-500 font-mono">{inv.serial_number}</span>
                          {inv.invoice_group && inv.invoice_group !== 5 && (
                            <span className="text-xs bg-orange-100 text-orange-700 px-1 py-0 rounded w-fit">
                              Nhóm {inv.invoice_group}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3" onClick={() => handleRowClick(inv)}>
                        <div>
                          <span className="font-medium text-gray-900">{inv.invoice_number}</span>
                          {inv.has_line_items === false && (
                            <span className="ml-1 text-xs bg-gray-100 text-gray-500 px-1 rounded">Thiếu CT</span>
                          )}
                          {inv.status === 'cancelled' && (
                            <span className="ml-1 text-xs bg-red-100 text-red-600 px-1 rounded" title="Hóa đơn đã bị hủy">⛔ Hủy</span>
                          )}
                          {inv.status === 'replaced' && (
                            <span className="ml-1 text-xs bg-yellow-100 text-yellow-700 px-1 rounded" title="Hóa đơn thay thế cho hóa đơn khác (tthai=5)">↺ Thay thế</span>
                          )}
                          {inv.status === 'replaced_original' && (
                            <span className="ml-1 text-xs bg-orange-100 text-orange-700 px-1 rounded" title="Hóa đơn gốc đã bị thay thế bởi hóa đơn khác (tthai=4)">🔄 Bị thay thế</span>
                          )}
                          {inv.status === 'adjusted' && (
                            <span className="ml-1 text-xs bg-blue-100 text-blue-700 px-1 rounded" title="Hóa đơn điều chỉnh cho hóa đơn khác">✏ Điều chỉnh</span>
                          )}
                          {(inv.tc_hdon === 1 || inv.tc_hdon === 2) && inv.so_hd_cl_quan && (
                            <span className="ml-1 text-xs bg-amber-100 text-amber-700 px-1 rounded" title={`${inv.tc_hdon === 1 ? 'Thay thế' : 'Điều chỉnh'} cho HĐ ${inv.khhd_cl_quan ?? ''}${inv.so_hd_cl_quan}`}>
                              {inv.tc_hdon === 1 ? '↺' : '✏'} HĐ gốc: {inv.so_hd_cl_quan}
                            </span>
                          )}
                          {inv.non_deductible && (
                            <span className="ml-1 text-xs bg-orange-100 text-orange-700 px-1 rounded" title="Không đủ điều kiện khấu trừ thuế GTGT">⊘ Không KT</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-gray-500 text-xs hidden sm:table-cell" onClick={() => handleRowClick(inv)}>
                        {format(new Date(inv.invoice_date), 'dd/MM/yyyy', { locale: vi })}
                      </td>
                      <td className="px-3 py-3 max-w-[180px]" onClick={() => handleRowClick(inv)}>
                        <p className="text-sm text-gray-800 truncate" title={partyName}>{partyName || '—'}</p>
                      </td>
                      <td className="px-3 py-3 text-right text-gray-700 tabular-nums text-xs hidden xl:table-cell" onClick={() => handleRowClick(inv)}>
                        {fmtVND(inv.subtotal)}
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-gray-900 tabular-nums text-xs hidden sm:table-cell" onClick={() => handleRowClick(inv)}>
                        {fmtVND(inv.total_amount)}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-700 tabular-nums text-xs" onClick={() => handleRowClick(inv)}>
                        {fmtVND(inv.vat_amount)}
                      </td>
                      {/* Status badge cell hidden — status conveyed by row color + left border */}
                      <td className="px-2 py-3 relative" ref={openMenuId === inv.id ? menuRef : undefined}>
                        <button
                          onClick={e => { e.stopPropagation(); setOpenMenuId(openMenuId === inv.id ? null : inv.id); }}
                          className="p-1 rounded-lg text-gray-400 hover:bg-gray-100"
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <circle cx="10" cy="4" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="10" cy="16" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === inv.id && (
                          <div className="absolute right-0 top-8 bg-white rounded-xl shadow-lg border border-gray-100 z-30 py-1 min-w-[160px]">
                            <button onClick={e => { e.stopPropagation(); router.push(`/invoices/${inv.id}`); }} className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">Xem chi tiết</button>
                            {inv.direction === 'input' && onToggleNonDeductible && (
                              <button
                                onClick={e => { e.stopPropagation(); setOpenMenuId(null); onToggleNonDeductible(inv.id, !inv.non_deductible); }}
                                className="w-full text-left px-4 py-2 text-sm text-orange-600 hover:bg-orange-50"
                              >
                                {inv.non_deductible ? '✓ Đưa lại vào khấu trừ' : '⊘ Loại khỏi khấu trừ [25]'}
                              </button>
                            )}
                            <button onClick={e => { e.stopPropagation(); setOpenMenuId(null); onDelete(inv.id); }} className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50">Ẩn hóa đơn</button>
                            <button onClick={e => { e.stopPropagation(); setOpenMenuId(null); onPermanentIgnore(inv.id); }} className="w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50">Bỏ qua vĩnh viễn</button>
                          </div>
                        )}
                      </td>
                    </tr>

                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        {/* Page size */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">Hiển thị:</span>
          {PAGE_SIZES.map(size => (
            <button
              key={size}
              onClick={() => onPageSizeChange(size)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${meta.pageSize === size ? 'bg-primary-600 text-white' : 'border border-gray-300 text-gray-600 hover:border-primary-300'}`}
            >
              {size}
            </button>
          ))}
          <span className="text-xs text-gray-400 ml-1">/ trang</span>
        </div>
        {/* Page nav */}
        {meta.totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(Math.max(1, meta.page - 1))}
              disabled={meta.page <= 1}
              className="px-2.5 py-1 rounded border border-gray-300 text-xs text-gray-600 disabled:opacity-40"
            >
              ‹
            </button>
            {Array.from({ length: Math.min(meta.totalPages, 5) }, (_, i) => {
              const p = meta.totalPages <= 5 ? i + 1 : Math.max(1, meta.page - 2) + i;
              if (p > meta.totalPages) return null;
              return (
                <button
                  key={p}
                  onClick={() => onPageChange(p)}
                  className={`w-8 h-7 rounded text-xs font-medium ${p === meta.page ? 'bg-primary-600 text-white' : 'border border-gray-300 text-gray-600 hover:border-primary-300'}`}
                >
                  {p}
                </button>
              );
            })}
            <button
              onClick={() => onPageChange(Math.min(meta.totalPages, meta.page + 1))}
              disabled={meta.page >= meta.totalPages}
              className="px-2.5 py-1 rounded border border-gray-300 text-xs text-gray-600 disabled:opacity-40"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bulk Action Bar (shown when selectedIds.length >= 2) ─────────────────────
import { BulkItemCodeModal, BulkCustomerCodeModal, BulkPaymentModal } from './BulkActionModals';

function BulkActionBar({
  selectedIds,
  onClear,
  onRefresh,
}: {
  selectedIds: string[];
  onClear: () => void;
  onRefresh: () => void;
}) {
  const [modal, setModal] = useState<'item' | 'customer' | 'payment' | null>(null);
  const n = selectedIds.length;
  const toast = useToast();

  return (
    <>
      <div className="flex items-center gap-2 bg-primary-50 border border-primary-200 rounded-xl px-4 py-2.5 flex-wrap">
        <span className="text-sm font-medium text-primary-700">Đã chọn {n} hóa đơn —</span>
        <button onClick={() => setModal('item')}     className="text-xs border border-primary-300 bg-white rounded-lg px-3 py-1.5 text-primary-700 hover:bg-primary-50">Gán mã hàng</button>
        <button onClick={() => setModal('customer')} className="text-xs border border-primary-300 bg-white rounded-lg px-3 py-1.5 text-primary-700 hover:bg-primary-50">Gán mã KH/NCC</button>
        <button onClick={() => setModal('payment')}  className="text-xs border border-primary-300 bg-white rounded-lg px-3 py-1.5 text-primary-700 hover:bg-primary-50">Khai báo TT</button>
        <button
          onClick={async () => {
            try {
              const { default: apiClient } = await import('../../lib/apiClient');
              const res = await apiClient.get(`/invoices/download-xml?ids=${selectedIds.join(',')}`, { responseType: 'blob' });
              const url = URL.createObjectURL(new Blob([res.data as BlobPart]));
              const a = document.createElement('a'); a.href = url;
              a.download = `HoaDon_XML_${new Date().toISOString().slice(0, 10)}.zip`;
              a.click(); URL.revokeObjectURL(url);
            } catch (err: unknown) {
              // Try to read error message from blob response
              const axiosErr = err as { response?: { data?: Blob; status?: number } };
              if (axiosErr.response?.data instanceof Blob) {
                try {
                  const text = await axiosErr.response.data.text();
                  const json = JSON.parse(text) as { error?: { code?: string; message?: string } };
                  const code = json?.error?.code ?? '';
                  const msg  = json?.error?.message ?? '';
                  if (code === 'NO_XML_BOT_SOURCE') {
                    toast.info('Hóa đơn từ GDT Bot không có file XML gốc lưu trữ. Vào Cài đặt → Kết nối Hóa Đơn và chạy "Backfill XML" để tải về từ GDT.');
                    return;
                  }
                  if (code === 'NO_XML' || msg.includes('No invoices with XML') || msg.includes('chưa có file XML')) {
                    toast.info('Các hóa đơn đã chọn chưa có dữ liệu XML. Chỉ HĐ đồng bộ từ GDT/Viettel mới có XML.');
                    return;
                  }
                } catch { /* ignore parse errors */ }
              }
              toast.error('Tải XML thất bại. Vui lòng thử lại sau.');
            }
          }}
          className="text-xs border border-primary-300 bg-white rounded-lg px-3 py-1.5 text-primary-700 hover:bg-primary-50"
        >📥 Tải XML</button>
        <button onClick={onClear} className="ml-auto text-xs text-gray-400 hover:text-gray-700">Hủy chọn</button>
      </div>

      {modal === 'item'     && <BulkItemCodeModal     ids={selectedIds} onClose={() => { setModal(null); onClear(); onRefresh(); }} />}
      {modal === 'customer' && <BulkCustomerCodeModal ids={selectedIds} onClose={() => { setModal(null); onClear(); onRefresh(); }} />}
      {modal === 'payment'  && <BulkPaymentModal      ids={selectedIds} onClose={() => { setModal(null); onClear(); onRefresh(); }} />}
    </>
  );
}
