'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import apiClient from '../../../lib/apiClient';
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
  source_provider: string;
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
  const toast = useToast();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 50, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<'output' | 'input' | ''>(
    initialDirection === 'output' || initialDirection === 'input' ? initialDirection : ''
  );
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, pageSize: 50 };
      if (direction) params.direction = direction;
      if (debouncedSearch) params.search = debouncedSearch;

      const res = await apiClient.get<PaginatedResponse>('/invoices', { params });
      setInvoices(res.data.data);
      setMeta(res.data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [direction, debouncedSearch]);

  useEffect(() => { void load(1); }, [load]);

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
          <p className="text-sm text-gray-500">{meta.total.toLocaleString('vi-VN')} hóa đơn</p>
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
              <div key={inv.id} className="bg-white rounded-xl shadow-sm p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">{inv.invoice_number}</p>
                    <p className="text-xs text-gray-400">{inv.serial_number} · {PROVIDER_LABELS[inv.source_provider] ?? inv.source_provider}</p>
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
    </div>
  );
}
