'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { formatVND } from '../../../../utils/formatCurrency';

interface CashRiskInvoice {
  id: string;
  invoice_number: string;
  seller_name: string;
  seller_tax_code: string;
  total_amount: string;
  vat_amount: string;
  invoice_date: string;
  payment_method: string | null;
}

interface ScanResult {
  riskyCount: number;
  totalVatAtRisk: number;
  breakdown: { cash: number; unknown: number };
  invoices: CashRiskInvoice[];
}

const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: 'bank_transfer', label: 'Chuyển khoản' },
  { value: 'cheque',        label: 'Séc' },
  { value: 'card',          label: 'Thẻ' },
  { value: 'mixed',         label: 'Hỗn hợp' },
  { value: 'cash',          label: 'Tiền mặt (rủi ro)' },
];

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

export default function CashPaymentPage() {
  const now = new Date();
  const [month,      setMonth]      = useState(now.getMonth() + 1);
  const [year,       setYear]       = useState(now.getFullYear());
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const yearOptions = [now.getFullYear() - 1, now.getFullYear()];

  const scan = async () => {
    setLoading(true);
    try {
      const res = await apiClient.post<{ data: ScanResult }>(
        '/invoices/cash-risk-scan', { month, year },
      );
      setScanResult(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void scan(); }, [month, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const setMethod = async (id: string, method: string) => {
    setUpdatingId(id);
    try {
      await apiClient.patch(`/invoices/${id}/payment-method`, { method });
      const isRisk = method === 'cash';
      setScanResult(prev => {
        if (!prev) return prev;
        const updated = prev.invoices.map(inv =>
          inv.id === id ? { ...inv, payment_method: method } : inv,
        );
        if (isRisk) return { ...prev, invoices: updated };
        return {
          ...prev,
          invoices:   updated.filter(i => i.id !== id),
          riskyCount: Math.max(0, prev.riskyCount - 1),
          totalVatAtRisk: prev.totalVatAtRisk - parseFloat(
            prev.invoices.find(i => i.id === id)?.vat_amount ?? '0',
          ),
        };
      });
    } finally {
      setUpdatingId(null);
    }
  };

  const acknowledge = async (id: string) => {
    setUpdatingId(id);
    try {
      await apiClient.patch(`/invoices/${id}/cash-risk-acknowledge`, {});
      setScanResult(prev => {
        if (!prev) return prev;
        const vatAmt = parseFloat(prev.invoices.find(i => i.id === id)?.vat_amount ?? '0');
        return {
          ...prev,
          invoices:      prev.invoices.filter(i => i.id !== id),
          riskyCount:    Math.max(0, prev.riskyCount - 1),
          totalVatAtRisk: Math.max(0, prev.totalVatAtRisk - vatAmt),
        };
      });
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Hóa đơn đầu vào tiền mặt</h1>
          <p className="text-sm text-gray-500 mt-1">
            Phát hiện HĐ ≥ 5,000,000 VND thanh toán tiền mặt — không được khấu trừ VAT (Điều 26 NĐ181/2025)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => setMonth(Number(e.target.value))}
            className="border rounded px-2 py-1.5 text-sm">
            {MONTH_OPTIONS.map(m => <option key={m} value={m}>Tháng {m}</option>)}
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="border rounded px-2 py-1.5 text-sm">
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={scan} disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Đang quét...' : 'Quét lại'}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {scanResult && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-xs text-red-600 font-medium">HĐ có rủi ro</p>
            <p className="text-3xl font-bold text-red-700 mt-1">{scanResult.riskyCount}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p className="text-xs text-amber-700 font-medium">VAT không được khấu trừ</p>
            <p className="text-xl font-bold text-amber-800 mt-1">{formatVND(scanResult.totalVatAtRisk)}</p>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium">Chưa biết PTTT</p>
            <p className="text-3xl font-bold text-gray-700 mt-1">{scanResult.breakdown.unknown}</p>
          </div>
        </div>
      )}

      {/* Invoice list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : !scanResult || scanResult.invoices.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg">Không có hóa đơn rủi ro</p>
          <p className="text-sm mt-1">
            Tất cả HĐ đầu vào đã xác nhận phương thức thanh toán không phải tiền mặt.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-500">{scanResult.invoices.length} hóa đơn cần xử lý</p>
          <div className="bg-white rounded-xl border border-gray-200 divide-y">
            {scanResult.invoices.map(inv => (
              <div key={inv.id} className="p-4 flex items-center gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-semibold text-gray-800">
                      {inv.invoice_number}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(inv.invoice_date).toLocaleDateString('vi-VN')}
                    </span>
                    {inv.payment_method === 'cash' ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                        Tiền mặt
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                        Chưa rõ PTTT
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-700 mt-0.5 truncate">
                    {inv.seller_name}
                    <span className="ml-2 font-mono text-xs text-gray-400">
                      ({inv.seller_tax_code})
                    </span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Tổng: <strong>{formatVND(parseFloat(inv.total_amount))}</strong>
                    {' · '}
                    VAT: <strong className="text-red-600">{formatVND(parseFloat(inv.vat_amount))}</strong>
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <select
                    disabled={updatingId === inv.id}
                    onChange={e => { if (e.target.value) void setMethod(inv.id, e.target.value); }}
                    defaultValue=""
                    className="border rounded px-2 py-1.5 text-xs disabled:opacity-50"
                  >
                    <option value="" disabled>Chọn PTTT</option>
                    {PAYMENT_METHODS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <button
                    disabled={updatingId === inv.id}
                    onClick={() => void acknowledge(inv.id)}
                    className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    Chấp nhận rủi ro
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
