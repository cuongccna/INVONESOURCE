'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import apiClient from '../../../../../lib/apiClient';
import { useToast } from '../../../../../components/ToastProvider';
import { formatVND } from '../../../../../utils/formatCurrency';

interface PitDeclaration {
  id: string;
  company_id: string;
  period_quarter: number;
  period_year: number;
  loai_tkhai: string;
  so_lan: number;
  ma_cqt_noi_nop: string | null;
  ten_cqt_noi_nop: string | null;
  mst_cu: string | null;
  nguoi_ky: string | null;
  notes: string | null;
  ct15: number; ct16: number; ct17: number; ct18: number;
  ct19: number; ct20: number; ct21: number; ct22: number;
  ct23: number; ct24: number; ct25: number; ct25_1: number;
  ct26: number; ct27: number; ct28: number; ct29: number;
  ct30: number; ct31: number; ct32: number;
  submission_status: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Nháp',          color: 'bg-gray-100 text-gray-700' },
  ready:     { label: 'Hoàn thiện',    color: 'bg-blue-100 text-blue-700' },
  submitted: { label: 'Đã nộp',        color: 'bg-orange-100 text-orange-700' },
  accepted:  { label: 'GDT tiếp nhận', color: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Từ chối',       color: 'bg-red-100 text-red-700' },
};

type NumericCtField = 'ct15'|'ct16'|'ct17'|'ct18'|'ct19'|'ct20'|'ct21'|'ct22'|
  'ct23'|'ct24'|'ct25'|'ct25_1'|'ct26'|'ct27'|'ct28'|'ct29'|'ct30'|'ct31'|'ct32';

interface IndicatorRow {
  code: NumericCtField;
  label: string;
  isAutoCalc?: boolean;
  isTotal?: boolean;
  isMoney?: boolean;
}

const INDICATORS: IndicatorRow[] = [
  { code: 'ct15',   label: '[15] Số lao động ký hợp đồng từ 3 tháng trở lên' },
  { code: 'ct16',   label: '[16] Số lao động ký hợp đồng dưới 3 tháng / không hợp đồng' },
  { code: 'ct17',   label: '[17] Tổng số cá nhân phát sinh thu nhập trong kỳ', isAutoCalc: true },
  { code: 'ct18',   label: '[18] Số người được giảm trừ gia cảnh cho bản thân' },
  { code: 'ct19',   label: '[19] Tổng thu nhập chịu thuế (hợp đồng ≥ 3 tháng)', isMoney: true },
  { code: 'ct20',   label: '[20] Giảm trừ gia cảnh (hợp đồng ≥ 3 tháng)', isMoney: true },
  { code: 'ct21',   label: '[21] Thuế TNCN đã khấu trừ (hợp đồng ≥ 3 tháng)', isMoney: true },
  { code: 'ct22',   label: '[22] Tổng thu nhập trả (hợp đồng < 3 tháng, tỷ lệ 10%)', isMoney: true },
  { code: 'ct23',   label: '[23] Thuế TNCN đã khấu trừ (hợp đồng < 3 tháng)', isMoney: true },
  { code: 'ct24',   label: '[24] Thu nhập từ đại lý bảo hiểm / xổ số / MLM', isMoney: true },
  { code: 'ct25',   label: '[25] Thuế khấu trừ (đại lý bảo hiểm / xổ số / MLM)', isMoney: true },
  { code: 'ct25_1', label: '[25a] Thuế khấu trừ nhóm khác', isMoney: true },
  { code: 'ct26',   label: '[26] Thu nhập từ bản quyền, nhượng quyền thương mại', isMoney: true },
  { code: 'ct27',   label: '[27] Thuế khấu trừ (bản quyền, nhượng quyền)', isMoney: true },
  { code: 'ct28',   label: '[28] Thu nhập từ chứng khoán', isMoney: true },
  { code: 'ct29',   label: '[29] Thuế khấu trừ (chứng khoán)', isMoney: true },
  { code: 'ct30',   label: '[30] Thu nhập từ trúng thưởng', isMoney: true },
  { code: 'ct31',   label: '[31] Thuế khấu trừ (trúng thưởng)', isMoney: true },
  { code: 'ct32',   label: '[32] Tổng thuế TNCN đã khấu trừ trong kỳ', isAutoCalc: true, isTotal: true, isMoney: true },
];

function calcAuto(fields: Record<string, number>): Partial<Record<NumericCtField, number>> {
  const ct17 = (fields.ct15 ?? 0) + (fields.ct16 ?? 0);
  const ct32 = (fields.ct21 ?? 0) + (fields.ct23 ?? 0) + (fields.ct25 ?? 0) +
               (fields.ct25_1 ?? 0) + (fields.ct27 ?? 0) + (fields.ct29 ?? 0) + (fields.ct31 ?? 0);
  return { ct17, ct32 };
}

export default function PitDeclarationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router  = useRouter();
  const toast   = useToast();

  const [decl, setDecl]             = useState<PitDeclaration | null>(null);
  const [loading, setLoading]       = useState(true);
  const [saving, setSaving]         = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [markingReady, setMarkingReady] = useState(false);

  // Local editable copy of all fields
  const [fields, setFields] = useState<Record<string, string | number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: PitDeclaration }>(`/pit-declarations/${id}`);
      const d   = res.data.data;
      setDecl(d);
      setFields({
        loai_tkhai: d.loai_tkhai ?? 'C',
        so_lan: d.so_lan ?? 0,
        ma_cqt_noi_nop: d.ma_cqt_noi_nop ?? '',
        ten_cqt_noi_nop: d.ten_cqt_noi_nop ?? '',
        mst_cu: d.mst_cu ?? '',
        nguoi_ky: d.nguoi_ky ?? '',
        notes: d.notes ?? '',
        ct15: d.ct15 ?? 0, ct16: d.ct16 ?? 0, ct17: d.ct17 ?? 0, ct18: d.ct18 ?? 0,
        ct19: d.ct19 ?? 0, ct20: d.ct20 ?? 0, ct21: d.ct21 ?? 0, ct22: d.ct22 ?? 0,
        ct23: d.ct23 ?? 0, ct24: d.ct24 ?? 0, ct25: d.ct25 ?? 0, ct25_1: d.ct25_1 ?? 0,
        ct26: d.ct26 ?? 0, ct27: d.ct27 ?? 0, ct28: d.ct28 ?? 0, ct29: d.ct29 ?? 0,
        ct30: d.ct30 ?? 0, ct31: d.ct31 ?? 0, ct32: d.ct32 ?? 0,
      });
    } catch {
      toast.error('Không tải được tờ khai. Vui lòng thử lại.');
    } finally {
      setLoading(false);
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [load]);

  const isLocked = decl?.submission_status === 'submitted' || decl?.submission_status === 'accepted';

  function handleChange(key: string, value: string) {
    setFields(prev => {
      const updated = { ...prev, [key]: value };
      // Auto-recalculate dependent fields
      const nums: Record<string, number> = {};
      INDICATORS.forEach(row => { nums[row.code] = Number(updated[row.code]) || 0; });
      const auto = calcAuto(nums);
      return { ...updated, ...auto };
    });
  }

  function numVal(key: string): number {
    return Number(fields[key]) || 0;
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const numericFields: Record<string, number> = {};
      INDICATORS.forEach(row => { numericFields[row.code] = numVal(row.code); });

      await apiClient.patch(`/pit-declarations/${id}`, {
        loai_tkhai: fields.loai_tkhai,
        so_lan: Number(fields.so_lan) || 0,
        ma_cqt_noi_nop: fields.ma_cqt_noi_nop || null,
        ten_cqt_noi_nop: fields.ten_cqt_noi_nop || null,
        mst_cu: fields.mst_cu || null,
        nguoi_ky: fields.nguoi_ky || null,
        notes: fields.notes || null,
        ...numericFields,
      });
      toast.success('Đã lưu tờ khai.');
      await load();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
        ?? 'Lỗi lưu tờ khai. Vui lòng thử lại.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleMarkReady = async () => {
    setMarkingReady(true);
    try {
      await apiClient.patch(`/pit-declarations/${id}/status`, { status: 'ready' });
      toast.success('Tờ khai đã được đánh dấu hoàn thiện.');
      await load();
    } catch {
      toast.error('Lỗi cập nhật trạng thái.');
    } finally {
      setMarkingReady(false);
    }
  };

  const handleDownloadXml = async () => {
    setDownloading(true);
    try {
      const res = await apiClient.get(`/pit-declarations/${id}/xml?regenerate=true`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/xml' }));
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `05KK-TNCN_Q${decl?.period_quarter}_${decl?.period_year}.xml`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Đã xuất file XML.');
    } catch {
      toast.error('Lỗi xuất XML. Vui lòng thử lại.');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!decl) {
    return (
      <div className="p-4 text-center text-gray-500">
        Không tìm thấy tờ khai.{' '}
        <button className="text-primary-600 underline" onClick={() => router.push('/declarations/pit')}>
          Quay lại
        </button>
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[decl.submission_status] ?? { label: decl.submission_status, color: 'bg-gray-100 text-gray-700' };
  const totalTax = numVal('ct32');

  return (
    <div className="p-4 max-w-3xl mx-auto pb-24">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={() => router.push('/declarations/pit')}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          title="Quay lại"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">
            05/KK-TNCN — Quý {decl.period_quarter}/{decl.period_year}
          </h1>
          <p className="text-xs text-gray-500">TK khấu trừ thuế thu nhập cá nhân</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>
          {statusInfo.label}
        </span>
      </div>

      {isLocked && (
        <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700">
          Tờ khai đã được nộp, không thể chỉnh sửa.
        </div>
      )}

      {/* Summary card */}
      <div className="mb-6 bg-white rounded-xl shadow-sm p-4 text-center">
        <p className="text-sm text-gray-500 mb-1">[32] Tổng thuế TNCN đã khấu trừ trong kỳ</p>
        <p className={`text-3xl font-bold ${totalTax > 0 ? 'text-red-600' : 'text-gray-400'}`}>
          {totalTax > 0 ? formatVND(totalTax) : '0 đ'}
        </p>
      </div>

      {/* Section I — Thông tin chung */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">
          I. Thông tin kê khai
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Loại tờ khai</label>
            <select
              value={String(fields.loai_tkhai)}
              onChange={(e) => handleChange('loai_tkhai', e.target.value)}
              disabled={isLocked}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            >
              <option value="C">Chính thức</option>
              <option value="BS">Bổ sung</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Lần bổ sung {fields.loai_tkhai !== 'BS' && <span className="text-gray-400">(N/A)</span>}
            </label>
            <input
              type="number"
              min={0}
              value={String(fields.so_lan)}
              onChange={(e) => handleChange('so_lan', e.target.value)}
              disabled={isLocked || fields.loai_tkhai !== 'BS'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Mã CQT nơi nộp</label>
            <input
              type="text"
              placeholder="VD: 70710"
              value={String(fields.ma_cqt_noi_nop)}
              onChange={(e) => handleChange('ma_cqt_noi_nop', e.target.value)}
              disabled={isLocked}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Tên CQT nơi nộp</label>
            <input
              type="text"
              placeholder="VD: Thuế cơ sở 7 tỉnh Đồng Nai"
              value={String(fields.ten_cqt_noi_nop)}
              onChange={(e) => handleChange('ten_cqt_noi_nop', e.target.value)}
              disabled={isLocked}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">MST cũ (nếu có)</label>
            <input
              type="text"
              placeholder="Để trống nếu không đổi MST"
              value={String(fields.mst_cu)}
              onChange={(e) => handleChange('mst_cu', e.target.value)}
              disabled={isLocked}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Người ký</label>
            <input
              type="text"
              placeholder="Tên người đại diện ký"
              value={String(fields.nguoi_ky)}
              onChange={(e) => handleChange('nguoi_ky', e.target.value)}
              disabled={isLocked}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
        </div>
      </div>

      {/* Section II — Chỉ tiêu kê khai */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
        <h2 className="font-semibold text-gray-800 mb-3 text-sm uppercase tracking-wide">
          II. Chỉ tiêu kê khai
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 pr-4 font-medium text-gray-600 w-full">Chỉ tiêu</th>
                <th className="text-right py-2 font-medium text-gray-600 min-w-[160px]">Giá trị</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {INDICATORS.map((row) => {
                const val  = numVal(row.code);
                const isAuto = row.isAutoCalc;
                return (
                  <tr
                    key={row.code}
                    className={`${row.isTotal ? 'bg-red-50 font-semibold' : ''} ${isAuto ? 'bg-gray-50' : ''}`}
                  >
                    <td className="py-2.5 pr-4 text-gray-700">
                      {row.label}
                      {isAuto && (
                        <span className="ml-1 text-xs text-gray-400">(tự động tính)</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      {isAuto || isLocked ? (
                        <span className={`${row.isTotal ? 'text-red-600' : 'text-gray-700'}`}>
                          {row.isMoney ? formatVND(val) : val.toLocaleString('vi-VN')}
                        </span>
                      ) : (
                        <input
                          type="number"
                          min={0}
                          value={String(fields[row.code] ?? 0)}
                          onChange={(e) => handleChange(row.code, e.target.value)}
                          className="w-40 border border-gray-300 rounded-lg px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Ghi chú</label>
        <textarea
          rows={3}
          placeholder="Ghi chú nội bộ (không xuất ra XML)..."
          value={String(fields.notes ?? '')}
          onChange={(e) => handleChange('notes', e.target.value)}
          disabled={isLocked}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 resize-none"
        />
      </div>

      {/* Action bar — fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-3 flex gap-3 z-40">
        {!isLocked && (
          <>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Đang lưu...' : 'Lưu'}
            </button>
            {decl.submission_status === 'draft' && (
              <button
                onClick={handleMarkReady}
                disabled={markingReady}
                className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {markingReady ? '...' : 'Hoàn thiện'}
              </button>
            )}
          </>
        )}
        <button
          onClick={handleDownloadXml}
          disabled={downloading}
          className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {downloading ? 'Đang xuất...' : 'Tải XML'}
        </button>
      </div>
    </div>
  );
}
