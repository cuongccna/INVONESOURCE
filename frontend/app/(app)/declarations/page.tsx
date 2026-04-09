'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import apiClient from '../../../lib/apiClient';
import { useToast } from '../../../components/ToastProvider';
import { formatVND } from '../../../utils/formatCurrency';
import { useCompany } from '../../../contexts/CompanyContext';

interface Declaration {
  id: string;
  period_month: number;
  period_year: number;
  period_type: string;  // 'monthly' | 'quarterly'
  status: string;
  ct40a: string;
  ct41: string;
  ct43: string;
  created_at: string;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Nháp',          color: 'bg-gray-100 text-gray-700' },
  ready:     { label: 'Hoàn thiện',    color: 'bg-blue-100 text-blue-700' },
  final:     { label: 'Hoàn thiện',    color: 'bg-blue-100 text-blue-700' },
  submitted: { label: 'Đã nộp',        color: 'bg-orange-100 text-orange-700' },
  accepted:  { label: 'GDT tiếp nhận', color: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Từ chối',       color: 'bg-red-100 text-red-700' },
};

export default function DeclarationsPage() {
  const router = useRouter();
  const toast = useToast();
  const [declarations, setDeclarations] = useState<Declaration[]>([]);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [showCalcModal, setShowCalcModal] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Declaration | null>(null);
  const [calcType, setCalcType]     = useState<'monthly' | 'quarterly'>('quarterly');
  const [calcMonth, setCalcMonth]   = useState(() => {
    const m = new Date().getMonth(); // 0-indexed: current month index
    return m === 0 ? 12 : m;         // default = previous month (Jan → Dec of prior year)
  });
  const [calcQuarter, setCalcQuarter] = useState(() => {
    const q = Math.ceil((new Date().getMonth() + 1) / 3);
    return q === 1 ? 4 : q - 1;      // default = previous quarter
  });
  const [calcYear, setCalcYear]     = useState(() => {
    const d = new Date();
    // If current month is Jan (monthly) or Q1 (quarterly), previous period is prior year
    return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
  });

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Declaration[] }>('/declarations');
      setDeclarations(res.data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  const { activeCompany, loading: companyLoading } = useCompany();

  useEffect(() => { void load(); }, [load]);

  // Redirect to HKD page when the active company is a household (Hộ KD)
  useEffect(() => {
    if (!companyLoading && activeCompany && activeCompany.company_type === 'household') {
      void router.push('/declarations/hkd');
    }
  }, [activeCompany, companyLoading, router]);

  const calculate = async () => {
    setCalculating(true);
    setShowCalcModal(false);
    try {
      const body = calcType === 'quarterly'
        ? { quarter: calcQuarter, year: calcYear }
        : { month: calcMonth,  year: calcYear };
      const { getApiCompanyId, getApiViewContext } = await import('../../../lib/apiClient');
      console.log('[CALC-DEBUG] sending calculate | activeCompanyId:', getApiCompanyId(), '| viewContext:', JSON.stringify(getApiViewContext()), '| body:', JSON.stringify(body));
      const res = await apiClient.post<{ data: Declaration & { id: string } }>('/declarations/calculate', body);
      console.log('[CALC-DEBUG] response id:', res.data.data.id, '| ct40a:', (res.data.data as unknown as Record<string, unknown>).ct40a_total_output_vat);
      toast.success('Đã tính toán tờ khai thành công');
      // Navigate to detail page so user immediately sees full calculated values
      router.push(`/declarations/${res.data.data.id}`);
    } catch {
      toast.error('Lỗi tính toán tờ khai. Vui lòng thử lại.');
    } finally {
      setCalculating(false);
    }
  };

  const downloadXml = async (id: string, month: number, year: number) => {
    try {
      const res = await apiClient.get(`/declarations/${id}/xml`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `01GTGT_${year}_${String(month).padStart(2, '0')}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải XML. Vui lòng thử lại.');
    }
  };

  const downloadExport = async (id: string, format: 'excel' | 'pdf', month: number, year: number) => {
    try {
      const mime = format === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
      const ext = format === 'excel' ? 'xlsx' : 'pdf';
      const res = await apiClient.get(`/declarations/${id}/export?format=${format}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `TK01GTGT_${year}_${String(month).padStart(2, '0')}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(`Lỗi tải ${format === 'excel' ? 'Excel' : 'PDF'}. Vui lòng thử lại.`);
    }
  };

  const handleDelete = async (decl: Declaration) => {
    setDeletingId(decl.id);
    setConfirmDelete(null);
    try {
      await apiClient.delete(`/declarations/${decl.id}`);
      toast.success('Đã xóa tờ khai.');
      setDeclarations(prev => prev.filter(d => d.id !== decl.id));
    } catch {
      toast.error('Lỗi xóa tờ khai. Vui lòng thử lại.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tờ Khai Thuế</h1>
          <p className="text-sm text-gray-500 mt-1">01/GTGT — Kê khai thuế GTGT</p>
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

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : declarations.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Chưa có tờ khai nào</p>
          <p className="text-sm">Nhấn &quot;+ Tính Mới&quot; để tính toán</p>
        </div>
      ) : (
        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {declarations.map((decl) => {
            const statusInfo = STATUS_LABELS[decl.status] ?? { label: decl.status, color: 'bg-gray-100 text-gray-700' };
            const payable = Number(decl.ct41);
            const carryFwd = Number(decl.ct43);
            return (
              <div
                key={decl.id}
                className="bg-white rounded-xl shadow-sm p-4 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => router.push(`/declarations/${decl.id}`)}
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-bold text-gray-900">
                      {decl.period_type === 'quarterly'
                        ? `Quý ${decl.period_month}/${decl.period_year}`
                        : `Tháng ${decl.period_month}/${decl.period_year}`
                      }
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
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(decl); }}
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
                    <p className="text-xs text-gray-400">[40a] Đầu Ra</p>
                    <p className="font-bold text-sm text-blue-600">
                      {formatVND(decl.ct40a)}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400">[41] Phải Nộp</p>
                    <p className={`font-bold text-sm ${payable > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      {payable > 0 ? formatVND(payable) : '—'}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-gray-400">[43] Chuyển Kỳ</p>
                    <p className={`font-bold text-sm ${carryFwd > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                      {carryFwd > 0 ? formatVND(carryFwd) : '—'}
                    </p>
                  </div>
                </div>

                <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs text-gray-700 font-medium divide-x divide-gray-300">
                  <button
                    onClick={(e) => { e.stopPropagation(); void downloadXml(decl.id, decl.period_month, decl.period_year); }}
                    className="flex-1 py-2 hover:bg-gray-50"
                  >
                    📄 XML
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void downloadExport(decl.id, 'excel', decl.period_month, decl.period_year); }}
                    className="flex-1 py-2 hover:bg-gray-50"
                  >
                    📊 Excel
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); void downloadExport(decl.id, 'pdf', decl.period_month, decl.period_year); }}
                    className="flex-1 py-2 hover:bg-gray-50"
                  >
                    🖨️ PDF
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Confirm delete modal ── */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <h2 className="font-bold text-gray-900 text-lg">Xóa tờ khai?</h2>
            <p className="text-sm text-gray-600">
              Bạn có chắc chắn muốn xóa tờ khai{' '}
              <strong>
                {confirmDelete.period_type === 'quarterly'
                  ? `Quý ${confirmDelete.period_month}/${confirmDelete.period_year}`
                  : `Tháng ${confirmDelete.period_month}/${confirmDelete.period_year}`}
              </strong>?
              Hành động này không thể hoàn tác.
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 border border-gray-300 rounded-lg py-2.5 text-sm font-medium text-gray-700"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleDelete(confirmDelete)}
                className="flex-1 bg-red-600 text-white rounded-lg py-2.5 text-sm font-medium"
              >
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Calc period modal ── */}
      {showCalcModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-gray-900">Tính tờ khai mới</h2>
              <button onClick={() => setShowCalcModal(false)} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
            </div>

            {/* Toggle monthly / quarterly */}
            <div className="flex rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setCalcType('monthly')}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${calcType === 'monthly' ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                📅 Hàng tháng
              </button>
              <button
                onClick={() => setCalcType('quarterly')}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${calcType === 'quarterly' ? 'bg-primary-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                📊 Theo quý
              </button>
            </div>

            <div className="space-y-3">
              {calcType === 'monthly' ? (
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Tháng</label>
                  <select
                    value={calcMonth}
                    onChange={e => setCalcMonth(Number(e.target.value))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => (
                      <option key={m} value={m}>Tháng {m}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Quý</label>
                  <select
                    value={calcQuarter}
                    onChange={e => setCalcQuarter(Number(e.target.value))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    <option value={1}>Quý 1 (Tháng 1–3)</option>
                    <option value={2}>Quý 2 (Tháng 4–6)</option>
                    <option value={3}>Quý 3 (Tháng 7–9)</option>
                    <option value={4}>Quý 4 (Tháng 10–12)</option>
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">Năm</label>
                <select
                  value={calcYear}
                  onChange={e => setCalcYear(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  {[2024, 2025, 2026, 2027].map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowCalcModal(false)}
                className="flex-1 border border-gray-300 rounded-xl py-2.5 text-sm">
                Hủy
              </button>
              <button onClick={calculate}
                className="flex-1 bg-primary-600 text-white rounded-xl py-2.5 text-sm font-medium">
                Tính toán
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
