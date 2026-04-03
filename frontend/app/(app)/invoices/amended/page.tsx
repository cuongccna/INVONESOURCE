'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { formatVND } from '../../../../utils/formatCurrency';

interface AmendedInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_relation_type: 'replacement' | 'adjustment';
  related_invoice_number: string | null;
  cross_period_flag: boolean;
  routing_decision: string | null;
  supplemental_declaration_needed: boolean;
  seller_name: string;
  total_amount: string;
}

const RELATION_LABEL: Record<string, string> = {
  replacement: 'Thay thế',
  adjustment:  'Điều chỉnh',
};
const RELATION_BADGE: Record<string, string> = {
  replacement: 'bg-blue-100 text-blue-700',
  adjustment:  'bg-purple-100 text-purple-700',
};
const ROUTING_LABEL: Record<string, string> = {
  same_period:               'Cùng kỳ — kê khai bình thường',
  cross_period_replacement:  'Khác kỳ — kê khai bổ sung kỳ gốc',
  cross_period_adjustment:   'Khác kỳ — kê chênh lệch kỳ điều chỉnh',
  user_confirmed:            'Đã xác nhận',
};

export default function AmendedInvoicesPage() {
  const now  = new Date();
  const [month,    setMonth]    = useState(now.getMonth() + 1);
  const [year,     setYear]     = useState(now.getFullYear());
  const [rows,     setRows]     = useState<AmendedInvoice[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzed, setAnalyzed] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: { data: AmendedInvoice[] } }>(
        `/invoices/amendments?month=${month}&year=${year}`,
      );
      setRows(res.data.data.data ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [month, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await apiClient.post<{ data: { processed: number } }>(
        '/invoices/analyze-amendments', {},
      );
      setAnalyzed(res.data.data.processed);
      await load();
    } finally {
      setAnalyzing(false);
    }
  };

  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years  = [now.getFullYear() - 1, now.getFullYear()];

  const crossPeriodCount      = rows.filter(r => r.cross_period_flag).length;
  const needsSupplementalCount = rows.filter(r => r.supplemental_declaration_needed).length;

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hóa đơn điều chỉnh / thay thế</h1>
          <p className="text-sm text-gray-500 mt-1">
            Phân tích hướng xử lý kê khai cho HĐ thay thế và điều chỉnh (NĐ70/2025)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => setMonth(Number(e.target.value))}
            className="border rounded px-2 py-1.5 text-sm">
            {months.map(m => <option key={m} value={m}>Tháng {m}</option>)}
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="border rounded px-2 py-1.5 text-sm">
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => void analyze()} disabled={analyzing}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {analyzing ? 'Đang phân tích...' : 'Phân tích'}
          </button>
        </div>
      </div>

      {/* Analysis result banner */}
      {analyzed !== null && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
          Phân tích xong: <strong>{analyzed}</strong> hóa đơn đã được xác định hướng xử lý.
        </div>
      )}

      {/* Summary pills */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          <div className={`rounded-xl p-4 border ${
            crossPeriodCount > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'
          }`}>
            <p className="text-xs text-gray-500 font-medium">Khác kỳ khai báo</p>
            <p className={`text-3xl font-bold mt-1 ${
              crossPeriodCount > 0 ? 'text-amber-700' : 'text-green-700'
            }`}>{crossPeriodCount}</p>
          </div>
          <div className={`rounded-xl p-4 border ${
            needsSupplementalCount > 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'
          }`}>
            <p className="text-xs text-gray-500 font-medium">Cần nộp kê khai bổ sung</p>
            <p className={`text-3xl font-bold mt-1 ${
              needsSupplementalCount > 0 ? 'text-red-700' : 'text-green-700'
            }`}>{needsSupplementalCount}</p>
          </div>
        </div>
      )}

      {/* Invoice list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không có hóa đơn điều chỉnh/thay thế</p>
          <p className="text-sm mt-1">
            Nhấn &quot;Phân tích&quot; để tìm và phân loại HĐ trong kỳ tháng {month}/{year}.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">{rows.length} hóa đơn</p>
          <div className="bg-white rounded-xl border border-gray-200 divide-y">
            {rows.map(inv => (
              <div key={inv.id} className="p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        RELATION_BADGE[inv.invoice_relation_type] ?? 'bg-gray-100 text-gray-700'
                      }`}>
                        {RELATION_LABEL[inv.invoice_relation_type] ?? inv.invoice_relation_type}
                      </span>
                      {inv.cross_period_flag && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          Khác kỳ
                        </span>
                      )}
                      {inv.supplemental_declaration_needed && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                          ⚠ Cần kê khai bổ sung
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-sm font-semibold text-gray-800">
                        {inv.invoice_number}
                      </span>
                      <span className="text-xs text-gray-400">
                        {new Date(inv.invoice_date).toLocaleDateString('vi-VN')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 truncate">{inv.seller_name}</p>
                    {inv.related_invoice_number && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        HĐ gốc: <span className="font-mono">{inv.related_invoice_number}</span>
                      </p>
                    )}
                  </div>

                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-gray-800">
                      {formatVND(parseFloat(inv.total_amount))}
                    </p>
                    {inv.routing_decision && (
                      <p className="text-xs text-gray-500 mt-1 max-w-[200px] text-right">
                        {ROUTING_LABEL[inv.routing_decision] ?? inv.routing_decision}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
