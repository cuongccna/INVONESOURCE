'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import api from '../../../../../lib/apiClient';
import { downloadExcel } from '../../../../../lib/downloadExcel';

interface S2cRow { invoice_number: string; invoice_date: string; description: string; amount: number; }
interface S2cData {
  company: { name: string; tax_code: string; address: string | null };
  period: { quarter?: number; month?: number; year: number };
  revenue_rows: S2cRow[];
  expense_rows: S2cRow[];
  revenue_total: number;
  expense_total: number;
  profit: number;
}

type PeriodType = 'month' | 'quarter';
const YEARS    = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const MONTHS   = Array.from({ length: 12 }, (_, i) => i + 1);
const QUARTERS = [1, 2, 3, 4];

function periodLabel(p: { quarter?: number; month?: number; year: number }) {
  return p.quarter ? `Quý ${p.quarter}/${p.year}` : `Tháng ${p.month}/${p.year}`;
}

export default function S2cPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [month, setMonth]     = useState(() => now.getMonth() + 1);
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());
  const [data, setData]       = useState<S2cData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (activeCompany && activeCompany.company_type !== 'household') router.replace('/dashboard');
  }, [activeCompany, router]);

  const fileTag = periodType === 'month' ? `T${month}_${year}` : `Q${quarter}_${year}`;

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = periodType === 'month' ? { month, year } : { quarter, year };
      const res = await api.get('/hkd-reports/s2c', { params });
      setData(res.data.data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu'); }
    finally { setLoading(false); }
  }, [periodType, month, quarter, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fmt = (n: number) => n.toLocaleString('vi-VN');

  const handleExcel = () => {
    const qs = periodType === 'month' ? `month=${month}&year=${year}` : `quarter=${quarter}&year=${year}`;
    downloadExcel(`/hkd-reports/s2c/excel?${qs}`, `S2c-HKD_${fileTag}.xlsx`);
  };

  const InvoiceTable = ({ rows, emptyMsg }: { rows: S2cRow[]; emptyMsg: string }) => (
    <>
      {rows.length === 0
        ? <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400 text-sm italic">{emptyMsg}</td></tr>
        : rows.map((row, i) => (
          <tr key={i} className="hover:bg-gray-50">
            <td className="px-3 py-2 text-gray-600 text-xs">{row.invoice_number}</td>
            <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">{row.invoice_date}</td>
            <td className="px-3 py-2 text-gray-800">{row.description}</td>
            <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(row.amount)}</td>
          </tr>
        ))
      }
    </>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S2c-HKD</h1>
          <p className="text-sm text-gray-500">SỔ CHI TIẾT DOANH THU, CHI PHÍ</p>
        </div>
        <button onClick={handleExcel}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Tải Excel
        </button>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-3 items-center bg-gray-50 rounded-xl p-3">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          <button onClick={() => setPeriodType('month')}
            className={`px-3 py-1.5 ${periodType === 'month' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Tháng</button>
          <button onClick={() => setPeriodType('quarter')}
            className={`px-3 py-1.5 ${periodType === 'quarter' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Quý</button>
        </div>
        {periodType === 'month' ? (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 font-medium">Tháng</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              {MONTHS.map((m) => <option key={m} value={m}>Tháng {m}</option>)}
            </select>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 font-medium">Quý</label>
            <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
              {QUARTERS.map((q) => <option key={q} value={q}>Quý {q}</option>)}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Năm</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button onClick={fetchData} className="px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors">Xem</button>
      </div>

      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}
      {loading && !data && <div className="py-12 text-center text-gray-400">Đang tải...</div>}

      {data && (
        <div className="space-y-4">
          <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm">
            <p className="font-semibold">{data.company.name}</p>
            <p className="text-xs text-gray-500">MST: {data.company.tax_code}</p>
            <p className="text-xs text-gray-500 mt-0.5">Kỳ kê khai: {periodLabel(data.period)}</p>
          </div>

          {/* KPI summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-green-50 rounded-xl px-4 py-3">
              <p className="text-xs text-green-700 font-medium">Tổng doanh thu</p>
              <p className="text-lg font-bold text-green-800 tabular-nums">{fmt(data.revenue_total)}</p>
            </div>
            <div className="bg-red-50 rounded-xl px-4 py-3">
              <p className="text-xs text-red-700 font-medium">Tổng chi phí</p>
              <p className="text-lg font-bold text-red-800 tabular-nums">{fmt(data.expense_total)}</p>
            </div>
            <div className={`rounded-xl px-4 py-3 ${data.profit >= 0 ? 'bg-blue-50' : 'bg-orange-50'}`}>
              <p className={`text-xs font-medium ${data.profit >= 0 ? 'text-blue-700' : 'text-orange-700'}`}>Lợi nhuận tạm thời</p>
              <p className={`text-lg font-bold tabular-nums ${data.profit >= 0 ? 'text-blue-800' : 'text-orange-800'}`}>{fmt(data.profit)}</p>
            </div>
          </div>

          {/* Revenue table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-green-50 border-b border-gray-200">
              <p className="font-semibold text-sm text-green-800">DOANH THU</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-blue-50">
                  <tr>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-32">Số hiệu</th>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-28">Ngày tháng</th>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700">Diễn giải</th>
                    <th className="px-3 py-2 text-right border-b border-gray-200 text-xs font-semibold text-gray-700 w-36">Số tiền (VNĐ)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <InvoiceTable rows={data.revenue_rows} emptyMsg="Không có hóa đơn đầu ra trong kỳ" />
                </tbody>
                <tfoot>
                  <tr className="bg-green-50 font-bold border-t-2 border-green-200">
                    <td colSpan={3} className="px-3 py-2 text-green-800">Tổng doanh thu</td>
                    <td className="px-3 py-2 text-right tabular-nums text-green-800">{fmt(data.revenue_total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Expense table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-red-50 border-b border-gray-200">
              <p className="font-semibold text-sm text-red-800">CHI PHÍ</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-blue-50">
                  <tr>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-32">Số hiệu</th>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-28">Ngày tháng</th>
                    <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700">Diễn giải</th>
                    <th className="px-3 py-2 text-right border-b border-gray-200 text-xs font-semibold text-gray-700 w-36">Số tiền (VNĐ)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <InvoiceTable rows={data.expense_rows} emptyMsg="Không có hóa đơn đầu vào trong kỳ" />
                </tbody>
                <tfoot>
                  <tr className="bg-red-50 font-bold border-t-2 border-red-200">
                    <td colSpan={3} className="px-3 py-2 text-red-800">Tổng chi phí</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-800">{fmt(data.expense_total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
      {data && (
        <div className="flex justify-end mt-4">
          <div className="text-center text-sm text-gray-600 space-y-1">
            <p>Ngày ... tháng ... năm ...</p>
            <p className="font-semibold">NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/CÁ NHÂN KINH DOANH</p>
            <p className="italic text-gray-400">(Ký, họ tên, đóng dấu)</p>
          </div>
        </div>
      )}
    </div>
  );
}
