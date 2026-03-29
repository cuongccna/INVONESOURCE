'use client';

import { useEffect, useState } from 'react';
import apiClient from '../../../../lib/apiClient';
import { useCompany } from '../../../../contexts/CompanyContext';
import { formatVND } from '../../../../utils/formatCurrency';
import PeriodSelector, {
  type PeriodValue,
  defaultPeriod,
  periodToParams,
  periodLabel,
} from '../../../../components/PeriodSelector';

interface InventoryBalanceRow {
  item_code: string | null;
  normalized_item_name: string;
  item_name: string;
  unit: string | null;
  opening_qty: number;
  opening_value: number;
  in_qty: number;
  in_value: number;
  out_qty: number;
  out_value: number;
  closing_qty: number;
  closing_value: number;
  avg_cost_price: number | null;
}

export default function InventoryReportPage() {
  const { activeCompanyId } = useCompany();
  const [rows, setRows] = useState<InventoryBalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriod);
  const [showOpeningModal, setShowOpeningModal] = useState(false);
  const [openingForm, setOpeningForm] = useState({ item_name: '', unit: '', quantity: '', unit_cost: '' });
  const [msg, setMsg] = useState('');

  const fetch = (p = period) => {
    if (!activeCompanyId) return;
    setLoading(true);
    apiClient
      .get<{ data: InventoryBalanceRow[] }>(`/inventory?${periodToParams(p)}`)
      .then((r) => setRows(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetch(); }, [activeCompanyId, period]); // eslint-disable-line react-hooks/exhaustive-deps

  const build = async () => {
    setBuilding(true);
    setMsg('');
    try {
      await apiClient.post('/inventory/build', {
        month: period.month,
        year: period.year,
        quarter: period.quarter,
        periodType: period.periodType,
      });
      setMsg('Đã tính lại xuất nhập tồn.');
      fetch();
    } catch {
      setMsg('Lỗi khi tính lại.');
    } finally {
      setBuilding(false);
    }
  };

  const saveOpening = async () => {
    try {
      await apiClient.post('/inventory/opening-balance', {
        item_name: openingForm.item_name,
        unit: openingForm.unit || undefined,
        quantity: Number(openingForm.quantity),
        unit_cost: Number(openingForm.unit_cost),
        as_of_date: `${period.year}-${String(period.month).padStart(2, '0')}-01`,
      });
      setShowOpeningModal(false);
      setOpeningForm({ item_name: '', unit: '', quantity: '', unit_cost: '' });
      fetch();
    } catch {
      setMsg('Lỗi khi lưu tồn đầu kỳ.');
    }
  };

  const negativeRows = rows.filter((r) => r.closing_qty < 0);

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Xuất Nhập Tồn</h1>
          <p className="text-sm text-gray-500">{rows.length} mặt hàng · {periodLabel(period)}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <PeriodSelector value={period} onChange={setPeriod} />
          <button onClick={() => setShowOpeningModal(true)}
            className="px-3 py-1 bg-gray-100 border rounded-lg text-sm">+ Tồn đầu kỳ</button>
          <button onClick={build} disabled={building}
            className="px-4 py-1 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
            {building ? 'Đang tính...' : '🔄 Tính lại'}
          </button>
        </div>
      </div>

      {msg && <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded-lg p-3">{msg}</div>}

      {negativeRows.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          ⚠️ {negativeRows.length} mặt hàng có tồn kho âm — kiểm tra lại dữ liệu xuất nhập.
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tính toán...</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left" rowSpan={2}>Mã HH</th>
                <th className="px-3 py-2 text-left" rowSpan={2}>Tên hàng hóa</th>
                <th className="px-3 py-2 text-center" rowSpan={2}>ĐVT</th>
                <th className="px-3 py-2 text-center border-l border-gray-200" colSpan={2}>Đầu kỳ</th>
                <th className="px-3 py-2 text-center border-l border-gray-200" colSpan={2}>Nhập kỳ</th>
                <th className="px-3 py-2 text-center border-l border-gray-200" colSpan={2}>Xuất kỳ</th>
                <th className="px-3 py-2 text-center border-l border-gray-200" colSpan={2}>Cuối kỳ</th>
              </tr>
              <tr>
                <th className="px-3 py-1 text-right border-l border-gray-200">SL</th>
                <th className="px-3 py-1 text-right">Giá trị</th>
                <th className="px-3 py-1 text-right border-l border-gray-200">SL</th>
                <th className="px-3 py-1 text-right">Giá trị</th>
                <th className="px-3 py-1 text-right border-l border-gray-200">SL</th>
                <th className="px-3 py-1 text-right">Giá trị</th>
                <th className="px-3 py-1 text-right border-l border-gray-200">SL</th>
                <th className="px-3 py-1 text-right">Giá trị</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 ? (
                <tr><td colSpan={11} className="text-center py-8 text-gray-400">Chưa có dữ liệu — bấm Build XNT</td></tr>
              ) : rows.map((r) => (
                <tr key={r.normalized_item_name} className={`hover:bg-gray-50 ${r.closing_qty < 0 ? 'bg-red-50' : ''}`}>
                  <td className="px-3 py-2 font-mono text-blue-700">{r.item_code ?? '—'}</td>
                  <td className="px-3 py-2 font-medium">{r.item_name}</td>
                  <td className="px-3 py-2 text-center text-gray-500">{r.unit ?? '—'}</td>
                  <td className="px-3 py-2 text-right border-l border-gray-100">{r.opening_qty.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-gray-600">{formatVND(r.opening_value)}</td>
                  <td className="px-3 py-2 text-right border-l border-gray-100 text-green-700">{r.in_qty.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-green-600">{formatVND(r.in_value)}</td>
                  <td className="px-3 py-2 text-right border-l border-gray-100 text-red-700">{r.out_qty.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-red-600">{formatVND(r.out_value)}</td>
                  <td className={`px-3 py-2 text-right border-l border-gray-100 font-semibold ${r.closing_qty < 0 ? 'text-red-700' : ''}`}>{r.closing_qty.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-semibold">{formatVND(r.closing_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Opening balance modal */}
      {showOpeningModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm space-y-4 shadow-xl">
            <h2 className="text-lg font-semibold">Nhập tồn đầu kỳ</h2>
            <input placeholder="Tên hàng hóa *" value={openingForm.item_name}
              onChange={(e) => setOpeningForm({ ...openingForm, item_name: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Đơn vị tính" value={openingForm.unit}
              onChange={(e) => setOpeningForm({ ...openingForm, unit: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="number" placeholder="Số lượng *" value={openingForm.quantity}
              onChange={(e) => setOpeningForm({ ...openingForm, quantity: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="number" placeholder="Đơn giá vốn *" value={openingForm.unit_cost}
              onChange={(e) => setOpeningForm({ ...openingForm, unit_cost: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-3">
              <button onClick={() => setShowOpeningModal(false)}
                className="flex-1 border rounded-lg py-2 text-sm">Hủy</button>
              <button onClick={saveOpening}
                className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm">Lưu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
