'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import api from '../../../../../lib/apiClient';
import { downloadExcel } from '../../../../../lib/downloadExcel';

interface S2Row { invoice_number: string; invoice_date: string; description: string; amount: number; }
interface S2aData {
  company: { name: string; tax_code: string; address: string | null };
  period: { quarter?: number; month?: number; year: number };
  industry_group: number;
  vat_rate: number;
  pit_rate: number;
  industry_label: string;
  rows: S2Row[];
  revenue_total: number;
  vat_total: number;
  pit_total: number;
  tax_total: number;
}

type PeriodType = 'month' | 'quarter';
const YEARS    = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const MONTHS   = Array.from({ length: 12 }, (_, i) => i + 1);
const QUARTERS = [1, 2, 3, 4];

function periodLabel(p: { quarter?: number; month?: number; year: number }) {
  return p.quarter ? `Quý ${p.quarter}/${p.year}` : `Tháng ${p.month}/${p.year}`;
}

export default function S2aPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [month, setMonth]     = useState(() => now.getMonth() + 1);
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());
  const [data, setData]       = useState<S2aData | null>(null);
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
      const res = await api.get('/hkd-reports/s2a', { params });
      setData(res.data.data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu'); }
    finally { setLoading(false); }
  }, [periodType, month, quarter, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fmt = (n: number) => n.toLocaleString('vi-VN');

  const handleExcel = () => {
    const qs = periodType === 'month' ? `month=${month}&year=${year}` : `quarter=${quarter}&year=${year}`;
    downloadExcel(`/hkd-reports/s2a/excel?${qs}`, `S2a-HKD_${fileTag}.xlsx`);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S2a-HKD</h1>
          <p className="text-sm text-gray-500">SỔ DOANH THU BÁN HÀNG HÓA, DỊCH VỤ (GTGT + TNCN)</p>
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

      {data && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <p className="font-semibold text-sm">{data.company.name}</p>
            <p className="text-xs text-gray-500">MST: {data.company.tax_code} | {data.company.address}</p>
            <p className="text-xs text-gray-500 mt-0.5">Kỳ kê khai: {periodLabel(data.period)}</p>
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
                <tr className="bg-blue-50/60">
                  {['A','B','C','1'].map((h) => (
                    <th key={h} className="px-3 py-1 text-center border-b border-gray-200 text-xs text-gray-400 italic">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                <tr className="bg-amber-50">
                  <td colSpan={3} className="px-3 py-2 font-semibold text-sm text-amber-800">
                    1. Ngành nghề: {data.industry_label} (Nhóm {data.industry_group})
                  </td>
                  <td />
                </tr>
                {loading ? (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm">Đang tải...</td></tr>
                ) : data.rows.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400 text-sm italic">Không có dữ liệu trong kỳ này</td></tr>
                ) : data.rows.map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-600 text-xs">{row.invoice_number}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">{row.invoice_date}</td>
                    <td className="px-3 py-2 text-gray-800">{row.description}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                  <td colSpan={3} className="px-3 py-2 text-gray-700">Tổng cộng (1)</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(data.revenue_total)}</td>
                </tr>
                <tr className="bg-blue-50/60">
                  <td colSpan={3} className="px-3 py-2 text-blue-700">Thuế GTGT ({data.vat_rate}%)</td>
                  <td className="px-3 py-2 text-right tabular-nums text-blue-700 font-semibold">{fmt(data.vat_total)}</td>
                </tr>
                <tr className="bg-orange-50/60">
                  <td colSpan={3} className="px-3 py-2 text-orange-700">Thuế TNCN ({data.pit_rate}%)</td>
                  <td className="px-3 py-2 text-right tabular-nums text-orange-700 font-semibold">{fmt(data.pit_total)}</td>
                </tr>
                <tr className="bg-blue-100 font-bold border-t-2 border-blue-300">
                  <td colSpan={3} className="px-3 py-2 text-blue-900">Tổng số thuế GTGT phải nộp</td>
                  <td className="px-3 py-2 text-right tabular-nums text-blue-900">{fmt(data.vat_total)}</td>
                </tr>
                <tr className="bg-orange-100 font-bold">
                  <td colSpan={3} className="px-3 py-2 text-orange-900">Tổng số thuế TNCN phải nộp</td>
                  <td className="px-3 py-2 text-right tabular-nums text-orange-900">{fmt(data.pit_total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
      {data && (
        <div className="flex justify-end mt-4">
          <div className="text-center text-sm text-gray-600 space-y-1">
            <p>Ngày ... tháng ... năm ...</p>
            <p className="font-semibold">NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/</p>
            <p className="font-semibold">CÁ NHÂN KINH DOANH</p>
            <p className="italic text-gray-400">(Ký, họ tên, đóng dấu)</p>
          </div>
        </div>
      )}
    </div>
  );
}
