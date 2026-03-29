'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';
import PeriodSelector, {
  type PeriodValue,
  defaultPeriod,
  periodToParams,
  periodLabel,
} from '../../../../components/PeriodSelector';

interface RateGroup {
  vat_rate: string | null;
  subtotal: string;
  vat_amount: string;
  total_amount: string;
  invoice_count: string;
}

interface TopPartner {
  buyer_name?: string;
  buyer_tax_code?: string;
  seller_name?: string;
  seller_tax_code?: string;
  total_revenue?: string;
  total_spend?: string;
  invoice_count: string;
}

interface RevenueExpenseData {
  period: { month: number; year: number };
  revenue_by_rate: RateGroup[];
  expense_by_rate: RateGroup[];
  top_customers: TopPartner[];
  top_suppliers: TopPartner[];
}

export default function RevenueExpensePage() {
  const { activeCompanyId } = useCompany();
  const [data, setData] = useState<RevenueExpenseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriod);

  useEffect(() => {
    if (!activeCompanyId) return;
    setLoading(true);
    apiClient
      .get<{ data: RevenueExpenseData }>(`/journals/revenue-expense?${periodToParams(period)}`)
      .then((r) => setData(r.data.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [activeCompanyId, period]);

  const totalRevenue = data?.revenue_by_rate.reduce((s, r) => s + Number(r.subtotal), 0) ?? 0;
  const totalExpense = data?.expense_by_rate.reduce((s, r) => s + Number(r.subtotal), 0) ?? 0;
  const profit = totalRevenue - totalExpense;

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Doanh Thu & Chi Phí</h1>
          <p className="text-sm text-gray-500">{periodLabel(period)}</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <p className="text-xs text-green-700">Tổng doanh thu</p>
          <p className="text-xl font-bold text-green-800 mt-1">{formatVND(totalRevenue)}</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-red-700">Tổng chi phí mua vào</p>
          <p className="text-xl font-bold text-red-800 mt-1">{formatVND(totalExpense)}</p>
        </div>
        <div className={`border rounded-xl p-4 ${profit >= 0 ? 'bg-blue-50 border-blue-200' : 'bg-orange-50 border-orange-200'}`}>
          <p className={`text-xs ${profit >= 0 ? 'text-blue-700' : 'text-orange-700'}`}>Lợi nhuận gộp ước tính</p>
          <p className={`text-xl font-bold mt-1 ${profit >= 0 ? 'text-blue-800' : 'text-orange-800'}`}>{formatVND(profit)}</p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : data && (
        <>
          {/* Revenue by rate */}
          <div>
            <h2 className="text-base font-semibold text-gray-800 mb-2">📈 Doanh thu theo thuế suất</h2>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Thuế suất</th>
                    <th className="px-3 py-2 text-right">Chưa VAT</th>
                    <th className="px-3 py-2 text-right">VAT</th>
                    <th className="px-3 py-2 text-right">Tổng cộng</th>
                    <th className="px-3 py-2 text-right">Số HĐ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.revenue_by_rate.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-6 text-gray-400">Không có dữ liệu</td></tr>
                  ) : data.revenue_by_rate.map((r) => (
                    <tr key={r.vat_rate ?? 'null'} className="hover:bg-gray-50">
                      <td className="px-3 py-2">{r.vat_rate !== null ? `${r.vat_rate}%` : 'KCT'}</td>
                      <td className="px-3 py-2 text-right text-green-700">{formatVND(r.subtotal)}</td>
                      <td className="px-3 py-2 text-right text-orange-600">{formatVND(r.vat_amount)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{formatVND(r.total_amount)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{r.invoice_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Expense by rate */}
          <div>
            <h2 className="text-base font-semibold text-gray-800 mb-2">📉 Chi phí mua vào theo thuế suất</h2>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Thuế suất</th>
                    <th className="px-3 py-2 text-right">Chưa VAT</th>
                    <th className="px-3 py-2 text-right">VAT khấu trừ</th>
                    <th className="px-3 py-2 text-right">Tổng cộng</th>
                    <th className="px-3 py-2 text-right">Số HĐ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.expense_by_rate.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-6 text-gray-400">Không có dữ liệu</td></tr>
                  ) : data.expense_by_rate.map((r) => (
                    <tr key={r.vat_rate ?? 'null'} className="hover:bg-gray-50">
                      <td className="px-3 py-2">{r.vat_rate !== null ? `${r.vat_rate}%` : 'KCT'}</td>
                      <td className="px-3 py-2 text-right text-red-700">{formatVND(r.subtotal)}</td>
                      <td className="px-3 py-2 text-right text-orange-600">{formatVND(r.vat_amount)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{formatVND(r.total_amount)}</td>
                      <td className="px-3 py-2 text-right text-gray-500">{r.invoice_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Top customers + suppliers */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-800 mb-2">🏆 Top 10 khách hàng</h2>
              <div className="space-y-2">
                {data.top_customers.map((c, i) => (
                  <div key={i} className="flex justify-between items-center text-sm bg-gray-50 rounded-lg px-3 py-2">
                    <div>
                      <p className="font-medium">{c.buyer_name}</p>
                      <p className="text-xs text-gray-500">{c.buyer_tax_code} · {c.invoice_count} HĐ</p>
                    </div>
                    <p className="font-semibold text-green-700">{formatVND(c.total_revenue ?? 0)}</p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-800 mb-2">🏭 Top 10 nhà cung cấp</h2>
              <div className="space-y-2">
                {data.top_suppliers.map((s, i) => (
                  <div key={i} className="flex justify-between items-center text-sm bg-gray-50 rounded-lg px-3 py-2">
                    <div>
                      <p className="font-medium">{s.seller_name}</p>
                      <p className="text-xs text-gray-500">{s.seller_tax_code} · {s.invoice_count} HĐ</p>
                    </div>
                    <p className="font-semibold text-red-700">{formatVND(s.total_spend ?? 0)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
