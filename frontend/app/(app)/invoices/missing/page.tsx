'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';

interface MissingAlert {
  id: string;
  company_id: string;
  seller_tax_code: string;
  seller_name: string | null;
  expected_invoice_number: string | null;
  detection_source: 'cross_company' | 'gdt_mismatch';
  status: 'open' | 'found' | 'not_applicable' | 'acknowledged';
  acknowledged_note: string | null;
  created_at: string;
}

const STRATEGY_BADGE: Record<string, string> = {
  cross_company:  'bg-purple-100 text-purple-700',
  gdt_mismatch:   'bg-amber-100 text-amber-700',
};
const STRATEGY_LABEL: Record<string, string> = {
  cross_company: 'Nội bộ tập đoàn',
  gdt_mismatch:  'Khớp sai vs GDT',
};
const STATUS_BADGE: Record<string, string> = {
  open:          'bg-red-100 text-red-700',
  found:         'bg-green-100 text-green-700',
  not_applicable: 'bg-gray-100 text-gray-600',
  acknowledged:  'bg-gray-100 text-gray-600',
};

export default function MissingInvoicesPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());
  const [rows,  setRows]  = useState<MissingAlert[]>([]);
  const [total, setTotal] = useState(0);
  const [page,  setPage]  = useState(1);
  const [loading,  setLoading]  = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ crossCompany: number; gdtMismatch: number } | null>(null);
  const PAGE_SIZE = 30;

  const load = async (p = page) => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: { data: MissingAlert[]; total: number } }>(
        `/invoices/missing?month=${month}&year=${year}&page=${p}&pageSize=${PAGE_SIZE}`
      );
      setRows(res.data.data.data ?? []);
      setTotal(res.data.data.total ?? 0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [month, year, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await apiClient.post<{ data: { crossCompany: number; gdtMismatch: number } }>(
        '/invoices/missing/scan', { month, year }
      );
      setScanResult(res.data.data);
      await load(1);
    } finally {
      setScanning(false);
    }
  };

  const updateStatus = async (id: string, status: 'found' | 'acknowledged') => {
    await apiClient.patch(`/invoices/missing/${id}`, { status });
    setRows(prev => prev.map(r => r.id === id ? { ...r, status } : r));
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hóa đơn đầu vào thiếu</h1>
          <p className="text-sm text-gray-500 mt-1">
            Phát hiện HĐ đầu vào chưa nhận — so sánh nội bộ tập đoàn và dữ liệu GDT
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => { setMonth(Number(e.target.value)); setPage(1); }}
            className="border rounded px-2 py-1.5 text-sm">
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={m}>Tháng {m}</option>
            ))}
          </select>
          <select value={year} onChange={e => { setYear(Number(e.target.value)); setPage(1); }}
            className="border rounded px-2 py-1.5 text-sm">
            {[now.getFullYear() - 1, now.getFullYear()].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button onClick={scan} disabled={scanning}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {scanning ? 'Đang rà soát...' : 'Rà soát'}
          </button>
        </div>
      </div>

      {scanResult && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
          Rà soát xong: <strong>{scanResult.crossCompany}</strong> cảnh báo nội bộ tập đoàn,{' '}
          <strong>{scanResult.gdtMismatch}</strong> không khớp GDT.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không có cảnh báo nào</p>
          <p className="text-sm mt-1">Nhấn "Rà soát" để kiểm tra kỳ tháng {month}/{year}.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">{total} cảnh báo</p>
          {rows.map(row => (
            <div key={row.id}
              className={`bg-white border border-gray-200 rounded-lg p-4 ${row.status !== 'open' ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_BADGE[row.status] ?? ''}`}>
                      {row.status === 'open' ? 'Chưa giải quyết' : row.status === 'found' ? 'Đã tìm được' : 'Bỏ qua'}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STRATEGY_BADGE[row.detection_source] ?? ''}`}>
                      {STRATEGY_LABEL[row.detection_source] ?? row.detection_source}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 mt-1">
                    {row.seller_name ?? row.seller_tax_code}
                    <span className="ml-2 font-mono text-xs text-gray-400">({row.seller_tax_code})</span>
                  </p>
                  {row.expected_invoice_number && (
                    <p className="text-xs text-gray-500">Số HĐ dự kiến: <span className="font-mono">{row.expected_invoice_number}</span></p>
                  )}
                </div>
                {row.status === 'open' && (
                  <div className="flex gap-1.5 shrink-0">
                    <button onClick={() => void updateStatus(row.id, 'found')}
                      className="px-2.5 py-1 text-xs font-medium bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100">
                      Đã tìm được
                    </button>
                    <button onClick={() => void updateStatus(row.id, 'acknowledged')}
                      className="px-2.5 py-1 text-xs font-medium border border-gray-200 rounded hover:bg-gray-50">
                      Bỏ qua
                    </button>
                  </div>
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
