'use client';
import { formatVND } from '../../../../utils/formatCurrency';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';

interface AgingRow {
  buyer_tax_code: string;
  buyer_name: string;
  invoice_count: string;
  total_amount: string;
  current_amount: string;
  overdue_1_30: string;
  overdue_31_60: string;
  overdue_61_90: string;
  overdue_90plus: string;
  last_invoice_date: string;
}

const mVnd = (n: string | number) => {
  const val = Number(n);
  if (val === 0) return '—';
  return formatVND(val);
};

const redShade = (n: number) => {
  if (n <= 0) return 'text-gray-300';
  if (n < 10_000_000) return 'text-yellow-600';
  if (n < 50_000_000) return 'text-orange-600 font-semibold';
  return 'text-red-600 font-bold';
};

export default function AgingPage() {
  const [rows, setRows] = useState<AgingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reminderSent, setReminderSent] = useState<Set<string>>(new Set());

  const loadData = () => {
    setLoading(true);
    apiClient.get<{ data: AgingRow[] }>('/crm/aging')
      .then((r: { data: { data: AgingRow[] } }) => setRows(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const totalCurrent = rows.reduce((s, r) => s + Number(r.current_amount), 0);
  const total130 = rows.reduce((s, r) => s + Number(r.overdue_1_30), 0);
  const total3160 = rows.reduce((s, r) => s + Number(r.overdue_31_60), 0);
  const totalOver60 = rows.reduce((s, r) => s + Number(r.overdue_61_90) + Number(r.overdue_90plus), 0);
  const totalOverdue = total130 + total3160 + totalOver60;

  const sendReminder = async (taxCode: string) => {
    try {
      await apiClient.post(`/crm/aging/send-reminder/${taxCode}`, {});
      setReminderSent((prev) => new Set(prev).add(taxCode));
    } catch { /* silent */ }
  };

  const summaryCards = [
    { label: 'Chưa đến hạn', amount: totalCurrent, color: 'border-gray-200 bg-gray-50', textColor: 'text-gray-700' },
    { label: 'Trễ 1-30 ngày', amount: total130, color: 'border-yellow-200 bg-yellow-50', textColor: 'text-yellow-700' },
    { label: 'Trễ 31-60 ngày', amount: total3160, color: 'border-orange-200 bg-orange-50', textColor: 'text-orange-700' },
    { label: 'Trễ >60 ngày', amount: totalOver60, color: 'border-red-200 bg-red-50', textColor: 'text-red-700' },
  ];

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Công Nợ Phải Thu</h1>
        {rows.length > 0 && (
          <p className="text-sm text-gray-500 mt-0.5">
            {rows.length} khách · Tổng quá hạn:{' '}
            <span className="font-semibold text-red-600">{mVnd(totalOverdue)}</span>
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-red-500" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">✅</p>
          <p>Không có công nợ tồn đọng</p>
          <p className="text-xs mt-2 text-gray-300">Đánh dấu hóa đơn đã thanh toán để theo dõi chính xác hơn</p>
        </div>
      ) : (
        <>
          {/* Payment tracking banner */}
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-start gap-2">
            <span className="text-blue-500 text-base mt-0.5">💡</span>
            <p className="text-xs text-blue-700">
              Đánh dấu hóa đơn đã thanh toán để báo cáo chính xác hơn.{' '}
              <Link href="/invoices" className="underline font-medium">Xem hóa đơn →</Link>
            </p>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {summaryCards.map((card) => (
              <div key={card.label} className={`rounded-xl border p-3 ${card.color}`}>
                <p className="text-xs text-gray-500 mb-1">{card.label}</p>
                <p className={`text-base font-bold ${card.textColor}`}>{mVnd(card.amount)}</p>
              </div>
            ))}
          </div>

          {/* Total bar */}
          <div className="bg-white rounded-xl shadow-sm p-3 flex items-center justify-between">
            <span className="text-sm text-gray-600">Tổng công nợ chưa thu</span>
            <span className="text-base font-bold text-gray-900">
              {mVnd(totalCurrent + totalOverdue)}{' '}
              <span className="text-xs text-gray-400">từ {rows.length} khách hàng</span>
            </span>
          </div>

          {/* Customer aging table */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50 text-left">
                    <th className="px-3 py-2.5 font-medium text-gray-500">Khách hàng</th>
                    <th className="px-3 py-2.5 font-medium text-gray-500 text-right">Hiện tại</th>
                    <th className="px-3 py-2.5 font-medium text-gray-500 text-right">1-30 ngày</th>
                    <th className="px-3 py-2.5 font-medium text-gray-500 text-right">31-60</th>
                    <th className="px-3 py-2.5 font-medium text-gray-500 text-right">{'>'}60</th>
                    <th className="px-3 py-2.5 font-medium text-gray-500 text-right">Hành động</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.map((r) => {
                    const over60 = Number(r.overdue_61_90) + Number(r.overdue_90plus);
                    const sent = reminderSent.has(r.buyer_tax_code);
                    return (
                      <tr key={r.buyer_tax_code} className="hover:bg-gray-50">
                        <td className="px-3 py-3">
                          <p className="font-medium text-gray-900 truncate max-w-[130px]">{r.buyer_name}</p>
                          <p className="text-gray-400 font-mono">{r.buyer_tax_code}</p>
                        </td>
                        <td className={`px-3 py-3 text-right ${redShade(Number(r.current_amount))}`}>{mVnd(r.current_amount)}</td>
                        <td className={`px-3 py-3 text-right ${redShade(Number(r.overdue_1_30))}`}>{mVnd(r.overdue_1_30)}</td>
                        <td className={`px-3 py-3 text-right ${redShade(Number(r.overdue_31_60))}`}>{mVnd(r.overdue_31_60)}</td>
                        <td className={`px-3 py-3 text-right ${redShade(over60)}`}>{mVnd(over60)}</td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => void sendReminder(r.buyer_tax_code)}
                              disabled={sent}
                              className={`text-[10px] px-2 py-1 rounded-md font-medium transition-colors ${
                                sent
                                  ? 'bg-gray-100 text-gray-400'
                                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                              }`}
                            >
                              {sent ? '✓ Đã nhắc' : '📩 Nhắc nợ'}
                            </button>
                            <Link
                              href={`/invoices?buyerTaxCode=${r.buyer_tax_code}`}
                              className="text-[10px] px-2 py-1 rounded-md bg-gray-50 text-gray-600 hover:bg-gray-100 font-medium"
                            >
                              Xem HĐ
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-bold">
                    <td className="px-3 py-2.5 text-gray-700">TỔNG</td>
                    <td className="px-3 py-2.5 text-right text-gray-900">{mVnd(totalCurrent)}</td>
                    <td className="px-3 py-2.5 text-right text-gray-900">{mVnd(total130)}</td>
                    <td className="px-3 py-2.5 text-right text-gray-900">{mVnd(total3160)}</td>
                    <td className="px-3 py-2.5 text-right text-gray-900">{mVnd(totalOver60)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Auto reminder settings */}
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-2">
            <p className="text-sm font-semibold text-gray-700">Nhắc Nợ Tự Động</p>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" defaultChecked className="rounded border-gray-300 text-primary-600" />
              Tự động nhắc khi hóa đơn đến hạn 1 ngày trước
            </label>
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-gray-400">Cài đặt thông báo nâng cao</p>
              <Link href="/settings/notifications" className="text-xs text-primary-600 hover:underline">
                Cài đặt nhắc nhở →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

