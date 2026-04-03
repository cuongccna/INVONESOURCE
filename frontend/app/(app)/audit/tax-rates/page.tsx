'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';

interface TaxRateAnomaly {
  id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  seller_name: string;
  item_name: string | null;
  anomaly_type: string;
  expected_rate: number | null;
  actual_rate: number;
  rule_basis: string | null;
  is_acknowledged: boolean;
  acknowledged_at: string | null;
  created_at: string;
}

const TYPE_LABEL: Record<string, string> = {
  INCONSISTENT_RATE:              'Cùng mặt hàng nhiều mức VAT',
  POSSIBLE_WRONG_RATE_10_SHOULD_BE_8: 'Có thể sai: 10% → nên là 8%',
  POSSIBLE_WRONG_RATE_8_SHOULD_BE_10: 'Có thể sai: 8% → nên là 10%',
};
const TYPE_BADGE: Record<string, string> = {
  INCONSISTENT_RATE:              'bg-purple-100 text-purple-700',
  POSSIBLE_WRONG_RATE_10_SHOULD_BE_8: 'bg-amber-100 text-amber-700',
  POSSIBLE_WRONG_RATE_8_SHOULD_BE_10: 'bg-orange-100 text-orange-700',
};

export default function TaxRatesPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());
  const [rows,  setRows]  = useState<TaxRateAnomaly[]>([]);
  const [total, setTotal] = useState(0);
  const [page,  setPage]  = useState(1);
  const [loading,  setLoading]  = useState(true);
  const [scanning, setScanning] = useState(false);
  const PAGE_SIZE = 30;

  const load = async (p = page) => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: { data: TaxRateAnomaly[]; meta: { total: number } } }>(
        `/audit/tax-rates?month=${month}&year=${year}&page=${p}&pageSize=${PAGE_SIZE}`
      );
      setRows(res.data.data.data);
      setTotal(res.data.data.meta?.total ?? 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [month, year, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setScanning(true);
    try {
      await apiClient.post('/audit/tax-rates/scan', { month, year });
      await load(1);
    } finally {
      setScanning(false);
    }
  };

  const acknowledge = async (id: string) => {
    await apiClient.patch(`/audit/tax-rates/${id}/acknowledge`, {});
    setRows(prev => prev.map(r => r.id === id ? { ...r, is_acknowledged: true, acknowledged_at: new Date().toISOString() } : r));
  };

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years  = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kiểm tra thuế suất VAT</h1>
          <p className="text-sm text-gray-500 mt-1">
            Phát hiện áp dụng sai thuế suất theo NQ204/2025/QH15 (giảm 10% → 8%, tháng 7/2025 – 12/2026)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => { setMonth(Number(e.target.value)); setPage(1); }}
            className="border rounded px-2 py-1.5 text-sm">
            {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
          </select>
          <select value={year} onChange={e => { setYear(Number(e.target.value)); setPage(1); }}
            className="border rounded px-2 py-1.5 text-sm">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={scan} disabled={scanning}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {scanning ? 'Đang quét...' : 'Quét kỳ này'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không phát hiện bất thường thuế suất</p>
          <p className="text-sm mt-1">Nhấn "Quét kỳ này" để kiểm tra kỳ tháng {month}/{year}.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">{total} bất thường tìm thấy</p>
          {rows.map(row => (
            <div key={row.id}
              className={`bg-white border border-gray-200 rounded-lg p-4 ${row.is_acknowledged ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TYPE_BADGE[row.anomaly_type] ?? 'bg-gray-100 text-gray-700'}`}>
                      {TYPE_LABEL[row.anomaly_type] ?? row.anomaly_type}
                    </span>
                    <span className="font-mono text-sm text-gray-600">{row.invoice_number}</span>
                    <span className="text-xs text-gray-400">{new Date(row.invoice_date).toLocaleDateString('vi-VN')}</span>
                  </div>
                  <p className="text-sm text-gray-700 mt-1 truncate">{row.seller_name}</p>
                  {row.item_name && <p className="text-xs text-gray-500 truncate">Mặt hàng: {row.item_name}</p>}
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-600">
                    <span>Thực tế: <strong>{row.actual_rate}%</strong></span>
                    {row.expected_rate !== null && <span>Kỳ vọng: <strong>{row.expected_rate}%</strong></span>}
                    {row.rule_basis && <span className="text-gray-400">— {row.rule_basis}</span>}
                  </div>
                </div>
                {!row.is_acknowledged && (
                  <button onClick={() => acknowledge(row.id)}
                    className="shrink-0 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded hover:bg-gray-50">
                    Đã xem xét
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex justify-center gap-2">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 text-sm border rounded disabled:opacity-40">← Trước</button>
          <span className="px-3 py-1.5 text-sm text-gray-500">{page} / {Math.ceil(total / PAGE_SIZE)}</span>
          <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 text-sm border rounded disabled:opacity-40">Sau →</button>
        </div>
      )}
    </div>
  );
}
