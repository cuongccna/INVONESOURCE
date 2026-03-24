'use client';

import { useEffect, useState, useCallback } from 'react';
import apiClient from '../../../lib/apiClient';
import { useToast } from '../../../components/ToastProvider';

interface ReconciliationRow {
  period_month: number;
  period_year: number;
  output_vat: string;
  input_vat: string;
  payable_vat: string;
  generated_at: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; pageSize: number; totalPages: number };
}

const fmt = (n: string | number) =>
  Number(n).toLocaleString('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });

const monthLabel = (m: number, y: number) => `Tháng ${m}/${y}`;

export default function ReconciliationPage() {
  const toast = useToast();
  const [rows, setRows] = useState<ReconciliationRow[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 12, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);

  const load = useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const res = await apiClient.get<PaginatedResponse<ReconciliationRow>>(
        `/reconciliation?page=${page}&pageSize=12`
      );
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const calculate = async () => {
    const now = new Date();
    setCalculating(true);
    try {
      await apiClient.post('/reconciliation/calculate', {
        month: now.getMonth() + 1,
        year: now.getFullYear(),
      });
      toast.success('Đã tính đối soát kỳ hiện tại');
      await load();
    } catch {
      toast.error('Lỗi tính đối soát. Vui lòng thử lại.');
    } finally {
      setCalculating(false);
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Đối Soát Thuế GTGT</h1>
          <p className="text-sm text-gray-500 mt-1">Tổng hợp VAT đầu ra / đầu vào theo kỳ</p>
        </div>
        <button
          onClick={calculate}
          disabled={calculating}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {calculating ? 'Đang tính...' : '+ Tính Mới'}
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Chưa có dữ liệu đối soát</p>
          <p className="text-sm">Nhấn &quot;+ Tính Mới&quot; để tính kỳ hiện tại</p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {rows.map((row) => {
              const payable = Number(row.payable_vat);
              const isDebt = payable > 0;
              return (
                <div
                  key={`${row.period_year}-${row.period_month}`}
                  className="bg-white rounded-xl border border-gray-100 shadow-sm p-4"
                >
                  <div className="flex items-start justify-between mb-3">
                    <span className="font-semibold text-gray-800">
                      {monthLabel(row.period_month, row.period_year)}
                    </span>
                    <span
                      className={`text-sm font-bold ${isDebt ? 'text-red-600' : 'text-green-600'}`}
                    >
                      {isDebt ? '▲ Phải nộp' : '▼ Được khấu trừ'}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="bg-gray-50 rounded-lg p-2">
                      <div className="text-gray-500 text-xs mb-1">VAT đầu ra</div>
                      <div className="font-medium text-gray-800">{fmt(row.output_vat)}</div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-2">
                      <div className="text-gray-500 text-xs mb-1">VAT đầu vào</div>
                      <div className="font-medium text-gray-800">{fmt(row.input_vat)}</div>
                    </div>
                    <div className={`rounded-lg p-2 ${isDebt ? 'bg-red-50' : 'bg-green-50'}`}>
                      <div className="text-gray-500 text-xs mb-1">{isDebt ? 'Phải nộp' : 'Khấu trừ'}</div>
                      <div className={`font-bold ${isDebt ? 'text-red-700' : 'text-green-700'}`}>
                        {fmt(Math.abs(payable))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 text-xs text-gray-400 text-right">
                    Cập nhật: {new Date(row.generated_at).toLocaleDateString('vi-VN')}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {meta.totalPages > 1 && (
            <div className="flex justify-center gap-2 mt-6">
              {meta.page > 1 && (
                <button
                  onClick={() => void load(meta.page - 1)}
                  className="px-3 py-1 rounded-lg border border-gray-200 text-sm"
                >
                  ‹
                </button>
              )}
              <span className="px-3 py-1 text-sm text-gray-500">
                {meta.page} / {meta.totalPages}
              </span>
              {meta.page < meta.totalPages && (
                <button
                  onClick={() => void load(meta.page + 1)}
                  className="px-3 py-1 rounded-lg border border-gray-200 text-sm"
                >
                  ›
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
