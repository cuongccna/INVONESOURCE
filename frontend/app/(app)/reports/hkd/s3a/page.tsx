'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../../contexts/CompanyContext';
import { downloadExcel } from '../../../../../lib/downloadExcel';

type PeriodType = 'month' | 'quarter';
const YEARS    = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);
const MONTHS   = Array.from({ length: 12 }, (_, i) => i + 1);
const QUARTERS = [1, 2, 3, 4];

// S3a is a manual-entry ledger for other tax types (import/export duties,
// excise tax, environmental protection tax, resource tax, land use tax).
// The form is generated blank for manual completion per TT152/2025 Mẫu S3a-HKD.

const TAX_TYPES = [
  { key: 'xnk',   label: 'Thuế xuất nhập khẩu',                  col: 7 },
  { key: 'ttdb',  label: 'Thuế tiêu thụ đặc biệt',               col: 7 },
  { key: 'bvmt',  label: 'Thuế bảo vệ môi trường',                col: 10 },
  { key: 'tn',    label: 'Thuế tài nguyên',                       col: 11 },
  { key: 'dat',   label: 'Thuế sử dụng đất phi nông nghiệp',      col: 12 },
];

export default function S3aPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const now = new Date();
  const [periodType, setPeriodType] = useState<PeriodType>('month');
  const [month, setMonth]     = useState(() => now.getMonth() + 1);
  const [quarter, setQuarter] = useState(() => Math.ceil((now.getMonth() + 1) / 3));
  const [year, setYear]       = useState(() => now.getFullYear());

  useEffect(() => {
    if (activeCompany && activeCompany.company_type !== 'household') router.replace('/dashboard');
  }, [activeCompany, router]);

  const periodLabelStr = periodType === 'month'
    ? `Tháng ${month}/${year}`
    : `Quý ${quarter}/${year}`;

  const fileTag = periodType === 'month' ? `T${month}_${year}` : `Q${quarter}_${year}`;

  const handleExcel = () => {
    const qs = periodType === 'month' ? `month=${month}&year=${year}` : `quarter=${quarter}&year=${year}`;
    downloadExcel(`/hkd-reports/s3a/excel?${qs}`, `S3a-HKD_${fileTag}.xlsx`);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Mẫu số S3a-HKD</h1>
          <p className="text-sm text-gray-500">SỔ THEO DÕI NGHĨA VỤ THUẾ KHÁC</p>
        </div>
        <button onClick={handleExcel}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Tải Excel (Mẫu trắng)
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
      </div>

      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 space-y-2">
        <p className="font-semibold">Lưu ý về Sổ S3a</p>
        <p>
          Sổ S3a dùng để theo dõi các nghĩa vụ thuế <strong>khác ngoài GTGT và TNCN</strong>,
          bao gồm: thuế xuất nhập khẩu, thuế tiêu thụ đặc biệt, thuế bảo vệ môi trường,
          thuế tài nguyên, thuế sử dụng đất phi nông nghiệp.
        </p>
        <p>
          Dữ liệu sổ S3a phải được nhập liệu thủ công theo chứng từ thực tế.
          Tải file Excel mẫu và điền vào các cột tương ứng.
        </p>
      </div>

      {/* Preview table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          {activeCompany && (
            <>
              <p className="font-semibold text-sm">HỌ, CÁ NHÂN KINH DOANH: {activeCompany.name}</p>
              <p className="text-xs text-gray-500">MST: {activeCompany.tax_code}</p>
            </>
          )}
          <p className="text-xs text-gray-500 mt-0.5">Kỳ kê khai: {periodLabelStr}</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[1000px]">
            <thead className="bg-blue-50">
              <tr>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Ngày tháng ghi sổ</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700" rowSpan={2}>Diễn giải</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Lượng HH, DV chịu thuế</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Mức thuế tuyệt đối</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Giá tính thuế / 01 đv HH, DV</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Thuế suất</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" colSpan={2}>Thuế XNK, TTĐB</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Thuế BVMT</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Thuế tài nguyên</th>
                <th className="px-2 py-2 border-b border-gray-200 font-semibold text-gray-700 text-center" rowSpan={2}>Thuế SD đất PNN</th>
              </tr>
              <tr className="bg-blue-50">
                <th className="px-2 py-1 border-b border-gray-200 font-semibold text-gray-700 text-center">PP tỷ lệ %</th>
                <th className="px-2 py-1 border-b border-gray-200 font-semibold text-gray-700 text-center">PP tuyệt đối</th>
              </tr>
              <tr className="bg-blue-50/60 text-center italic text-gray-400">
                {['A','B','1','2','3','4','5','6','8','9','10'].map((h) => (
                  <th key={h} className="px-2 py-1 border-b border-gray-200">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 10 }, (_, i) => (
                <tr key={i} className="border-b border-gray-100">
                  {Array.from({ length: 11 }, (_, j) => (
                    <td key={j} className="px-2 py-3 text-gray-300 text-center border-r border-gray-100 last:border-0">
                      {i === 0 && j === 1 ? '(nhập liệu thủ công)' : ''}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="bg-gray-50 font-bold border-t-2 border-gray-300">
                <td className="px-2 py-2 text-gray-700" colSpan={2}>Tổng cộng</td>
                {Array.from({ length: 9 }, (_, i) => (
                  <td key={i} className="px-2 py-2 text-center border-r border-gray-100" />
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Tax type reference */}
      <div className="bg-gray-50 rounded-xl p-4">
        <p className="text-sm font-semibold text-gray-700 mb-3">Các loại thuế cần theo dõi trong S3a</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {TAX_TYPES.map((t) => (
            <div key={t.key} className="flex items-start gap-2 bg-white rounded-lg p-3 border border-gray-100">
              <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-800">{t.label}</p>
                <p className="text-xs text-gray-400">Cột {t.col} trong mẫu</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <div className="text-center text-sm text-gray-600 space-y-1">
          <p>Ngày ... tháng ... năm ...</p>
          <p className="font-semibold">NGƯỜI ĐẠI DIỆN HỘ KINH DOANH/CÁ NHÂN KINH DOANH</p>
          <p className="italic text-gray-400">(Ký, họ tên, đóng dấu)</p>
        </div>
      </div>
    </div>
  );
}
