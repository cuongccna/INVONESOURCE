'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import BackButton from '../../../../components/BackButton';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  direction: string;
  status: string;
  counterparty_name: string;
  counterparty_tax_code: string;
  subtotal_amount: string;
  vat_amount: string;
  total_amount: string;
  vat_rate: string;
  gdt_validated: boolean;
}

interface Pagination {
  page: number; pageSize: number; total: number; totalPages: number;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */
import { formatVNDFull } from '../../../../utils/formatCurrency';

const vnd = (n: string | number) => formatVNDFull(n);

const STATUS_LABELS: Record<string, string> = {
  valid: 'Hợp lệ', cancelled: 'Hủy', replaced: 'Thay thế', adjusted: 'Điều chỉnh',
};
const STATUS_COLOR: Record<string, string> = {
  valid: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-700',
  replaced: 'bg-yellow-100 text-yellow-700',
  adjusted: 'bg-blue-100 text-blue-700',
};

const now = new Date();

/* ─── Main Page ───────────────────────────────────────────────────────────── */
export default function InvoicesReportPage() {
  const toast = useToast();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 30, total: 0, totalPages: 1 });
  const [downloading, setDownloading] = useState<'pl011' | 'pl012' | null>(null);

  // Filters
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = {
        page: p, pageSize: 30,
        month, year,
      };
      if (direction) params.direction = direction;
      if (status) params.status = status;
      const res = await apiClient.get<{ data: Invoice[]; meta: Pagination }>('/invoices', { params });
      setInvoices(res.data.data);
      if (res.data.meta) setPagination(res.data.meta);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [month, year, direction, status, page]);

  useEffect(() => { void load(1); setPage(1); }, [month, year, direction, status]);

  const downloadExcel = async (type: 'pl011' | 'pl012') => {
    setDownloading(type);
    try {
      const res = await apiClient.get(`/reports/${type}?month=${month}&year=${year}`, { responseType: 'blob' });
      const url = URL.createObjectURL(
        new Blob([res.data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type.toUpperCase()}_T${String(month).padStart(2, '0')}${year}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải Excel. Vui lòng thử lại.');
    } finally {
      setDownloading(null);
    }
  };

  const YEARS = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <BackButton fallbackHref="/reports" className="mb-4" />
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Báo Cáo Hóa Đơn</h1>
          <p className="text-sm text-gray-500 mt-0.5">{pagination.total} dòng</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void downloadExcel('pl011')}
            disabled={downloading !== null}
            className="text-xs bg-green-600 text-white px-3 py-2 rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {downloading === 'pl011' ? '...' : '↓ PL01-1'}
          </button>
          <button
            onClick={() => void downloadExcel('pl012')}
            disabled={downloading !== null}
            className="text-xs bg-teal-600 text-white px-3 py-2 rounded-lg font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {downloading === 'pl012' ? '...' : '↓ PL01-2'}
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none"
        >
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <option key={m} value={m}>Tháng {m}</option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none"
        >
          {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none"
        >
          <option value="">Tất cả</option>
          <option value="output">Bán ra</option>
          <option value="input">Mua vào</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white focus:outline-none"
        >
          <option value="">Mọi trạng thái</option>
          <option value="valid">Hợp lệ</option>
          <option value="cancelled">Hủy</option>
          <option value="replaced">Thay thế</option>
          <option value="adjusted">Điều chỉnh</option>
        </select>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-3xl mb-2">📭</p>
          <p>Không tìm thấy hóa đơn nào</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="text-left px-3 py-2.5">Số HĐ</th>
                <th className="text-left px-3 py-2.5">Ngày</th>
                <th className="text-left px-3 py-2.5">Đối tác</th>
                <th className="text-right px-3 py-2.5">Tiền hàng</th>
                <th className="text-right px-3 py-2.5">VAT</th>
                <th className="text-center px-3 py-2.5">TT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50/50">
                  <td className="px-3 py-2.5">
                    <p className="font-mono text-xs text-gray-700">{inv.invoice_number}</p>
                    <p className="text-xs text-gray-400">{inv.direction === 'output' ? '↑ Bán' : '↓ Mua'}</p>
                  </td>
                  <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                    {new Date(inv.invoice_date).toLocaleDateString('vi-VN')}
                  </td>
                  <td className="px-3 py-2.5 max-w-[150px]">
                    <p className="truncate font-medium text-gray-800">{inv.counterparty_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{inv.counterparty_tax_code}</p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                    {vnd(inv.subtotal_amount)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                    {vnd(inv.vat_amount)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLOR[inv.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABELS[inv.status] ?? inv.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => { setPage(page - 1); void load(page - 1); }}
            disabled={page <= 1}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40"
          >
            ← Trước
          </button>
          <span className="text-sm text-gray-500">
            Trang {page} / {pagination.totalPages}
          </span>
          <button
            onClick={() => { setPage(page + 1); void load(page + 1); }}
            disabled={page >= pagination.totalPages}
            className="px-4 py-2 text-sm border border-gray-200 rounded-lg disabled:opacity-40"
          >
            Sau →
          </button>
        </div>
      )}
    </div>
  );
}
