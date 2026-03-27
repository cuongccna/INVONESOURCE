'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';

interface Supplier {
  id: string;
  supplier_code: string;
  tax_code: string;
  name: string;
  total_spend_12m: string | null;
  invoice_count_12m: string | null;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

export default function SupplierCatalogPage() {
  const { activeCompanyId } = useCompany();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!activeCompanyId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q) params.append('q', q);
    apiClient
      .get<PaginatedResponse<Supplier>>(`/catalogs/suppliers?${params}`)
      .then((r) => {
        setSuppliers(r.data.data);
        setTotal(r.data.meta.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [activeCompanyId, page, q]);

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Danh Mục Nhà Cung Cấp</h1>
        <p className="text-sm text-gray-500">{total} nhà cung cấp</p>
      </div>

      <input
        type="text"
        placeholder="Tìm kiếm tên, mã NCC, mã số thuế..."
        value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1); }}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Mã NCC</th>
                <th className="px-3 py-2 text-left">Tên nhà cung cấp</th>
                <th className="px-3 py-2 text-left">MST</th>
                <th className="px-3 py-2 text-right">Chi tiêu 12T</th>
                <th className="px-3 py-2 text-right">Số HĐ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {suppliers.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-8 text-gray-400">Chưa có dữ liệu — bấm Rebuild danh mục từ trang Hàng hóa</td></tr>
              ) : suppliers.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-blue-700">{s.supplier_code}</td>
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2 text-gray-500 font-mono text-xs">{s.tax_code}</td>
                  <td className="px-3 py-2 text-right">{s.total_spend_12m ? formatVND(Number(s.total_spend_12m)) : '—'}</td>
                  <td className="px-3 py-2 text-right">{s.invoice_count_12m ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 25 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>Trang {page} / {Math.ceil(total / 25)}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 border rounded disabled:opacity-40">‹</button>
            <button disabled={page >= Math.ceil(total / 25)} onClick={() => setPage(p => p + 1)} className="px-3 py-1 border rounded disabled:opacity-40">›</button>
          </div>
        </div>
      )}
    </div>
  );
}
