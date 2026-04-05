'use client';

import { useState, useEffect, useCallback } from 'react';
import apiClient from '../../lib/apiClient';
import { useToast } from '../ToastProvider';
import type { GridInvoice } from './InvoiceGrid';

interface Props {
  invoice: GridInvoice;
  onClose: () => void;
  onSaved: () => void;
}

interface Suggestion { code: string; name: string }

const PAYMENT_METHODS = [
  { value: 'transfer', label: 'Chuyển khoản' },
  { value: 'cash',     label: 'Tiền mặt' },
  { value: 'card',     label: 'Thẻ' },
  { value: 'cheque',   label: 'Séc' },
];

function AutocompleteInput({
  label, value, onChange, onSearch, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSearch: (q: string) => Promise<Suggestion[]>;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value.length < 2) { setSuggestions([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await onSearch(value);
        setSuggestions(res);
        setOpen(res.length > 0);
      } finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [value, onSearch]);

  return (
    <div className="relative">
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value); }}
        onFocus={() => value.length >= 2 && suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
      {searching && <span className="absolute right-3 top-8 text-xs text-gray-400">...</span>}
      {open && (
        <div className="absolute z-40 top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-40 overflow-y-auto">
          {suggestions.map(s => (
            <button
              key={s.code}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
              onMouseDown={() => { onChange(s.code); setOpen(false); }}
            >
              <span className="font-mono text-primary-700">{s.code}</span>
              {s.name && <span className="text-gray-500 ml-2 text-xs">— {s.name}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function InvoiceEditPanel({ invoice, onClose, onSaved }: Props) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  // Section A — Phân loại
  const [itemCode,     setItemCode]     = useState(invoice.item_code     ?? '');
  const [customerCode, setCustomerCode] = useState(invoice.customer_code ?? '');

  // Section B — Thanh toán
  const [paymentMethod,  setPaymentMethod]  = useState(invoice.payment_method ?? '');
  const [paymentDate,    setPaymentDate]    = useState('');
  const [paymentDueDate, setPaymentDueDate] = useState('');

  // Section C — Ghi chú
  const [notes, setNotes] = useState(invoice.notes ?? '');

  const [activeSection, setActiveSection] = useState<'A' | 'B' | 'C'>('A');

  const searchItems = useCallback(async (q: string): Promise<Suggestion[]> => {
    try {
      const res = await apiClient.get<{ data: Array<{ item_code: string; display_name: string }> }>(
        `/products?search=${encodeURIComponent(q)}&pageSize=10`
      );
      return (res.data.data ?? []).map(d => ({ code: d.item_code, name: d.display_name }));
    } catch { return []; }
  }, []);

  const searchCustomers = useCallback(async (q: string): Promise<Suggestion[]> => {
    try {
      const [custRes, suppRes] = await Promise.all([
        apiClient.get<{ data: Array<{ customer_code: string; name: string }> }>(
          `/catalogs/customers?search=${encodeURIComponent(q)}&pageSize=5`
        ).catch(() => ({ data: { data: [] } })),
        apiClient.get<{ data: Array<{ supplier_code: string; name: string }> }>(
          `/catalogs/suppliers?search=${encodeURIComponent(q)}&pageSize=5`
        ).catch(() => ({ data: { data: [] } })),
      ]);
      const custs = (custRes.data.data ?? []).map(d => ({ code: d.customer_code, name: d.name }));
      const supps = (suppRes.data.data ?? []).map(d => ({ code: d.supplier_code, name: d.name }));
      return [...custs, ...supps];
    } catch { return []; }
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (itemCode     !== (invoice.item_code     ?? '')) body.item_code      = itemCode     || null;
      if (customerCode !== (invoice.customer_code ?? '')) body.customer_code  = customerCode || null;
      if (paymentMethod !== (invoice.payment_method ?? '')) body.payment_method = paymentMethod || null;
      if (paymentDate)       body.payment_date    = paymentDate;
      if (paymentDueDate)    body.payment_due_date = paymentDueDate;
      if (notes !== (invoice.notes ?? '')) body.notes = notes.trim() || null;

      if (Object.keys(body).length === 0) { onClose(); return; }

      await apiClient.patch(`/invoices/${invoice.id}`, body);
      toast.success('Đã lưu thay đổi');
      onSaved();
      onClose();
    } catch {
      toast.error('Lỗi lưu. Vui lòng thử lại.');
    } finally {
      setSaving(false);
    }
  };

  const SECTIONS = [
    { id: 'A' as const, label: 'Phân loại & Danh mục' },
    { id: 'B' as const, label: 'Thanh toán' },
    { id: 'C' as const, label: 'Ghi chú' },
  ];

  return (
    <div className="p-4 border-t border-blue-200 bg-blue-50/30">
      <div className="max-w-2xl">
        {/* Section tabs */}
        <div className="flex gap-1 mb-4">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeSection === s.id ? 'bg-primary-600 text-white' : 'bg-white border border-gray-300 text-gray-600 hover:border-primary-300'}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Section A */}
        {activeSection === 'A' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <AutocompleteInput
              label="Mã hàng hóa / dịch vụ"
              value={itemCode}
              onChange={setItemCode}
              onSearch={searchItems}
              placeholder="Nhập mã hoặc tên để tìm…"
            />
            <AutocompleteInput
              label="Mã khách hàng / nhà cung cấp"
              value={customerCode}
              onChange={setCustomerCode}
              onSearch={searchCustomers}
              placeholder="Nhập mã hoặc tên để tìm…"
            />
          </div>
        )}

        {/* Section B */}
        {activeSection === 'B' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Phương thức thanh toán</label>
              <div className="flex gap-2 flex-wrap">
                {PAYMENT_METHODS.map(m => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setPaymentMethod(paymentMethod === m.value ? '' : m.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${paymentMethod === m.value ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-300 text-gray-600 hover:border-primary-300'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {paymentMethod === 'cash' && Number(invoice.total_amount) >= 5_000_000 && (
                <p className="mt-2 text-xs text-orange-600 bg-orange-50 rounded-lg px-2 py-1">
                  ⚠️ HĐ &gt;5 triệu thanh toán tiền mặt không được khấu trừ VAT theo TT78/2021
                </p>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Ngày thanh toán</label>
                <input type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Hạn thanh toán</label>
                <input type="date" value={paymentDueDate} onChange={e => setPaymentDueDate(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
            </div>
          </div>
        )}

        {/* Section C */}
        {activeSection === 'C' && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Ghi chú nội bộ</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Ghi chú về hóa đơn..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
            />
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Đang lưu...' : 'Lưu'}
          </button>
          <button onClick={onClose} className="px-5 py-2 border border-gray-300 rounded-xl text-sm text-gray-700">
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}
