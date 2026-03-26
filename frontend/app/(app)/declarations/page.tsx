'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import apiClient from '../../../lib/apiClient';
import { useToast } from '../../../components/ToastProvider';
import { formatVND } from '../../../utils/formatCurrency';

interface Declaration {
  id: string;
  period_month: number;
  period_year: number;
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

  useEffect(() => { void load(); }, [load]);

  const calculate = async () => {
    const now = new Date();
    setCalculating(true);
    try {
      await apiClient.post('/declarations/calculate', {
        month: now.getMonth() + 1,
        year: now.getFullYear(),
      });
      toast.success('Đã tính toán tờ khai thành công');
      await load();
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

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tờ Khai Thuế</h1>
          <p className="text-sm text-gray-500 mt-1">01/GTGT — Kê khai thuế GTGT</p>
        </div>
        <button
          onClick={calculate}
          disabled={calculating}
          className="bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {calculating ? 'Đang tính...' : '+ Tính Mới'}
        </button>
      </div>

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
        <div className="space-y-3">
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
                      Tháng {decl.period_month}/{decl.period_year}
                    </p>
                    <p className="text-xs text-gray-400">
                      Tạo: {new Date(decl.created_at).toLocaleDateString('vi-VN')}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusInfo.color}`}>
                    {statusInfo.label}
                  </span>
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

                <button
                  onClick={(e) => { e.stopPropagation(); void downloadXml(decl.id, decl.period_month, decl.period_year); }}
                  className="w-full border border-gray-300 rounded-lg py-2 text-sm text-gray-700 font-medium"
                >
                  📥 Tải XML HTKK
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
