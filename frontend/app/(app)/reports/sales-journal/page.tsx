'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';

interface JournalInvoice {
  id: string;
  invoice_date: string;
  invoice_number: string;
  serial: string | null;
  buyer_name?: string;
  buyer_tax_code?: string;
  seller_name?: string;
  seller_tax_code?: string;
  subtotal: string;
  vat_amount: string;
  total_amount: string;
  dt_0pct: string;
  dt_5pct: string;
  dt_8pct: string;
  dt_10pct: string;
  vat_0pct: string;
  vat_5pct: string;
  vat_8pct: string;
  vat_10pct: string;
}

interface JournalTotals {
  subtotal: number;
  vat_amount: number;
  total_amount: number;
  dt_0pct: number;
  dt_5pct: number;
  dt_8pct: number;
  dt_10pct: number;
  vat_0pct: number;
  vat_5pct: number;
  vat_8pct: number;
  vat_10pct: number;
}

interface JournalData {
  invoices: JournalInvoice[];
  totals: JournalTotals;
  period: { month: number; year: number };
}

type JournalType = 'sales' | 'purchase';

export default function JournalsPage() {
  const { activeCompanyId } = useCompany();
  const [tab, setTab] = useState<JournalType>('sales');
  const [data, setData] = useState<JournalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => new Date().getMonth() + 1);
  const [year, setYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    if (!activeCompanyId) return;
    setLoading(true);
    apiClient
      .get<{ data: JournalData }>(`/journals/${tab}?month=${month}&year=${year}`)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [activeCompanyId, tab, month, year]);

  const f = (v: string | number) => formatVND(Number(v));
  const emptyTotals: JournalTotals = {
    subtotal: 0, vat_amount: 0, total_amount: 0,
    dt_0pct: 0, dt_5pct: 0, dt_8pct: 0, dt_10pct: 0,
    vat_0pct: 0, vat_5pct: 0, vat_8pct: 0, vat_10pct: 0,
  };
  const totals = data?.totals ?? emptyTotals;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {tab === 'sales' ? 'Bảng Kê Hóa Đơn Bán Ra' : 'Bảng Kê Hóa Đơn Mua Vào'}
          </h1>
          <p className="text-sm text-gray-500">{data?.invoices.length ?? 0} hóa đơn kỳ này</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex bg-gray-100 rounded-lg p-1">
            <button onClick={() => setTab('sales')}
              className={`px-3 py-1 rounded-md text-sm font-medium ${tab === 'sales' ? 'bg-white shadow text-blue-700' : 'text-gray-500'}`}>
              Bán ra
            </button>
            <button onClick={() => setTab('purchase')}
              className={`px-3 py-1 rounded-md text-sm font-medium ${tab === 'purchase' ? 'bg-white shadow text-blue-700' : 'text-gray-500'}`}>
              Mua vào
            </button>
          </div>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
            className="border rounded-lg px-2 py-1 text-sm">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>Tháng {m}</option>
            ))}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="border rounded-lg px-2 py-1 text-sm">
            {[2023, 2024, 2025, 2026].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Doanh số KCT', val: totals.dt_0pct, pct: '0%' },
          { label: 'Doanh số 5%', val: totals.dt_5pct, pct: '5%' },
          { label: 'Doanh số 8%', val: totals.dt_8pct, pct: '8%' },
          { label: 'Doanh số 10%', val: totals.dt_10pct, pct: '10%' },
        ].map((c) => (
          <div key={c.pct} className="bg-white border border-gray-200 rounded-xl p-3">
            <p className="text-xs text-gray-500">{c.label} (VAT {c.pct})</p>
            <p className="text-base font-semibold mt-1">{f(c.val)}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <p className="text-xs text-gray-500">Tổng chưa VAT</p>
          <p className="text-base font-semibold mt-1">{f(totals.subtotal)}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <p className="text-xs text-gray-500">Tổng VAT</p>
          <p className="text-base font-semibold mt-1 text-orange-600">{f(totals.vat_amount)}</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-3">
          <p className="text-xs text-gray-500">Tổng cộng</p>
          <p className="text-base font-semibold mt-1 text-blue-700">{f(totals.total_amount)}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Ngày</th>
                <th className="px-3 py-2 text-left">Số HĐ</th>
                <th className="px-3 py-2 text-left">{tab === 'sales' ? 'Khách hàng' : 'Nhà cung cấp'}</th>
                <th className="px-3 py-2 text-left">MST</th>
                <th className="px-3 py-2 text-right">DT 0%</th>
                <th className="px-3 py-2 text-right">DT 5%</th>
                <th className="px-3 py-2 text-right">DT 8%</th>
                <th className="px-3 py-2 text-right">DT 10%</th>
                <th className="px-3 py-2 text-right">VAT</th>
                <th className="px-3 py-2 text-right">Tổng cộng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(!data?.invoices || data.invoices.length === 0) ? (
                <tr><td colSpan={10} className="text-center py-8 text-gray-400">Không có hóa đơn hợp lệ trong kỳ</td></tr>
              ) : data.invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-500">{inv.invoice_date}</td>
                  <td className="px-3 py-2 font-mono">{inv.invoice_number}</td>
                  <td className="px-3 py-2">{tab === 'sales' ? inv.buyer_name : inv.seller_name}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono">{tab === 'sales' ? inv.buyer_tax_code : inv.seller_tax_code}</td>
                  <td className="px-3 py-2 text-right">{Number(inv.dt_0pct) ? f(inv.dt_0pct) : ''}</td>
                  <td className="px-3 py-2 text-right">{Number(inv.dt_5pct) ? f(inv.dt_5pct) : ''}</td>
                  <td className="px-3 py-2 text-right">{Number(inv.dt_8pct) ? f(inv.dt_8pct) : ''}</td>
                  <td className="px-3 py-2 text-right">{Number(inv.dt_10pct) ? f(inv.dt_10pct) : ''}</td>
                  <td className="px-3 py-2 text-right text-orange-600">{f(inv.vat_amount)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{f(inv.total_amount)}</td>
                </tr>
              ))}
            </tbody>
            {data && data.invoices.length > 0 && (
              <tfoot className="bg-gray-50 font-semibold text-xs">
                <tr>
                  <td colSpan={4} className="px-3 py-2">Tổng cộng ({data.invoices.length} HĐ)</td>
                  <td className="px-3 py-2 text-right">{f(totals.dt_0pct)}</td>
                  <td className="px-3 py-2 text-right">{f(totals.dt_5pct)}</td>
                  <td className="px-3 py-2 text-right">{f(totals.dt_8pct)}</td>
                  <td className="px-3 py-2 text-right">{f(totals.dt_10pct)}</td>
                  <td className="px-3 py-2 text-right text-orange-700">{f(totals.vat_amount)}</td>
                  <td className="px-3 py-2 text-right text-blue-700">{f(totals.total_amount)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
