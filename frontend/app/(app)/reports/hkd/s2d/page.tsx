'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import api from '../../../../../lib/apiClient';
import { downloadExcel } from '../../../../../lib/downloadExcel';

interface S2dRow {
  invoice_number: string;
  invoice_date: string;
  description: string;
  unit: string;
  unit_price: number;
  quantity: number;
  amount: number;
  direction: string;
}
interface S2dData {
  company: { name: string; tax_code: string; address: string | null };
  period: { quarter: number; year: number; start_month: number; end_month: number };
  rows: S2dRow[];
}

const YEARS    = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const QUARTERS = [1, 2, 3, 4];

export default function S2dPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());
  const [data, setData]       = useState<S2dData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (activeCompany && activeCompany.company_type !== 'household') router.replace('/dashboard');
  }, [activeCompany, router]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/hkd-reports/s2d', { params: { quarter, year } });
      setData(res.data.data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu'); }
    finally { setLoading(false); }
  }, [quarter, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fmt = (n: number) => n === 0 ? '' : n.toLocaleString('vi-VN');
  const fmtQ = (n: number) => n === 0 ? '' : n.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S2d-HKD</h1>
          <p className="text-sm text-gray-500">SỔ CHI TIẾT VẬT LIỆU, DỤNG CỤ, SẢN PHẨM, HÀNG HÓA</p>
        </div>
        <button
          onClick={() => downloadExcel(`/hkd-reports/s2d/excel?quarter=${quarter}&year=${year}`, `S2d-HKD_Q${quarter}_${year}.xlsx`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Tải Excel
        </button>
      </div>

      <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
        Sổ S2d hiển thị chi tiết hàng hóa từ các dòng hóa đơn đã được nhập liệu chi tiết (line items).
        Hóa đơn chưa có chi tiết sẽ không hiển thị ở đây.
      </div>

      <div className="flex flex-wrap gap-3 bg-gray-50 rounded-xl p-3">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Quý</label>
          <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
            {QUARTERS.map((q) => <option key={q} value={q}>Quý {q}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Năm</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm">
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button onClick={fetchData} className="px-3 py-1.5 bg-primary-600 text-white text-sm rounded-lg hover:bg-primary-700 transition-colors">Xem</button>
      </div>

      {error && <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}

      {data && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
            <p className="font-semibold text-sm">{data.company.name}</p>
            <p className="text-xs text-gray-500">MST: {data.company.tax_code}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Kỳ: Quý {data.period.quarter}/{data.period.year}
              (T{data.period.start_month} – T{data.period.end_month}/{data.period.year})
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[900px]">
              <thead className="bg-blue-50">
                <tr>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Số hiệu</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Ngày, tháng</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Diễn giải</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>ĐVT</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Đơn giá</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" colSpan={2}>Nhập</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" colSpan={2}>Xuất</th>
                  <th className="px-2 py-2 text-center border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Ghi chú</th>
                </tr>
                <tr className="bg-blue-50">
                  <th className="px-2 py-1 text-center border-b border-gray-200 font-semibold text-gray-700">SL</th>
                  <th className="px-2 py-1 text-center border-b border-gray-200 font-semibold text-gray-700">TT</th>
                  <th className="px-2 py-1 text-center border-b border-gray-200 font-semibold text-gray-700">SL</th>
                  <th className="px-2 py-1 text-center border-b border-gray-200 font-semibold text-gray-700">TT</th>
                </tr>
                <tr className="bg-blue-50/60 text-center italic text-gray-400">
                  {['A','B','C','D','1','2','3','4','5','8'].map((h) => (
                    <th key={h} className="px-2 py-1 border-b border-gray-200">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">Đang tải...</td></tr>
                ) : data.rows.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400 italic">Chưa có dữ liệu chi tiết hàng hóa. Hóa đơn cần được nhập line items.</td></tr>
                ) : data.rows.map((row, i) => {
                  const isInput = row.direction === 'input';
                  return (
                    <tr key={i} className={`hover:bg-gray-50 ${isInput ? '' : 'bg-orange-50/30'}`}>
                      <td className="px-2 py-1.5 text-gray-600">{row.invoice_number}</td>
                      <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{row.invoice_date}</td>
                      <td className="px-2 py-1.5 text-gray-800">{row.description}</td>
                      <td className="px-2 py-1.5 text-center text-gray-600">{row.unit}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmt(row.unit_price)}</td>
                      {/* Nhập (input direction) */}
                      <td className="px-2 py-1.5 text-right tabular-nums text-green-700">{isInput ? fmtQ(row.quantity) : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-green-700">{isInput ? fmt(row.amount) : ''}</td>
                      {/* Xuất (output direction) */}
                      <td className="px-2 py-1.5 text-right tabular-nums text-orange-700">{!isInput ? fmtQ(row.quantity) : ''}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-orange-700">{!isInput ? fmt(row.amount) : ''}</td>
                      <td className="px-2 py-1.5" />
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
