'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import apiClient from '../../../../lib/apiClient';
import { useToast } from '../../../../components/ToastProvider';
import { formatVND } from '../../../../utils/formatCurrency';
import { useCompany } from '../../../../contexts/CompanyContext';

interface PitDeclaration {
  id: string;
  period_quarter: number;
  period_year: number;
  loai_tkhai: string;
  so_lan: number;
  ct32: string;
  status: string;
  created_at: string;
  submission_at: string | null;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft:     { label: 'Nháp',          color: 'bg-gray-100 text-gray-700' },
  ready:     { label: 'Hoàn thiện',    color: 'bg-blue-100 text-blue-700' },
  submitted: { label: 'Đã nộp',        color: 'bg-orange-100 text-orange-700' },
  accepted:  { label: 'GDT tiếp nhận', color: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Từ chối',       color: 'bg-red-100 text-red-700' },
};

const QUARTER_LABELS = ['Q1 (Jan–Mar)', 'Q2 (Apr–Jun)', 'Q3 (Jul–Sep)', 'Q4 (Oct–Dec)'];

export default function PitDeclarationsPage() {
  const router = useRouter();
  const toast  = useToast();
  const { activeCompany, loading: companyLoading } = useCompany();

  const [declarations, setDeclarations]   = useState<PitDeclaration[]>([]);
  const [loading, setLoading]             = useState(true);
  const [showModal, setShowModal]         = useState(false);
  const [creating, setCreating]           = useState(false);
  const [deletingId, setDeletingId]       = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PitDeclaration | null>(null);

  const defaultQuarter = (() => {
    const q = Math.ceil((new Date().getMonth() + 1) / 3);
    return q === 1 ? 4 : q - 1;
  })();
  const defaultYear = (() => {
    const d = new Date();
    return d.getMonth() < 3 ? d.getFullYear() - 1 : d.getFullYear();
  })();

  const [newQuarter, setNewQuarter] = useState(defaultQuarter);
  const [newYear, setNewYear]       = useState(defaultYear);

  const load = useCallback(async () => {
    if (!activeCompany?.id) { setLoading(false); return; }
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: PitDeclaration[] }>('/pit-declarations');
      setDeclarations(res.data.data);
    } catch {
      toast.error('Không tải được danh sách tờ khai TNCN.');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDeclarations([]); setLoading(true); }, [activeCompany?.id]);
  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await apiClient.post<{ data: { id: string } }>('/pit-declarations', {
        period_quarter: newQuarter,
        period_year: newYear,
      });
      setShowModal(false);
      toast.success('Đã tạo tờ khai 05/KK-TNCN.');
      router.push(`/declarations/pit/${res.data.data.id}`);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message
        ?? 'Lỗi tạo tờ khai. Vui lòng thử lại.';
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (decl: PitDeclaration) => {
    setDeletingId(decl.id);
    setConfirmDelete(null);
    try {
      await apiClient.delete(`/pit-declarations/${decl.id}`);
      toast.success('Đã xóa tờ khai.');
      setDeclarations(prev => prev.filter(d => d.id !== decl.id));
    } catch {
      toast.error('Lỗi xóa tờ khai. Vui lòng thử lại.');
    } finally {
      setDeletingId(null);
    }
  };

  const downloadXml = async (decl: PitDeclaration) => {
    try {
      const res = await apiClient.get(`/pit-declarations/${decl.id}/xml`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'application/xml' }));
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `05KK-TNCN_Q${decl.period_quarter}_${decl.period_year}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Lỗi tải XML. Vui lòng thử lại.');
    }
  };

  if (companyLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Tờ Khai Thuế</h1>
        <button
          onClick={() => setShowModal(true)}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          + Tạo Tờ Khai
        </button>
      </div>

      {/* Form type tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-6 w-fit">
        <Link
          href="/declarations"
          className="px-4 py-1.5 rounded-md text-sm font-medium text-gray-500 hover:text-gray-700 hover:bg-white/60 transition-colors"
        >
          01/GTGT
        </Link>
        <span className="px-4 py-1.5 rounded-md bg-white shadow-sm text-sm font-medium text-gray-900">
          05/KK-TNCN
        </span>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
        </div>
      ) : declarations.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Chưa có tờ khai nào</p>
          <p className="text-sm">Nhấn &quot;+ Tạo Tờ Khai&quot; để bắt đầu</p>
        </div>
      ) : (
        <div className="space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {declarations.map((decl) => {
            const statusInfo = STATUS_LABELS[decl.status] ?? { label: decl.status, color: 'bg-gray-100 text-gray-700' };
            const totalTax   = Number(decl.ct32);
            return (
              <div
                key={decl.id}
                className="bg-white rounded-xl shadow-sm p-4 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => router.push(`/declarations/pit/${decl.id}`)}
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="font-bold text-gray-900">
                      Quý {decl.period_quarter}/{decl.period_year}
                    </p>
                    <p className="text-xs text-gray-400">05/KK-TNCN • {QUARTER_LABELS[decl.period_quarter - 1]}</p>
                    <p className="text-xs text-gray-400">
                      Tạo: {new Date(decl.created_at).toLocaleDateString('vi-VN')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                      {statusInfo.label}
                    </span>
                    {decl.loai_tkhai === 'BS' && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                        Bổ sung #{decl.so_lan}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(decl); }}
                      disabled={deletingId === decl.id}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                      title="Xóa tờ khai"
                    >
                      {deletingId === decl.id
                        ? <span className="text-xs">...</span>
                        : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        )
                      }
                    </button>
                  </div>
                </div>

                <div className="mb-3 bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-500">[32] Tổng thuế TNCN đã khấu trừ</p>
                  <p className={`text-lg font-bold ${totalTax > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                    {totalTax > 0 ? formatVND(totalTax) : '—'}
                  </p>
                </div>

                <div
                  className="flex rounded-lg border border-gray-300 overflow-hidden text-xs text-gray-700 font-medium divide-x divide-gray-300"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="flex-1 py-2 hover:bg-gray-50 transition-colors"
                    onClick={() => router.push(`/declarations/pit/${decl.id}`)}
                  >
                    Xem / Nhập
                  </button>
                  <button
                    className="flex-1 py-2 hover:bg-gray-50 transition-colors"
                    onClick={() => downloadXml(decl)}
                  >
                    Tải XML
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Tạo Tờ Khai 05/KK-TNCN</h2>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Quý</label>
                <select
                  value={newQuarter}
                  onChange={(e) => setNewQuarter(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value={1}>Quý 1 (Tháng 1–3)</option>
                  <option value={2}>Quý 2 (Tháng 4–6)</option>
                  <option value={3}>Quý 3 (Tháng 7–9)</option>
                  <option value={4}>Quý 4 (Tháng 10–12)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Năm</label>
                <select
                  value={newYear}
                  onChange={(e) => setNewYear(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {[2025, 2026, 2027].map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
              >
                Hủy
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                {creating ? 'Đang tạo...' : 'Tạo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-lg font-bold text-gray-900 mb-2">Xác nhận xóa</h2>
            <p className="text-sm text-gray-600 mb-6">
              Xóa tờ khai 05/KK-TNCN Quý {confirmDelete.period_quarter}/{confirmDelete.period_year}?
              Thao tác này không thể hoàn tác.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
              >
                Hủy
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
              >
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
