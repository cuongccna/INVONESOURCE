'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import BackButton from '../../../../components/BackButton';
import { formatVNDFull } from '../../../../utils/formatCurrency';

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface Declaration {
  id: string;
  period_month: number;
  period_year: number;
  period_type: string;
  form_type: string;
  submission_status: string;
  ct22_total_input_vat: number;
  ct23_deductible_input_vat: number;
  ct23_input_subtotal: number;
  ct24_carried_over_vat: number;
  ct25_total_deductible: number;
  ct29_total_revenue: number;
  ct30_exempt_revenue: number;
  ct32_revenue_5pct: number;
  ct33_vat_5pct: number;
  ct34_revenue_8pct: number;
  ct35_vat_8pct: number;
  ct36_revenue_10pct: number;
  ct37_vat_10pct: number;
  ct36_nq_vat_reduction: number;
  ct40_total_output_revenue: number;
  ct40a_total_output_vat: number;
  ct41_payable_vat: number;
  ct43_carry_forward_vat: number;
  notes: string | null;
  submission_at: string | null;
  gdt_reference_number: string | null;
  created_at: string;
  updated_at: string;
}

/* ─── Constants ───────────────────────────────────────────────────────────── */
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Nháp',          color: 'bg-gray-100 text-gray-700' },
  ready:     { label: 'Hoàn thiện',    color: 'bg-blue-100 text-blue-700' },
  submitted: { label: 'Đã nộp',        color: 'bg-orange-100 text-orange-700' },
  accepted:  { label: 'GDT tiếp nhận', color: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Từ chối',       color: 'bg-red-100 text-red-700' },
};

/* ─── Formatter ──────────────────────────────────────────────────────────── */
const vnd = (n: number | string | undefined) =>
  formatVNDFull(Number(n ?? 0));

/* ─── Row component ──────────────────────────────────────────────────────── */
function Row({
  code, label, value, highlight,
}: {
  code: string; label: string; value: number; highlight?: 'red' | 'green' | 'bold';
}) {
  const valueColor =
    highlight === 'red' && value > 0
      ? 'text-red-600 font-bold'
      : highlight === 'green' && value > 0
      ? 'text-green-600 font-bold'
      : highlight === 'bold'
      ? 'font-semibold text-gray-900'
      : 'text-gray-900';

  return (
    <tr className="border-b border-gray-50 hover:bg-gray-50/50">
      <td className="py-2 pr-3 w-12">
        <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">
          [{code}]
        </span>
      </td>
      <td className="py-2 pr-3 text-sm text-gray-600 leading-snug">{label}</td>
      <td className={`py-2 text-right text-sm tabular-nums ${valueColor}`}>
        {vnd(value)}
      </td>
    </tr>
  );
}

/* ─── Section separator ──────────────────────────────────────────────────── */
function Section({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={3} className="pt-4 pb-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{label}</p>
      </td>
    </tr>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────────── */
export default function DeclarationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [decl, setDecl] = useState<Declaration | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [marking, setMarking] = useState(false);
  const [submittingTvan, setSubmittingTvan] = useState(false);
  const [showTvanConfirm, setShowTvanConfirm] = useState(false);
  const [tvanResult, setTvanResult] = useState<{ submissionId: string; status: string; message?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'form' | 'pl011' | 'pl012'>('form');
  const [editingOB, setEditingOB] = useState(false);
  const [obInput, setObInput] = useState('');
  const [savingOB, setSavingOB] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: Declaration }>(`/declarations/${params.id}`);
      const d = res.data.data;
      console.log('[DETAIL-DEBUG] declaration loaded:', { id: d.id, ct40a: d.ct40a_total_output_vat, ct23: d.ct23_deductible_input_vat, ct41: d.ct41_payable_vat, ct43: d.ct43_carry_forward_vat });
      setDecl(d);
    } catch {
      router.replace('/declarations');
    } finally {
      setLoading(false);
    }
  }, [params.id, router]);

  useEffect(() => { void load(); }, [load]);

  const downloadXml = async () => {
    if (!decl) return;
    setDownloading(true);
    try {
      const res = await apiClient.get(`/declarations/${decl.id}/xml`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `01GTGT_T${String(decl.period_month).padStart(2,'0')}${decl.period_year}_${decl.id.slice(0,8)}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải XML. Vui lòng thử lại.');
    } finally {
      setDownloading(false);
    }
  };

  const downloadExport = async (format: 'excel' | 'pdf') => {
    if (!decl) return;
    setDownloading(true);
    try {
      const mime = format === 'excel'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf';
      const ext  = format === 'excel' ? 'xlsx' : 'pdf';
      const res  = await apiClient.get(`/declarations/${decl.id}/export?format=${format}`, { responseType: 'blob' });
      const url  = URL.createObjectURL(new Blob([res.data as BlobPart], { type: mime }));
      const a    = document.createElement('a');
      a.href = url;
      a.download = `TK01GTGT_T${String(decl.period_month).padStart(2,'0')}${decl.period_year}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(`Lỗi tải ${format === 'excel' ? 'Excel' : 'PDF'}. Vui lòng thử lại.`);
    } finally {
      setDownloading(false);
    }
  };

  const downloadExcel = async (type: 'pl011' | 'pl012') => {
    if (!decl) return;
    try {
      const path = type === 'pl011' ? 'pl011' : 'pl012';
      const res = await apiClient.get(
        `/reports/${path}?month=${decl.period_month}&year=${decl.period_year}`,
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(
        new Blob([res.data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `${type.toUpperCase()}_T${String(decl.period_month).padStart(2,'0')}${decl.period_year}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải bảng kê. Vui lòng thử lại.');
    }
  };

  const saveOpeningBalance = async () => {
    if (!decl) return;
    const raw = obInput.replace(/[^0-9]/g, '');
    const val = parseInt(raw || '0', 10);
    setSavingOB(true);
    try {
      // Use PATCH response directly to update state — instant recompute of ct25/ct41/ct43
      const res = await apiClient.patch<{ data: Declaration }>(
        `/declarations/${decl.id}/opening-balance`,
        { opening_balance: val }
      );
      setDecl(res.data.data);
      setEditingOB(false);
      toast.success('Đã lưu số đầu kỳ');
    } catch {
      toast.error('Lỗi lưu số đầu kỳ. Vui lòng thử lại.');
    } finally {
      setSavingOB(false);
    }
  };

  const markReady = async () => {
    if (!decl) return;
    setMarking(true);
    try {
      await apiClient.patch(`/declarations/${decl.id}/status`, { status: 'ready' });
      toast.success('Đã cập nhật trạng thái tờ khai');
      await load();
    } catch {
      toast.error('Lỗi cập nhật trạng thái.');
    } finally {
      setMarking(false);
    }
  };

  const submitTvan = async () => {
    if (!decl) return;
    setShowTvanConfirm(false);
    setSubmittingTvan(true);
    setTvanResult(null);
    try {
      const res = await apiClient.post<{ data: { submissionId: string; status: string; message?: string } }>(
        `/declarations/${decl.id}/submit-tvan`,
        {}
      );
      setTvanResult(res.data.data);
      await load();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: { message?: string } } } })
        ?.response?.data?.error?.message ?? 'Lỗi nộp qua T-VAN. Vui lòng thử lại.';
      toast.error(msg);
    } finally {
      setSubmittingTvan(false);
    }
  };

  // For quarterly: period_month = quarter (1-4). Deadline = 20th of month after quarter end.
  // Q1 ends March (3) → Apr 20; Q2→Jul 20; Q3→Oct 20; Q4→Jan 20 next year.
  // JS Date handles month overflow: new Date(year, 12, 20) → Jan 20 next year.
  const deadline20 = decl
    ? decl.period_type === 'quarterly'
      ? new Date(decl.period_year, decl.period_month * 3, 20)  // endMonth=Q*3, then +1 implicit via index
      : new Date(decl.period_year, decl.period_month, 20)       // monthly: period_month=month, next month
    : null;
  // Display month for deadline warning (1-based)
  const deadlineDisplayMonth = decl
    ? decl.period_type === 'quarterly'
      ? (decl.period_month * 3 + 1) > 12 ? 1 : decl.period_month * 3 + 1
      : decl.period_month + 1 > 12 ? 1 : decl.period_month + 1
    : null;
  const deadlineDisplayYear = decl
    ? decl.period_type === 'quarterly'
      ? (decl.period_month * 3 + 1) > 12 ? decl.period_year + 1 : decl.period_year
      : decl.period_month + 1 > 12 ? decl.period_year + 1 : decl.period_year
    : null;
  const daysLeft = deadline20
    ? Math.ceil((deadline20.getTime() - Date.now()) / 86_400_000)
    : null;
  const deadlineWarning = daysLeft !== null && daysLeft <= 7 && daysLeft >= 0;

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (!decl) return null;

  const statusCfg = STATUS_CONFIG[decl.submission_status] ?? { label: decl.submission_status, color: 'bg-gray-100 text-gray-700' };

  return (
    <div className="max-w-2xl lg:max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 mb-2">
        <BackButton fallbackHref="/declarations" />
        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">
            Tờ khai {decl.form_type} —{' '}
            {decl.period_type === 'quarterly'
              ? `Quý ${decl.period_month}/${decl.period_year}`
              : `Tháng ${decl.period_month}/${decl.period_year}`}
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Tạo: {new Date(decl.created_at).toLocaleDateString('vi-VN')}
            {decl.gdt_reference_number && (
              <span className="ml-2 font-medium text-green-700">Mã GDT: {decl.gdt_reference_number}</span>
            )}
          </p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusCfg.color}`}>
          {statusCfg.label}
        </span>
      </div>

      {/* ── Warnings ── */}
      {deadlineWarning && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <span className="text-lg">📅</span>
          <p className="text-sm text-orange-700">
            <strong>Sắp đến hạn!</strong> Còn {daysLeft} ngày đến hạn nộp (ngày 20/{deadlineDisplayMonth}/{deadlineDisplayYear}).
          </p>
        </div>
      )}

      {decl.ct41_payable_vat > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <span className="text-lg">💰</span>
          <p className="text-sm text-red-700">
            Phải nộp thuế GTGT: <strong className="text-red-800">{vnd(decl.ct41_payable_vat)}</strong>
          </p>
        </div>
      )}
      {decl.ct43_carry_forward_vat > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <span className="text-lg">✅</span>
          <p className="text-sm text-green-700">
            Kết chuyển sang kỳ sau: <strong className="text-green-800">{vnd(decl.ct43_carry_forward_vat)}</strong>
          </p>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl">
        {(['form', 'pl011', 'pl012'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 text-xs font-medium py-2 rounded-lg transition-colors ${
              activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'form' ? 'Mẫu 01/GTGT' : tab === 'pl011' ? 'PL01-1 Bán ra' : 'PL01-2 Mua vào'}
          </button>
        ))}
      </div>

      {/* ── Form 01/GTGT ── */}
      {activeTab === 'form' && (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <table className="w-full px-4">
            <tbody className="divide-y divide-transparent px-4">
              {/* ─ Section I: Thuế đầu vào ─ */}
              <tr><td colSpan={3} className="px-4 pt-4 pb-1">
                <p className="text-xs font-semibold text-primary-700 uppercase tracking-wider">I. Thuế đầu vào</p>
              </td></tr>
              {/* ── [22] row: display + inline pencil edit trigger ── */}
              <tr className={`border-b ${editingOB ? 'border-primary-100 bg-primary-50/30' : 'border-gray-50 hover:bg-gray-50/50'}`}>
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[22]</span>
                </td>
                <td className="py-2 pr-3 text-sm text-gray-600 leading-snug">
                  Thuế GTGT còn được khấu trừ kỳ trước chuyển sang
                </td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums">
                  <div className="flex items-center justify-end gap-2">
                    <span className={decl.ct24_carried_over_vat === 0 ? 'text-gray-400' : 'text-gray-900'}>
                      {vnd(decl.ct24_carried_over_vat)}
                    </span>
                    {!editingOB && !['submitted', 'accepted'].includes(decl.submission_status) && (
                      <button
                        onClick={() => { setObInput(String(decl.ct24_carried_over_vat || '')); setEditingOB(true); }}
                        title="Nhập số đầu kỳ"
                        className="flex-shrink-0 text-gray-300 hover:text-primary-500 transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {/* ── [22] edit form: spans full width, mobile-friendly ── */}
              {editingOB && (
                <tr>
                  <td colSpan={3} className="px-4 pb-3 pt-2">
                    <div className="flex items-center gap-2 bg-white border border-primary-300 rounded-xl px-3 py-2.5 shadow-sm">
                      <label className="text-xs text-primary-700 font-medium whitespace-nowrap flex-shrink-0">Số đầu kỳ:</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2.5 py-1.5 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400"
                        value={obInput}
                        onChange={e => setObInput(e.target.value.replace(/[^0-9]/g, ''))}
                        onKeyDown={e => { if (e.key === 'Enter') void saveOpeningBalance(); if (e.key === 'Escape') setEditingOB(false); }}
                        autoFocus
                        placeholder="0"
                      />
                      <button
                        onClick={() => void saveOpeningBalance()}
                        disabled={savingOB}
                        className="flex-shrink-0 px-3 py-1.5 bg-primary-600 text-white rounded-lg text-xs font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors"
                      >
                        {savingOB ? '…' : 'Lưu'}
                      </button>
                      <button
                        onClick={() => setEditingOB(false)}
                        className="flex-shrink-0 px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200 transition-colors"
                      >
                        Huỷ
                      </button>
                    </div>
                  </td>
                </tr>
              )}
              {/* Opening balance hint for new users */}
              {decl.ct24_carried_over_vat === 0 && !editingOB && !['submitted','accepted'].includes(decl.submission_status) && (
                <tr>
                  <td colSpan={3} className="px-4 pb-2 pt-0">
                    <button
                      onClick={() => { setObInput(''); setEditingOB(true); }}
                      className="text-xs text-primary-600 hover:text-primary-700 underline underline-offset-2"
                    >
                      + Nhập số đầu kỳ (nếu doanh nghiệp đang chuyển từ hệ thống khác)
                    </button>
                  </td>
                </tr>
              )}
              <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[23]</span>
                </td>
                <td className="py-2 pr-3 text-sm text-gray-600">Giá trị HHDV mua vào trong kỳ (chưa thuế)</td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(decl.ct23_input_subtotal)}</td>
              </tr>
              <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[24]</span>
                </td>
                <td className="py-2 pr-3 text-sm text-gray-600">Thuế GTGT HHDV mua vào đủ điều kiện khấu trừ</td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums font-semibold text-gray-900">{vnd(decl.ct23_deductible_input_vat)}</td>
              </tr>
              <tr className="border-b border-gray-100 hover:bg-gray-50/50">
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-primary-100 text-primary-700 px-1.5 py-0.5 rounded font-mono font-bold">[25]</span>
                </td>
                <td className="py-2 pr-3 text-sm font-semibold text-gray-700">Tổng thuế đầu vào được khấu trừ = [22]+[24]</td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums font-bold text-gray-900">{vnd(decl.ct25_total_deductible)}</td>
              </tr>
              {/* Group 6/8 info note */}
              <tr>
                <td colSpan={3} className="px-4 py-2">
                  <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-700">
                    <strong>Lưu ý:</strong> Hóa đơn nhóm 6 (không có mã CQT — tiêu thức Header) và nhóm 8 (máy tính tiền) được
                    khấu trừ thuế đầu vào mà không cần xác minh GDT. Vui lòng kiểm tra kỹ các hóa đơn này trước khi nộp tờ khai.
                  </div>
                </td>
              </tr>

              {/* ─ Section II: Doanh thu & Thuế đầu ra ─ */}
              <tr><td colSpan={3} className="px-4 pt-5 pb-1">
                <p className="text-xs font-semibold text-primary-700 uppercase tracking-wider">II. Doanh thu &amp; Thuế đầu ra</p>
              </td></tr>
              {decl.ct30_exempt_revenue > 0 && (
                <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="py-2 pr-3 w-12 pl-4">
                    <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[26]</span>
                  </td>
                  <td className="py-2 pr-3 text-sm text-gray-600">HHDV không chịu thuế GTGT</td>
                  <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(decl.ct30_exempt_revenue)}</td>
                </tr>
              )}
              {(decl.ct32_revenue_5pct > 0 || decl.ct33_vat_5pct > 0) && (<>
                <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="py-2 pr-3 w-12 pl-4">
                    <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[30]</span>
                  </td>
                  <td className="py-2 pr-3 text-sm text-gray-600">Doanh thu HHDV thuế suất 5%</td>
                  <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(decl.ct32_revenue_5pct)}</td>
                </tr>
                <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                  <td className="py-2 pr-3 w-12 pl-4">
                    <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[31]</span>
                  </td>
                  <td className="py-2 pr-3 text-sm text-gray-600">Thuế GTGT 5%</td>
                  <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(decl.ct33_vat_5pct)}</td>
                </tr>
              </>)}
              {/* 10% group (gộp 8%+10% per NQ142) */}
              {(() => {
                const rev10 = decl.ct36_revenue_10pct + decl.ct34_revenue_8pct;
                const vat10 = decl.ct37_vat_10pct + decl.ct35_vat_8pct;
                if (rev10 === 0 && vat10 === 0) return null;
                return (<>
                  <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="py-2 pr-3 w-12 pl-4">
                      <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[32]</span>
                    </td>
                    <td className="py-2 pr-3 text-sm text-gray-600">
                      Doanh thu HHDV thuế suất 10%
                      {decl.ct34_revenue_8pct > 0 && (
                        <span className="ml-1.5 text-xs text-amber-600">(bao gồm {vnd(decl.ct34_revenue_8pct)} tạm giảm 8% theo NQ)</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(rev10)}</td>
                  </tr>
                  <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="py-2 pr-3 w-12 pl-4">
                      <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono">[33]</span>
                    </td>
                    <td className="py-2 pr-3 text-sm text-gray-600">Thuế GTGT 10%</td>
                    <td className="py-2 pr-4 text-right text-sm tabular-nums text-gray-900">{vnd(vat10)}</td>
                  </tr>
                </>);
              })()}
              <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-primary-100 text-primary-700 px-1.5 py-0.5 rounded font-mono font-bold">[34]</span>
                </td>
                <td className="py-2 pr-3 text-sm font-semibold text-gray-700">Tổng doanh thu HHDV bán ra</td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums font-bold text-gray-900">{vnd(decl.ct40_total_output_revenue)}</td>
              </tr>
              <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                <td className="py-2 pr-3 w-12 pl-4">
                  <span className="text-xs bg-primary-100 text-primary-700 px-1.5 py-0.5 rounded font-mono font-bold">[35]</span>
                </td>
                <td className="py-2 pr-3 text-sm font-semibold text-gray-700">Tổng thuế GTGT đầu ra (trước điều chỉnh NQ)</td>
                <td className="py-2 pr-4 text-right text-sm tabular-nums font-bold text-gray-900">{vnd(decl.ct40a_total_output_vat)}</td>
              </tr>
              {(() => {
                const nq = Number(decl.ct36_nq_vat_reduction ?? 0);
                if (nq === 0) return null;
                return (
                  <tr className="border-b border-amber-50 bg-amber-50/30 hover:bg-amber-50/60">
                    <td className="py-2 pr-3 w-12 pl-4">
                      <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-mono font-bold">[36]</span>
                    </td>
                    <td className="py-2 pr-3 text-sm text-amber-800">Giảm thuế GTGT theo NQ142/NQ204 (2% × DT 8%)</td>
                    <td className="py-2 pr-4 text-right text-sm tabular-nums font-semibold text-amber-700">− {vnd(nq)}</td>
                  </tr>
                );
              })()}
              {(() => {
                const nq = Number(decl.ct36_nq_vat_reduction ?? 0);
                if (nq === 0) return null;
                const adj = decl.ct40a_total_output_vat - nq;
                return (
                  <tr className="border-b border-gray-100 hover:bg-gray-50/50">
                    <td className="py-2 pr-3 w-12 pl-4">
                      <span className="text-xs bg-primary-100 text-primary-700 px-1.5 py-0.5 rounded font-mono font-bold">[40a]</span>
                    </td>
                    <td className="py-2 pr-3 text-sm font-semibold text-gray-700">Tổng thuế đầu ra sau điều chỉnh NQ = [35]−[36]</td>
                    <td className="py-2 pr-4 text-right text-sm tabular-nums font-bold text-gray-900">{vnd(adj)}</td>
                  </tr>
                );
              })()}

              {/* ─ Section III: Kết quả ─ */}
              <tr><td colSpan={3} className="px-4 pt-5 pb-1">
                <p className="text-xs font-semibold text-primary-700 uppercase tracking-wider">III. Kết quả</p>
              </td></tr>
              <tr className={`border-b border-gray-100 ${decl.ct41_payable_vat > 0 ? 'bg-red-50/50' : ''}`}>
                <td className="py-3 pr-3 w-12 pl-4">
                  <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-mono font-bold">[41]</span>
                </td>
                <td className="py-3 pr-3 text-sm font-semibold text-gray-700">
                  Thuế GTGT còn phải nộp = [40a] − [25]
                </td>
                <td className={`py-3 pr-4 text-right text-base tabular-nums font-bold ${decl.ct41_payable_vat > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                  {vnd(decl.ct41_payable_vat)}
                </td>
              </tr>
              <tr className={`${decl.ct43_carry_forward_vat > 0 ? 'bg-green-50/50' : ''}`}>
                <td className="py-3 pr-3 w-12 pl-4">
                  <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-mono font-bold">[43]</span>
                </td>
                <td className="py-3 pr-3 text-sm font-semibold text-gray-700">
                  Thuế GTGT kết chuyển sang kỳ sau = [25] − [40a]
                </td>
                <td className={`py-3 pr-4 text-right text-base tabular-nums font-bold ${decl.ct43_carry_forward_vat > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                  {vnd(decl.ct43_carry_forward_vat)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── PL01-1 Tab ── */}
      {activeTab === 'pl011' && (
        <div className="bg-white rounded-xl border border-gray-100 p-6 text-center space-y-4">
          <div className="text-4xl">📋</div>
          <p className="text-sm font-semibold text-gray-900">Bảng kê hoá đơn bán ra (Phụ lục 01-1)</p>
          <p className="text-sm text-gray-500">
            Tháng {decl.period_month}/{decl.period_year} — Danh sách hóa đơn đầu ra
          </p>
          <button
            onClick={() => void downloadExcel('pl011')}
            className="inline-flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-green-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Tải Excel PL01-1
          </button>
        </div>
      )}

      {/* ── PL01-2 Tab ── */}
      {activeTab === 'pl012' && (
        <div className="bg-white rounded-xl border border-gray-100 p-6 text-center space-y-4">
          <div className="text-4xl">📋</div>
          <p className="text-sm font-semibold text-gray-900">Bảng kê hoá đơn mua vào (Phụ lục 01-2)</p>
          <p className="text-sm text-gray-500">
            Tháng {decl.period_month}/{decl.period_year} — Danh sách hóa đơn đầu vào
          </p>
          <button
            onClick={() => void downloadExcel('pl012')}
            className="inline-flex items-center gap-2 bg-green-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-green-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Tải Excel PL01-2
          </button>
        </div>
      )}

      {/* ── Action buttons ── */}
      <div className="flex gap-3 pt-2">
        {(decl.submission_status === 'draft') && (
          <button
            onClick={() => void markReady()}
            disabled={marking}
            className="flex-1 border border-primary-300 text-primary-700 py-3 rounded-xl text-sm font-medium hover:bg-primary-50 disabled:opacity-60 transition-colors"
          >
            {marking ? 'Đang lưu...' : '✓ Đánh dấu Hoàn thiện'}
          </button>
        )}
        <div className="flex-1 flex rounded-xl overflow-hidden border border-primary-600 divide-x divide-primary-600">
          <button
            onClick={() => void downloadXml()}
            disabled={downloading}
            className="flex-1 bg-primary-600 text-white py-3 text-sm font-medium hover:bg-primary-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            {downloading ? '...' : 'XML'}
          </button>
          <button
            onClick={() => void downloadExport('excel')}
            disabled={downloading}
            className="px-4 bg-primary-600 text-white py-3 text-sm font-medium hover:bg-primary-700 disabled:opacity-60 transition-colors"
          >
            Excel
          </button>
          <button
            onClick={() => void downloadExport('pdf')}
            disabled={downloading}
            className="px-4 bg-primary-600 text-white py-3 text-sm font-medium hover:bg-primary-700 disabled:opacity-60 transition-colors"
          >
            PDF
          </button>
        </div>
        {['draft', 'ready'].includes(decl.submission_status) && (
          <button
            onClick={() => setShowTvanConfirm(true)}
            disabled={submittingTvan}
            className="flex-1 bg-indigo-600 text-white py-3 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
          >
            {submittingTvan ? 'Đang nộp...' : '📤 Nộp T-VAN'}
          </button>
        )}
      </div>

      {/* ── T-VAN result notification ── */}
      {tvanResult && (
        <div className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-2 ${
          tvanResult.status === 'accepted' ? 'bg-green-50 border-green-200 text-green-700'
          : tvanResult.status === 'rejected' ? 'bg-red-50 border-red-200 text-red-700'
          : 'bg-blue-50 border-blue-200 text-blue-700'
        }`}>
          {tvanResult.status === 'accepted' ? '✅' : tvanResult.status === 'rejected' ? '❌' : '⏳'}
          <div>
            <p className="font-semibold">
              {tvanResult.status === 'accepted' ? 'GDT đã tiếp nhận' : tvanResult.status === 'rejected' ? 'GDT từ chối' : 'Đang xử lý...'}
            </p>
            <p className="text-xs opacity-75">Mã T-VAN: {tvanResult.submissionId}</p>
            {tvanResult.message && <p className="text-xs mt-0.5">{tvanResult.message}</p>}
          </div>
        </div>
      )}

      {showTvanConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => setShowTvanConfirm(false)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-5 shadow-2xl ring-1 ring-indigo-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
                </svg>
              </div>
              <div>
                <h3 className="text-base font-semibold text-gray-900">Xác nhận nộp qua T-VAN</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Tờ khai sẽ được gửi sang T-VAN để nộp lên cơ quan thuế. Hành động này không thể hoàn tác.
                </p>
              </div>
            </div>

            <div className="rounded-2xl bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <p><span className="font-medium text-gray-800">Tờ khai:</span> {decl.form_type}</p>
              <p><span className="font-medium text-gray-800">Kỳ:</span> Tháng {decl.period_month}/{decl.period_year}</p>
              <p><span className="font-medium text-gray-800">Số phải nộp:</span> {vnd(decl.ct41_payable_vat)}</p>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowTvanConfirm(false)}
                className="flex-1 rounded-2xl border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void submitTvan()}
                disabled={submittingTvan}
                className="flex-1 rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {submittingTvan ? 'Đang gửi...' : 'Xác nhận nộp'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload instructions ── */}
      <details className="bg-blue-50 border border-blue-100 rounded-xl">
        <summary className="px-4 py-3 text-sm font-medium text-blue-700 cursor-pointer select-none">
          📖 Hướng dẫn nộp tờ khai thủ công
        </summary>
        <div className="px-4 pb-4 text-sm text-blue-800 space-y-2 leading-relaxed">
          <p><strong>Bước 1:</strong> Tải file XML ở trên về máy.</p>
          <p><strong>Bước 2:</strong> Truy cập <a href="https://thuedientu.gdt.gov.vn" target="_blank" rel="noreferrer" className="underline">thuedientu.gdt.gov.vn</a> → Đăng nhập bằng tài khoản thuế điện tử.</p>
          <p><strong>Bước 3:</strong> Vào mục <em>Kê khai → Lập tờ khai từ HTKK → Nộp tờ khai</em>.</p>
          <p><strong>Bước 4:</strong> Chọn kỳ kê khai → Upload file XML vừa tải.</p>
          <p><strong>Bước 5:</strong> Ký số (nếu có) → Nộp → Lưu mã tham chiếu GDT.</p>
        </div>
      </details>
    </div>
  );
}
