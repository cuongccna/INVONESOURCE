'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import { formatVND } from '../../../../utils/formatCurrency';
import { useRouter } from 'next/navigation';
import { useCompany } from '../../../../contexts/CompanyContext';

interface HkdDeclaration {
  id: string;
  period_quarter: number;
  period_year: number;
  revenue_m1: number;
  revenue_m2: number;
  revenue_m3: number;
  revenue_total: number;
  vat_rate: number;
  vat_m1: number;
  vat_m2: number;
  vat_m3: number;
  vat_total: number;
  pit_m1: number;
  pit_m2: number;
  pit_m3: number;
  pit_total: number;
  total_payable: number;
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

const QUARTER_MONTHS: Record<number, string> = {
  1: 'T1–T3', 2: 'T4–T6', 3: 'T7–T9', 4: 'T10–T12',
};

export default function HkdDeclarationsPage() {
  const toast = useToast();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [declarations, setDeclarations] = useState<HkdDeclaration[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HkdDeclaration | null>(null);
  const [showCalcModal, setShowCalcModal] = useState(false);
  const [calcQuarter, setCalcQuarter] = useState<number>(() => Math.ceil((new Date().getMonth() + 1) / 3));
  const [calcYear, setCalcYear] = useState(currentYear);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: HkdDeclaration[] }>(`/hkd/declarations?year=${year}`);
      setDeclarations(res.data.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => { void load(); }, [load]);

  const { activeCompany, loading: companyLoading } = useCompany();
  const router = useRouter();

  // If active company is NOT household, redirect to DN declarations
  useEffect(() => {
    if (!companyLoading && activeCompany && activeCompany.company_type !== 'household') {
      void router.push('/declarations');
    }
  }, [activeCompany, companyLoading, router]);

  const calculate = async () => {
    setCalculating(true);
    setShowCalcModal(false);
    try {
      await apiClient.post('/hkd/declarations', { quarter: calcQuarter, year: calcYear });
      toast.success('Đã tính tờ khai HKD thành công');
      setYear(calcYear);
      await load();
    } catch {
      toast.error('Lỗi tính tờ khai. Vui lòng thử lại.');
    } finally {
      setCalculating(false);
    }
  };

  const handleDelete = async (decl: HkdDeclaration) => {
    setDeletingId(decl.id);
    setConfirmDelete(null);
    try {
      await apiClient.delete(`/hkd/declarations/${decl.id}`);
      toast.success('Đã xóa tờ khai.');
      setDeclarations(prev => prev.filter(d => d.id !== decl.id));
    } catch {
      toast.error('Lỗi xóa tờ khai.');
    } finally {
      setDeletingId(null);
    }
  };

  const downloadXml = async (decl: HkdDeclaration) => {
    try {
      const res = await apiClient.get(`/hkd/declarations/${decl.id}/xml`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `TT40_Q${decl.period_quarter}_${decl.period_year}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải XML.');
    }
  };

  const downloadExport = async (decl: HkdDeclaration, format: 'excel' | 'pdf') => {
    try {
      const mime = format === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
      const ext = format === 'excel' ? 'xlsx' : 'pdf';
      const res = await apiClient.get(`/hkd/declarations/${decl.id}/export?format=${format}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `TT40_Q${decl.period_quarter}_${decl.period_year}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(`Lỗi tải ${format === 'excel' ? 'Excel' : 'PDF'}.`);
    }
  };

  const m1OfQ = (q: number) => (q - 1) * 3 + 1;

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tờ Khai Thuế HKD</h1>
          <p className="text-sm text-gray-500 mt-1">TT40/2021 — Hộ kinh doanh / cá nhân kinh doanh</p>
        </div>
        <button
          onClick={() => setShowCalcModal(true)}
          disabled={calculating}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {calculating ? 'Đang tính...' : '+ Tính Mới'}
        </button>
      </div>

      {/* Form type is implied by active company; toggle removed */}

      {/* Year selector */}
      <div className="flex gap-2 mb-4">
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white">
          {[currentYear - 1, currentYear, currentYear + 1].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : declarations.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Chưa có tờ khai nào</p>
          <p className="text-sm">Nhấn &quot;+ Tính Mới&quot; để tính tờ khai quý</p>
        </div>
      ) : (
        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {declarations.map((decl) => {
            const statusInfo = STATUS_LABELS[decl.submission_status] ?? { label: decl.submission_status, color: 'bg-gray-100 text-gray-700' };
            const isExpanded = expandedId === decl.id;
            const m1 = m1OfQ(decl.period_quarter);
            const m2 = m1 + 1;
            const m3 = m1 + 2;
            return (
              <div key={decl.id} className="bg-white rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-bold text-gray-900">
                      Quý {decl.period_quarter}/{decl.period_year}
                      <span className="ml-2 text-xs font-normal text-gray-400">({QUARTER_MONTHS[decl.period_quarter]})</span>
                    </p>
                    <p className="text-xs text-gray-400">
                      Tạo: {new Date(decl.created_at).toLocaleDateString('vi-VN')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                    <button
                      onClick={() => setConfirmDelete(decl)}
                      disabled={deletingId === decl.id}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                      title="Xóa tờ khai"
                    >
                      {deletingId === decl.id
                        ? <span className="text-xs">...</span>
                        : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      }
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="text-center">
                    <p className="text-xs text-gray-400">Doanh thu</p>
                    <p className="font-bold text-sm text-blue-600">{formatVND(decl.revenue_total)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400">Thuế GTGT</p>
                    <p className="font-bold text-sm text-orange-600">{formatVND(decl.vat_total)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400">Tổng phải nộp</p>
                    <p className="font-bold text-sm text-red-600">{formatVND(decl.total_payable)}</p>
                  </div>
                </div>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : decl.id)}
                  className="w-full text-xs text-gray-500 hover:text-gray-800 py-1 mb-2"
                >
                  {isExpanded ? '▲ Ẩn chi tiết tháng' : '▼ Xem chi tiết tháng'}
                </button>
                {isExpanded && (
                  <div className="mb-3 text-xs border border-gray-100 rounded-lg overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-left p-2 font-medium text-gray-600">Chỉ tiêu</th>
                          <th className="text-right p-2 font-medium">T{m1}</th>
                          <th className="text-right p-2 font-medium">T{m2}</th>
                          <th className="text-right p-2 font-medium">T{m3}</th>
                          <th className="text-right p-2 font-medium">Tổng</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-gray-100">
                          <td className="p-2 text-gray-600">DT GTGT</td>
                          <td className="p-2 text-right">{formatVND(decl.revenue_m1)}</td>
                          <td className="p-2 text-right">{formatVND(decl.revenue_m2)}</td>
                          <td className="p-2 text-right">{formatVND(decl.revenue_m3)}</td>
                          <td className="p-2 text-right font-semibold">{formatVND(decl.revenue_total)}</td>
                        </tr>
                        <tr className="border-t border-gray-100">
                          <td className="p-2 text-gray-600">Thuế GTGT ({decl.vat_rate}%)</td>
                          <td className="p-2 text-right">{formatVND(decl.vat_m1)}</td>
                          <td className="p-2 text-right">{formatVND(decl.vat_m2)}</td>
                          <td className="p-2 text-right">{formatVND(decl.vat_m3)}</td>
                          <td className="p-2 text-right font-semibold text-orange-600">{formatVND(decl.vat_total)}</td>
                        </tr>
                        <tr className="border-t border-gray-100">
                          <td className="p-2 text-gray-600">Thuế TNCN (0.5%)</td>
                          <td className="p-2 text-right">{formatVND(decl.pit_m1)}</td>
                          <td className="p-2 text-right">{formatVND(decl.pit_m2)}</td>
                          <td className="p-2 text-right">{formatVND(decl.pit_m3)}</td>
                          <td className="p-2 text-right font-semibold">{formatVND(decl.pit_total)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs text-gray-700 font-medium divide-x divide-gray-300">
                  <button onClick={() => void downloadXml(decl)} className="flex-1 py-2 hover:bg-gray-50">📄 XML</button>
                  <button onClick={() => void downloadExport(decl, 'excel')} className="flex-1 py-2 hover:bg-gray-50">📊 Excel</button>
                  <button onClick={() => void downloadExport(decl, 'pdf')} className="flex-1 py-2 hover:bg-gray-50">🖨️ PDF</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <h2 className="font-bold text-gray-900 text-lg">Xóa tờ khai?</h2>
            <p className="text-sm text-gray-600">
              Bạn có chắc chắn muốn xóa tờ khai{' '}
              <strong>Quý {confirmDelete.period_quarter}/{confirmDelete.period_year}</strong>?
              Hành động này không thể hoàn tác.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 border border-gray-300 rounded-lg py-2.5 text-sm font-medium text-gray-700">
                Hủy
              </button>
              <button onClick={() => void handleDelete(confirmDelete)}
                className="flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-medium">
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}

      {showCalcModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900">Tính tờ khai HKD mới</h2>
              <button onClick={() => setShowCalcModal(false)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Quý</label>
                <select value={calcQuarter} onChange={e => setCalcQuarter(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  <option value={1}>Quý 1 (Tháng 1–3)</option>
                  <option value={2}>Quý 2 (Tháng 4–6)</option>
                  <option value={3}>Quý 3 (Tháng 7–9)</option>
                  <option value={4}>Quý 4 (Tháng 10–12)</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Năm</label>
                <select value={calcYear} onChange={e => setCalcYear(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                  {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCalcModal(false)}
                className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">Hủy</button>
              <button onClick={() => void calculate()}
                className="flex-1 bg-primary-600 text-white rounded-xl py-2.5 text-sm font-medium">Tính toán</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
