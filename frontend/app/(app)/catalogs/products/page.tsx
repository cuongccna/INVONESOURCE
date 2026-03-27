'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';

interface Product {
  id: string;
  item_code: string | null;
  item_name: string;
  category_code: string | null;
  category_name: string | null;
  is_service: boolean;
  unit: string | null;
  avg_purchase_price: string | null;
  avg_sale_price: string | null;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

export default function ProductCatalogPage() {
  const { activeCompanyId } = useCompany();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [msg, setMsg] = useState('');

  const fetchProducts = () => {
    if (!activeCompanyId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (q) params.append('q', q);
    apiClient
      .get<PaginatedResponse<Product>>(`/catalogs/products?${params}`)
      .then((r) => {
        setProducts(r.data.data);
        setTotal(r.data.meta.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchProducts(); }, [activeCompanyId, page, q]);

  const rebuild = async () => {
    setRebuilding(true);
    setMsg('');
    try {
      await apiClient.post('/catalogs/rebuild', {});
      setMsg('Đã xây dựng lại danh mục.');
      fetchProducts();
    } catch {
      setMsg('Lỗi khi rebuild.');
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Danh Mục Hàng Hóa</h1>
          <p className="text-sm text-gray-500">{total} sản phẩm / dịch vụ</p>
        </div>
        <button
          onClick={rebuild}
          disabled={rebuilding}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg disabled:opacity-50"
        >
          {rebuilding ? 'Đang xây dựng...' : '🔄 Rebuild mã tự động'}
        </button>
      </div>

      {msg && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">{msg}</div>}

      <input
        type="text"
        placeholder="Tìm kiếm tên, mã, danh mục..."
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
                <th className="px-3 py-2 text-left">Mã HH</th>
                <th className="px-3 py-2 text-left">Tên hàng hóa</th>
                <th className="px-3 py-2 text-left">Danh mục</th>
                <th className="px-3 py-2 text-left">ĐVT</th>
                <th className="px-3 py-2 text-right">Giá mua TB</th>
                <th className="px-3 py-2 text-right">Giá bán TB</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-8 text-gray-400">Chưa có dữ liệu — bấm Rebuild để tạo mã</td></tr>
              ) : products.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-blue-700">{p.item_code ?? '—'}</td>
                  <td className="px-3 py-2 font-medium">{p.item_name}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{p.category_name ?? p.category_code ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500">{p.unit ?? '—'}</td>
                  <td className="px-3 py-2 text-right">{p.avg_purchase_price ? formatVND(Number(p.avg_purchase_price)) : '—'}</td>
                  <td className="px-3 py-2 text-right">{p.avg_sale_price ? formatVND(Number(p.avg_sale_price)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
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
