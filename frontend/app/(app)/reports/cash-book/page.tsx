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

interface CashBookEntry {
  id: string;
  entry_type: 'receipt' | 'payment' | 'transfer' | 'opening';
  entry_date: string;
  amount: number;
  description: string | null;
  partner_name: string | null;
  reference_number: string | null;
  category: string | null;
  payment_method: string;
  is_auto_generated: boolean;
  running_balance: number;
}

interface CashBookData {
  entries: CashBookEntry[];
  opening_balance: number;
  total_receipt: number;
  total_payment: number;
}

interface NewEntryForm {
  entry_type: string;
  entry_date: string;
  amount: string;
  description: string;
  partner_name: string;
  reference_number: string;
  category: string;
  payment_method: string;
}

export default function CashBookPage() {
  const { activeCompanyId } = useCompany();
  const [data, setData] = useState<CashBookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<PeriodValue>(defaultPeriod);
  const [method, setMethod] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<NewEntryForm>({
    entry_type: 'receipt', entry_date: new Date().toISOString().split('T')[0],
    amount: '', description: '', partner_name: '', reference_number: '', category: '', payment_method: 'cash',
  });
  const [saving, setSaving] = useState(false);

  const fetch = () => {
    if (!activeCompanyId) return;
    setLoading(true);
    const params = periodToParams(period);
    if (method) params.append('method', method);
    apiClient
      .get<{ data: CashBookData }>(`/cash-book?${params}`)
      .then((r) => setData(r.data.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetch(); }, [activeCompanyId, period, method]); // eslint-disable-line react-hooks/exhaustive-deps

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await apiClient.post('/cash-book/rebuild', {
        month: period.month,
        year: period.year,
        quarter: period.quarter,
        periodType: period.periodType,
      });
      fetch();
    } catch { /* ignore */ } finally {
      setRebuilding(false);
    }
  };

  const saveEntry = async () => {
    if (!form.amount || Number(form.amount) <= 0) return;
    setSaving(true);
    try {
      await apiClient.post('/cash-book/entries', {
        ...form,
        amount: Number(form.amount),
      });
      setShowModal(false);
      setForm({ entry_type: 'receipt', entry_date: new Date().toISOString().split('T')[0],
        amount: '', description: '', partner_name: '', reference_number: '', category: '', payment_method: 'cash' });
      fetch();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    if (!confirm('Xóa phiếu này?')) return;
    try {
      await apiClient.delete(`/cash-book/entries/${id}`);
      fetch();
    } catch {
      // ignore
    }
  };

  const TYPE_LABEL: Record<string, string> = {
    receipt: '🟢 Thu', payment: '🔴 Chi', transfer: '🔵 Chuyển', opening: '⚪ Đầu kỳ',
  };

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sổ Quỹ Tiền</h1>
          <p className="text-sm text-gray-500">{periodLabel(period)}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <PeriodSelector value={period} onChange={setPeriod} />
          <select value={method} onChange={(e) => setMethod(e.target.value)}
            className="border rounded-lg px-2 py-1 text-sm">
            <option value="">Tất cả</option>
            <option value="cash">Tiền mặt</option>
            <option value="bank">Ngân hàng</option>
          </select>
          <button onClick={rebuild} disabled={rebuilding}
            className="px-3 py-1 bg-gray-100 border rounded-lg text-sm disabled:opacity-50">
            {rebuilding ? 'Đang tính...' : '🔄 Tính lại'}
          </button>
          <button onClick={() => setShowModal(true)}
            className="px-4 py-1 bg-blue-600 text-white rounded-lg text-sm">+ Phiếu thu/chi</button>
        </div>
      </div>

      {/* Summary cards */}
      {data && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Số dư đầu kỳ', val: data.opening_balance, color: 'text-gray-700' },
            { label: 'Tổng thu', val: data.total_receipt, color: 'text-green-700' },
            { label: 'Tổng chi', val: data.total_payment, color: 'text-red-700' },
            { label: 'Số dư cuối kỳ', val: data.opening_balance + data.total_receipt - data.total_payment, color: (data.opening_balance + data.total_receipt - data.total_payment) < 0 ? 'text-red-700 font-bold' : 'text-blue-700 font-bold' },
          ].map((c) => (
            <div key={c.label} className="bg-white border border-gray-200 rounded-xl p-3">
              <p className="text-xs text-gray-500">{c.label}</p>
              <p className={`text-lg font-semibold mt-1 ${c.color}`}>{formatVND(c.val)}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Đang tải...</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left">Ngày</th>
                <th className="px-3 py-2 text-left">Loại</th>
                <th className="px-3 py-2 text-left">Diễn giải</th>
                <th className="px-3 py-2 text-left">Đối tác</th>
                <th className="px-3 py-2 text-right">Thu</th>
                <th className="px-3 py-2 text-right">Chi</th>
                <th className="px-3 py-2 text-right">Số dư</th>
                <th className="px-3 py-2 text-center">PT</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(!data?.entries || data.entries.length === 0) ? (
                <tr><td colSpan={9} className="text-center py-8 text-gray-400">Chưa có phiếu thu/chi</td></tr>
              ) : data.entries.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-500 text-xs">{e.entry_date}</td>
                  <td className="px-3 py-2 text-xs">{TYPE_LABEL[e.entry_type] ?? e.entry_type}</td>
                  <td className="px-3 py-2 text-sm">{e.description ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{e.partner_name ?? '—'}</td>
                  <td className="px-3 py-2 text-right text-green-700">
                    {e.entry_type === 'receipt' ? formatVND(e.amount) : ''}
                  </td>
                  <td className="px-3 py-2 text-right text-red-700">
                    {e.entry_type === 'payment' ? formatVND(e.amount) : ''}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${e.running_balance < 0 ? 'text-red-700' : ''}`}>
                    {formatVND(e.running_balance)}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-gray-400">
                    {e.payment_method === 'bank' ? '🏦' : '💵'}
                    {e.is_auto_generated && ' 🤖'}
                  </td>
                  <td className="px-3 py-2">
                    {!e.is_auto_generated && (
                      <button onClick={() => deleteEntry(e.id)}
                        className="text-red-400 hover:text-red-600 text-xs">✕</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add entry modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-sm space-y-3 shadow-xl">
            <h2 className="text-lg font-semibold">Thêm phiếu thu/chi</h2>
            <select value={form.entry_type} onChange={(e) => setForm({ ...form, entry_type: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="receipt">Thu tiền</option>
              <option value="payment">Chi tiền</option>
              <option value="transfer">Chuyển khoản nội bộ</option>
            </select>
            <input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input type="number" placeholder="Số tiền *" value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Diễn giải" value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input placeholder="Đối tác" value={form.partner_name}
              onChange={(e) => setForm({ ...form, partner_name: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="cash">Tiền mặt</option>
              <option value="bank">Ngân hàng/CK</option>
            </select>
            <div className="flex gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="flex-1 border rounded-lg py-2 text-sm">Hủy</button>
              <button onClick={saveEntry} disabled={saving}
                className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm disabled:opacity-50">
                {saving ? 'Đang lưu...' : 'Lưu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
