'use client';

import { useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { formatVND } from '../../../../utils/formatCurrency';

interface PenaltyResult {
  month:              number;
  year:               number;
  originalDeadline:   string;
  daysLate:           number;
  vatUnderpaid:       number;
  lateInterest:       number;
  adminPenalty:       number;
  totalPayable:       number;
  dailyAccrual:       number;
  waived:             boolean;
  recommendation:     string;
}

interface CostBenefitResult {
  willPay:            number;
  auditRisk:          number;
  netBenefitOfFiling: number;
  shouldFile:         boolean;
  reasoning:          string;
}

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);
const year0 = new Date().getFullYear();
const YEAR_OPTIONS = [year0 - 2, year0 - 1, year0];

export default function PenaltyCalculatorPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year,  setYear]  = useState(now.getFullYear());
  const [vatUnderpaid,      setVatUnderpaid]      = useState('');
  const [declarationType,   setDeclarationType]   = useState<'initial' | 'amended' | 'audit'>('amended');
  const [hasPriorVoluntary, setHasPriorVoluntary] = useState(false);
  const [riskLevel,         setRiskLevel]         = useState<'low' | 'medium' | 'high'>('medium');
  const [inputVatDeductible, setInputVatDeductible] = useState('');

  const [penalty,     setPenalty]     = useState<PenaltyResult | null>(null);
  const [costBenefit, setCostBenefit] = useState<CostBenefitResult | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');

  const calculate = async () => {
    if (!vatUnderpaid || Number(vatUnderpaid) <= 0) {
      setError('Vui lòng nhập số tiền VAT bị thiếu');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const res = await apiClient.post<{ data: { penalty: PenaltyResult; costBenefit: CostBenefitResult } }>(
        '/tools/cost-benefit',
        {
          month, year,
          vatUnderpaid:      Number(vatUnderpaid),
          riskLevel,
          inputVatDeductible: Number(inputVatDeductible || 0),
        }
      );
      setPenalty(res.data.data.penalty);
      setCostBenefit(res.data.data.costBenefit);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Có lỗi xảy ra');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Tính tiền phạt nộp chậm</h1>
        <p className="text-sm text-gray-500 mt-1">
          Theo Điều 59 Luật Quản lý Thuế — 0.03%/ngày. Phân tích chi phí–lợi ích nộp bổ sung.
        </p>
      </div>

      {/* Inputs */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Thông tin kỳ khai</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Tháng khai</label>
            <select value={month} onChange={e => setMonth(Number(e.target.value))}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {MONTH_OPTIONS.map(m => <option key={m} value={m}>Tháng {m}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Năm</label>
            <select value={year} onChange={e => setYear(Number(e.target.value))}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">VAT bị thiếu (VND)</label>
          <input
            type="number"
            value={vatUnderpaid}
            onChange={e => setVatUnderpaid(e.target.value)}
            placeholder="Ví dụ: 15000000"
            className="w-full border rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Loại kê khai</label>
            <select value={declarationType} onChange={e => setDeclarationType(e.target.value as never)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="initial">Kê khai lần đầu</option>
              <option value="amended">Kê khai bổ sung</option>
              <option value="audit">Cơ quan thuế phát hiện</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Mức độ rủi ro thanh tra</label>
            <select value={riskLevel} onChange={e => setRiskLevel(e.target.value as never)}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="low">Thấp (1×)</option>
              <option value="medium">Trung bình (3×)</option>
              <option value="high">Cao (10×)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <input type="checkbox" id="hasPriorVoluntary" checked={hasPriorVoluntary}
            onChange={e => setHasPriorVoluntary(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300" />
          <label htmlFor="hasPriorVoluntary" className="text-sm text-gray-700">
            Chủ động kê khai trước khi bị kiểm tra (miễn phạt hành chính)
          </label>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">VAT đầu vào có thể khấu trừ thêm (VND, tùy chọn)</label>
          <input type="number" value={inputVatDeductible}
            onChange={e => setInputVatDeductible(e.target.value)}
            placeholder="0"
            className="w-full border rounded-lg px-3 py-2 text-sm" />
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button onClick={calculate} disabled={loading}
          className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50">
          {loading ? 'Đang tính...' : 'Tính toán'}
        </button>
      </div>

      {/* Results */}
      {penalty && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Kết quả tính toán</h2>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Số ngày chậm</p>
              <p className="text-xl font-bold text-gray-900">{penalty.daysLate} ngày</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Tích lũy mỗi ngày</p>
              <p className="text-xl font-bold text-orange-600">{formatVND(penalty.dailyAccrual)}/ngày</p>
            </div>
            <div className="bg-amber-50 rounded-lg p-3">
              <p className="text-xs text-gray-500">Tiền chậm nộp (0.03%/ngày)</p>
              <p className="text-lg font-bold text-amber-700">{formatVND(penalty.lateInterest)}</p>
            </div>
            <div className={`rounded-lg p-3 ${penalty.waived ? 'bg-green-50' : 'bg-red-50'}`}>
              <p className="text-xs text-gray-500">Phạt hành chính</p>
              <p className={`text-lg font-bold ${penalty.waived ? 'text-green-700' : 'text-red-700'}`}>
                {penalty.waived ? 'Miễn (tự nguyện khai bổ sung)' : formatVND(penalty.adminPenalty)}
              </p>
            </div>
          </div>

          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
            <p className="text-xs text-gray-500">Tổng phải nộp thêm</p>
            <p className="text-3xl font-bold text-red-700 mt-1">{formatVND(penalty.totalPayable)}</p>
            <p className="text-xs text-gray-500 mt-1">Hạn nộp kỳ {penalty.month}/{penalty.year}: <strong>{new Date(penalty.originalDeadline).toLocaleDateString('vi-VN')}</strong></p>
          </div>

          <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
            <strong>Khuyến nghị:</strong> {penalty.recommendation}
          </div>
        </div>
      )}

      {costBenefit && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Phân tích chi phí – lợi ích</h2>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div className="bg-gray-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Phải nộp ngay</p>
              <p className="font-bold text-gray-900 mt-1">{formatVND(costBenefit.willPay)}</p>
            </div>
            <div className="bg-red-50 rounded-lg p-3 text-center">
              <p className="text-xs text-gray-500">Rủi ro thanh tra</p>
              <p className="font-bold text-red-700 mt-1">{formatVND(costBenefit.auditRisk)}</p>
            </div>
            <div className={`rounded-lg p-3 text-center ${costBenefit.shouldFile ? 'bg-green-50' : 'bg-amber-50'}`}>
              <p className="text-xs text-gray-500">Lợi ích ròng khi khai bổ sung</p>
              <p className={`font-bold mt-1 ${costBenefit.shouldFile ? 'text-green-700' : 'text-amber-700'}`}>
                {formatVND(costBenefit.netBenefitOfFiling)}
              </p>
            </div>
          </div>
          <div className={`rounded-lg p-4 text-sm ${costBenefit.shouldFile ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
            <strong>{costBenefit.shouldFile ? '✓ Nên kê khai bổ sung' : '⚠ Cân nhắc thêm'}:</strong> {costBenefit.reasoning}
          </div>
        </div>
      )}
    </div>
  );
}
