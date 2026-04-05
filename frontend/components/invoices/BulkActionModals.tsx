'use client';

import { useState, useEffect, useCallback } from 'react';
import apiClient from '../../lib/apiClient';
import { useToast } from '../ToastProvider';

interface BulkModalProps {
  ids: string[];
  onClose: () => void;
}

/* ─────────────────────────── helpers ──────────────────────────── */

interface Suggestion { code: string; name: string }

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CodeSearch({
  label, placeholder, onSearch, value, onChange,
}: { label: string; placeholder: string; onSearch: (q: string) => Promise<Suggestion[]>; value: string; onChange: (v: string) => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (value.length < 2) { setSuggestions([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      const res = await onSearch(value);
      setSuggestions(res);
      setOpen(res.length > 0);
    }, 350);
    return () => clearTimeout(t);
  }, [value, onSearch]);

  return (
    <div className="relative">
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => value.length >= 2 && suggestions.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-36 overflow-y-auto">
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

/* ─────────────────────────── BulkItemCodeModal ──────────────────────────── */

export function BulkItemCodeModal({ ids, onClose }: BulkModalProps) {
  const toast = useToast();
  const [code, setCode]  = useState('');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [saving, setSaving] = useState(false);

  const search = useCallback(async (q: string): Promise<Suggestion[]> => {
    try {
      const r = await apiClient.get<{ data: Array<{ item_code: string; display_name: string }> }>(
        `/products?search=${encodeURIComponent(q)}&pageSize=10`
      );
      return (r.data.data ?? []).map(d => ({ code: d.item_code, name: d.display_name }));
    } catch { return []; }
  }, []);

  const handleApply = async () => {
    if (!code.trim()) { toast.error('Vui lòng nhập mã hàng'); return; }
    setSaving(true);
    try {
      await apiClient.patch('/invoices/bulk-update', {
        ids,
        updates: { item_code: code.trim() },
        only_missing: onlyMissing,
      });
      toast.success(`Đã gán mã hàng cho ${ids.length} HĐ`);
      onClose();
    } catch { toast.error('Lỗi gán mã. Vui lòng thử lại.'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Gán mã hàng — ${ids.length} hóa đơn`} onClose={onClose}>
      <div className="p-5 space-y-4">
        <CodeSearch
          label="Mã hàng hóa / dịch vụ"
          placeholder="Nhập mã hoặc tên để tìm…"
          value={code}
          onChange={setCode}
          onSearch={search}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} className="rounded" />
          Chỉ áp dụng cho HĐ chưa có mã hàng
        </label>
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-xl text-sm text-gray-700">Hủy</button>
          <button
            onClick={handleApply}
            disabled={saving || !code.trim()}
            className="px-5 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Đang gán...' : 'Áp dụng'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─────────────────────────── BulkCustomerCodeModal ──────────────────────────── */

export function BulkCustomerCodeModal({ ids, onClose }: BulkModalProps) {
  const toast = useToast();
  const [code, setCode]  = useState('');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [saving, setSaving] = useState(false);

  const search = useCallback(async (q: string): Promise<Suggestion[]> => {
    try {
      const [cr, sr] = await Promise.all([
        apiClient.get<{ data: Array<{ customer_code: string; name: string }> }>(
          `/catalogs/customers?search=${encodeURIComponent(q)}&pageSize=5`
        ).catch(() => ({ data: { data: [] } })),
        apiClient.get<{ data: Array<{ supplier_code: string; name: string }> }>(
          `/catalogs/suppliers?search=${encodeURIComponent(q)}&pageSize=5`
        ).catch(() => ({ data: { data: [] } })),
      ]);
      return [
        ...(cr.data.data ?? []).map(d => ({ code: d.customer_code, name: d.name })),
        ...(sr.data.data ?? []).map(d => ({ code: d.supplier_code, name: d.name })),
      ];
    } catch { return []; }
  }, []);

  const handleApply = async () => {
    if (!code.trim()) { toast.error('Vui lòng nhập mã KH/NCC'); return; }
    setSaving(true);
    try {
      await apiClient.patch('/invoices/bulk-update', {
        ids,
        updates: { customer_code: code.trim() },
        only_missing: onlyMissing,
      });
      toast.success(`Đã gán mã KH/NCC cho ${ids.length} HĐ`);
      onClose();
    } catch { toast.error('Lỗi gán mã. Vui lòng thử lại.'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Gán mã KH/NCC — ${ids.length} hóa đơn`} onClose={onClose}>
      <div className="p-5 space-y-4">
        <CodeSearch
          label="Mã khách hàng / nhà cung cấp"
          placeholder="Nhập mã hoặc tên để tìm…"
          value={code}
          onChange={setCode}
          onSearch={search}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} className="rounded" />
          Chỉ áp dụng cho HĐ chưa có mã KH/NCC
        </label>
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-xl text-sm text-gray-700">Hủy</button>
          <button
            onClick={handleApply}
            disabled={saving || !code.trim()}
            className="px-5 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Đang gán...' : 'Áp dụng'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ─────────────────────────── BulkPaymentModal ──────────────────────────── */

const PAYMENT_METHODS = [
  { value: 'transfer', label: 'Chuyển khoản' },
  { value: 'cash',     label: 'Tiền mặt' },
  { value: 'card',     label: 'Thẻ' },
  { value: 'cheque',   label: 'Séc' },
];

export function BulkPaymentModal({ ids, onClose }: BulkModalProps) {
  const toast = useToast();
  const [method, setMethod]  = useState('');
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [saving, setSaving] = useState(false);

  const handleApply = async () => {
    if (!method) { toast.error('Vui lòng chọn phương thức thanh toán'); return; }
    setSaving(true);
    try {
      await apiClient.patch('/invoices/bulk-update', {
        ids,
        updates: { payment_method: method },
        only_missing: onlyMissing,
      });
      toast.success(`Đã cập nhật PTTT cho ${ids.length} HĐ`);
      onClose();
    } catch { toast.error('Lỗi cập nhật. Vui lòng thử lại.'); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Khai báo thanh toán — ${ids.length} hóa đơn`} onClose={onClose}>
      <div className="p-5 space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">Phương thức thanh toán</label>
          <div className="flex gap-2 flex-wrap">
            {PAYMENT_METHODS.map(m => (
              <button
                key={m.value}
                type="button"
                onClick={() => setMethod(m.value)}
                className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${method === m.value ? 'bg-primary-600 text-white border-primary-600' : 'border-gray-300 text-gray-600 hover:border-primary-300'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {method === 'cash' && (
            <p className="mt-2 text-xs text-orange-600 bg-orange-50 rounded-lg px-2 py-1">
              ⚠️ HĐ &gt;5 triệu tiền mặt không được khấu trừ VAT đầu vào.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} className="rounded" />
          Chỉ áp dụng cho HĐ chưa khai báo thanh toán
        </label>
        <div className="flex gap-2 justify-end pt-2 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-xl text-sm text-gray-700">Hủy</button>
          <button
            onClick={handleApply}
            disabled={saving || !method}
            className="px-5 py-2 bg-primary-600 text-white rounded-xl text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Đang áp dụng...' : 'Áp dụng'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
