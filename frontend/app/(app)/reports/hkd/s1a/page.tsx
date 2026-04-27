'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import api from '../../../../../lib/apiClient';
import { downloadExcel } from '../../../../../lib/downloadExcel';

interface S1aRow { invoice_date: string; description: string; amount: number; }
interface S1aData {
  company: { name: string; tax_code: string; address: string | null };
  period: { quarter: number; year: number; start_month: number; end_month: number };
  rows: S1aRow[];
  total_amount: number;
}

const YEARS  = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const QUARTERS = [1, 2, 3, 4];

export default function S1aPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());
  const [data, setData]       = useState<S1aData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Guard: redirect non-household companies
  useEffect(() => {
    if (activeCompany && activeCompany.company_type !== 'household') {
      router.replace('/dashboard');
    }
  }, [activeCompany, router]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/hkd-reports/s1a', { params: { quarter, year } });
      setData(res.data.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu');
    } finally { setLoading(false); }
  }, [quarter, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleExcel = () => {
    downloadExcel(`/hkd-reports/s1a/excel?quarter=${quarter}&year=${year}`, `S1a-HKD_Q${quarter}_${year}.xlsx`);
  };

  const fmt = (n: number) => n.toLocaleString('vi-VN');

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S1a-HKD</h1>
          <p className="text-sm text-gray-500">SỔ CHI TIẾT DOANH THU BÁN HÀNG HÓA, DỊCH VỤ</p>
        </div>
        <button
          onClick={handleExcel}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Tải Excel
        </button>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-3 bg-gray-50 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Quý</label>
          <select
            value={quarter}
            onChange={(e) => setQuarter(Number(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          >
            {QUARTERS.map((q) => <option key={q} value={q}>Quý {q}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Năm</label>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          >
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 transition-colors"
        >
          Xem
        </button>
      </div>

      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      {data && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {/* Company info */}
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <p className="font-semibold text-sm">{data.company.name}</p>
            <p className="text-xs text-gray-500">MST: {data.company.tax_code} | {data.company.address}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Kỳ kê khai: Quý {data.period.quarter}/{data.period.year}&nbsp;
              (T{data.period.start_month}/{data.period.year} – T{data.period.end_month}/{data.period.year})
            </p>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-blue-50">
                <tr>
                  <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-32">Ngày tháng</th>
                  <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700">Giao dịch</th>
                  <th className="px-3 py-2 text-right border-b border-gray-200 text-xs font-semibold text-gray-700 w-36">Số tiền (VNĐ)</th>
                </tr>
                <tr className="bg-blue-50/60">
                  <th className="px-3 py-1 text-center border-b border-gray-200 text-xs text-gray-400 italic">A</th>
                  <th className="px-3 py-1 text-center border-b border-gray-200 text-xs text-gray-400 italic">B</th>
                  <th className="px-3 py-1 text-center border-b border-gray-200 text-xs text-gray-400 italic">1</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={3} className="px-3 py-8 text-center text-gray-400 text-sm">Đang tải...</td></tr>
                ) : data.rows.length === 0 ? (
                  <tr><td colSpan={3} className="px-3 py-8 text-center text-gray-400 text-sm italic">Không có dữ liệu trong kỳ này</td></tr>
                ) : (
                  data.rows.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{row.invoice_date}</td>
                      <td className="px-3 py-2 text-gray-800">{row.description}</td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(row.amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="bg-blue-50 font-bold border-t-2 border-blue-200">
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-gray-800">Tổng cộng</td>
                  <td className="px-3 py-2 text-right tabular-nums text-blue-800">{fmt(data.total_amount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Signature block */}
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
