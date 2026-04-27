'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import api from '../../../../../lib/apiClient';
import { downloadExcel } from '../../../../../lib/downloadExcel';

interface CashRow { invoice_number: string; invoice_date: string; description: string; cash_in: number; cash_out: number; }
interface CashSection {
  opening_balance: number;
  rows: CashRow[];
  total_in: number;
  total_out: number;
  closing_balance: number;
}
interface S2eData {
  company: { name: string; tax_code: string; address: string | null };
  period: { quarter?: number; month?: number; year: number };
  cash: CashSection;
  bank: CashSection;
}

type PeriodType = 'month' | 'quarter';
const YEARS    = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const MONTHS   = Array.from({ length: 12 }, (_, i) => i + 1);
const QUARTERS = [1, 2, 3, 4];

function periodLabel(p: { quarter?: number; month?: number; year: number }) {
  return p.quarter ? `Quý ${p.quarter}/${p.year}` : `Tháng ${p.month}/${p.year}`;
}

export default function S2ePage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [month, setMonth]     = useState(() => now.getMonth() + 1);
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());
  const [data, setData]       = useState<S2eData | null>(null);
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
      const res = await api.get('/hkd-reports/s2e', { params });
      setData(res.data.data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu'); }
    finally { setLoading(false); }
  }, [periodType, month, quarter, year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fmt = (n: number) => n === 0 ? '' : n.toLocaleString('vi-VN');

  const handleExcel = () => {
    const qs = periodType === 'month' ? `month=${month}&year=${year}` : `quarter=${quarter}&year=${year}`;
    downloadExcel(`/hkd-reports/s2e/excel?${qs}`, `S2e-HKD_${fileTag}.xlsx`);
  };

  const SectionTable = ({ title, section, emptyMsg }: { title: string; section: CashSection; emptyMsg: string }) => (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2 bg-blue-50 border-b border-gray-200">
        <p className="font-semibold text-sm text-blue-800">{title}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-blue-50/60">
            <tr>
              <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-32">Số hiệu</th>
              <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700 w-28">Ngày tháng</th>
              <th className="px-3 py-2 text-left border-b border-gray-200 text-xs font-semibold text-gray-700">Diễn giải</th>
              <th className="px-3 py-2 text-right border-b border-gray-200 text-xs font-semibold text-gray-700 w-36">Thu / Gửi vào</th>
              <th className="px-3 py-2 text-right border-b border-gray-200 text-xs font-semibold text-gray-700 w-36">Chi / Rút ra</th>
            </tr>
            <tr className="bg-blue-50/40">
              {['A','B','C','1','2'].map((h) => (
                <th key={h} className="px-3 py-1 text-center border-b border-gray-200 text-xs text-gray-400 italic">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {/* Opening balance row */}
            <tr className="bg-yellow-50 font-semibold text-yellow-800">
              <td className="px-3 py-2" />
              <td className="px-3 py-2" />
              <td className="px-3 py-2 italic text-sm">Số dư đầu kỳ</td>
              <td className="px-3 py-2 text-right tabular-nums">{section.opening_balance.toLocaleString('vi-VN')}</td>
              <td className="px-3 py-2" />
            </tr>
            {/* Transaction rows */}
            {section.rows.length === 0
              ? <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-400 text-sm italic">{emptyMsg}</td></tr>
              : section.rows.map((row, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-600 text-xs">{row.invoice_number}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap text-xs">{row.invoice_date}</td>
                  <td className="px-3 py-2 text-gray-800">{row.description}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-green-700 font-medium">{fmt(row.cash_in)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-700 font-medium">{fmt(row.cash_out)}</td>
                </tr>
              ))
            }
          </tbody>
          <tfoot>
            <tr className="bg-gray-50 font-bold border-t border-gray-200">
              <td colSpan={3} className="px-3 py-2 text-gray-700">Tổng phát sinh trong kỳ</td>
              <td className="px-3 py-2 text-right tabular-nums text-green-800">{section.total_in.toLocaleString('vi-VN')}</td>
              <td className="px-3 py-2 text-right tabular-nums text-red-800">{section.total_out.toLocaleString('vi-VN')}</td>
            </tr>
            {/* Closing balance row */}
            <tr className="bg-green-50 font-bold border-t border-green-200 text-green-800">
              <td colSpan={3} className="px-3 py-2 italic">Số dư cuối kỳ</td>
              <td className="px-3 py-2 text-right tabular-nums">{section.closing_balance.toLocaleString('vi-VN')}</td>
              <td className="px-3 py-2" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S2e-HKD</h1>
          <p className="text-sm text-gray-500">SỔ CHI TIẾT TIỀN</p>
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

      <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700">
        Phân loại tự động: Tiền mặt = hóa đơn không có phương thức thanh toán hoặc thanh toán tiền mặt.
        Tiền gửi = các hóa đơn có phương thức thanh toán qua ngân hàng/chuyển khoản.
        Số dư đầu kỳ được tính lũy kế từ tất cả các kỳ trước.
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

          <SectionTable title="Tiền mặt" section={data.cash} emptyMsg="Không có giao dịch tiền mặt trong kỳ" />
          <SectionTable title="Tiền gửi không kỳ hạn" section={data.bank} emptyMsg="Không có giao dịch ngân hàng trong kỳ" />
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
