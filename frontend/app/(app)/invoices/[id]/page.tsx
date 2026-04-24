'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import apiClient from '../../../../lib/apiClient';

interface LineItem {
  id: string;
  line_number: number | null;
  item_code: string | null;
  item_name: string | null;
  unit: string | null;
  quantity: string | null;
  unit_price: string | null;
  subtotal: string | null;
  vat_rate: string | null;
  vat_amount: string | null;
  total: string | null;
  is_manual?: boolean;
}

interface Invoice {
  id: string;
  invoice_number: string;
  serial_number: string | null;
  invoice_date: string;
  direction: 'output' | 'input';
  status: string;
  provider: string;
  seller_name: string | null;
  seller_tax_code: string | null;
  buyer_name: string | null;
  buyer_tax_code: string | null;
  subtotal: string;
  vat_amount: string;
  vat_rate: string | null;
  total_amount: string;
  currency: string | null;
  payment_method: string | null;
  gdt_validated: boolean;
  gdt_validated_at: string | null;
  source: string | null;
  is_paid: boolean;
  payment_date: string | null;
  payment_due_date: string | null;
  created_at: string;
  line_items: LineItem[];
  invoice_group: number | null;
  has_line_items: boolean | null;
  raw_data: Record<string, unknown> | null;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  valid: { label: 'Hợp lệ', color: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Hủy', color: 'bg-red-100 text-red-700' },
  replaced: { label: 'Thay thế', color: 'bg-yellow-100 text-yellow-700' },
  adjusted: { label: 'Điều chỉnh', color: 'bg-orange-100 text-orange-700' },
  invalid: { label: 'Không hợp lệ', color: 'bg-gray-100 text-gray-700' },
};

const PROVIDER_LABELS: Record<string, string> = {
  gdt_intermediary: 'GDT',
  manual: 'Manual',
};

function fmt(val: string | null | undefined) {
  if (val == null) return '—';
  const n = Number(val);
  if (isNaN(n)) return '—';
  return n.toLocaleString('vi-VN') + 'đ';
}

function fmtDate(val: string | null | undefined) {
  if (!val) return '—';
  try { return format(new Date(val), 'dd/MM/yyyy', { locale: vi }); } catch { return val; }
}

/** Extract payment status text from GDT raw_data.ttkhac array. */
function getGdtPaymentStatus(rawData: Record<string, unknown> | null): string | null {
  if (!rawData) return null;
  const ttkhac = rawData['ttkhac'];
  if (!Array.isArray(ttkhac)) return null;
  const entry = (ttkhac as Array<Record<string, unknown>>).find(
    (e) => e['ttruong'] === 'Trạng thái thanh toán',
  );
  const val = entry?.['dlieu'];
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Manual line item form state
  const [itemName, setItemName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formMsg, setFormMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const reload = useCallback(() => {
    if (!id) return;
    apiClient.get<Invoice>(`/invoices/${id}`)
      .then((r: { data: { data?: Invoice } | Invoice }) => {
        const inv = (r.data as { data?: Invoice }).data ?? (r.data as Invoice);
        setInvoice(inv);
        // Pre-fill input if a manual item already exists
        const manual = inv.line_items?.find(li => li.is_manual);
        if (manual?.item_name) setItemName(manual.item_name);
      })
      .catch(() => setError('Không tìm thấy hóa đơn'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  const handleSaveItemName = async () => {
    if (!itemName.trim() || !id) return;
    setSaving(true);
    setFormMsg(null);
    try {
      await apiClient.post(`/invoices/${id}/line-items`, { item_name: itemName.trim() });
      setFormMsg({ type: 'ok', text: 'Đã lưu. Hóa đơn sẽ xuất hiện trong phụ lục NQ142 khi xuất XML.' });
      reload();
    } catch {
      setFormMsg({ type: 'err', text: 'Lỗi lưu. Vui lòng thử lại.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteManual = async () => {
    if (!id) return;
    setDeleting(true);
    setFormMsg(null);
    try {
      await apiClient.delete(`/invoices/${id}/line-items/manual`);
      setItemName('');
      setFormMsg({ type: 'ok', text: 'Đã xóa tên sản phẩm thủ công.' });
      reload();
    } catch {
      setFormMsg({ type: 'err', text: 'Lỗi xóa. Vui lòng thử lại.' });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-48">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="px-4 py-6">
        <button onClick={() => router.back()} className="text-primary-600 text-sm mb-4">← Quay lại</button>
        <p className="text-center text-gray-500 mt-12">{error || 'Không tìm thấy hóa đơn'}</p>
      </div>
    );
  }

  const statusInfo = STATUS_LABELS[invoice.status] ?? { label: invoice.status, color: 'bg-gray-100 text-gray-700' };
  const isOutput = invoice.direction === 'output';
  const subtotal = Number(invoice.subtotal);
  const vatAmt = Number(invoice.vat_amount);
  const total = Number(invoice.total_amount);
  const vatRate = invoice.vat_rate != null
    ? Number(invoice.vat_rate)
    : (subtotal > 0 ? Math.round(vatAmt * 100 / subtotal) : 0);

  const hasManualItem = invoice.line_items?.some(li => li.is_manual);
  const isHeaderOnly  = !invoice.has_line_items || invoice.line_items.length === 0 || hasManualItem;
  const isNq142Eligible = vatRate === 8 || invoice.invoice_group === 6 || invoice.invoice_group === 8;
  const showManualForm = isHeaderOnly && isNq142Eligible;

  // Separate "note" line items (replacement/adjustment descriptions with 0 value) from real items
  const isNoteItem = (li: LineItem) => {
    const name = (li.item_name ?? '').toLowerCase();
    const isZero = Number(li.total || 0) === 0 && Number(li.subtotal || 0) === 0;
    return isZero && (name.includes('hóa đơn thay thế') || name.includes('hóa đơn điều chỉnh') || name.includes('hóa đơn bị thay'));
  };
  const noteItems  = invoice.line_items?.filter(isNoteItem) ?? [];
  const realItems  = invoice.line_items?.filter(li => !isNoteItem(li)) ?? [];

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6 max-w-5xl mx-auto">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => router.back()} className="flex items-center gap-1 text-primary-600 text-sm font-medium hover:text-primary-700">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Quay lại
        </button>
        <div className="flex-1" />
        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${statusInfo.color}`}>{statusInfo.label}</span>
        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${isOutput ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
          {isOutput ? '↑ Bán ra' : '↓ Mua vào'}
        </span>
      </div>

      {/* ── Replacement note banner ── */}
      {noteItems.length > 0 && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          {noteItems.map((ni, i) => <p key={i}>📎 {ni.item_name}</p>)}
        </div>
      )}

      {/* ── Two-column layout on lg+ ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 items-start">

        {/* ════ LEFT COLUMN ════ */}
        <div className="space-y-4">

          {/* Invoice identity card */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <p className="text-2xl font-bold text-gray-900 leading-tight">{invoice.invoice_number}</p>
                {invoice.serial_number && <p className="text-sm text-gray-500 mt-0.5">Ký hiệu: <span className="font-mono">{invoice.serial_number}</span></p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-gray-400">Ngày lập</p>
                <p className="text-sm font-semibold text-gray-800">{fmtDate(invoice.invoice_date)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-500 border-t border-gray-50 pt-3">
              <span>Nguồn: <strong className="text-gray-700">{PROVIDER_LABELS[invoice.provider] ?? invoice.provider}</strong></span>
              {invoice.currency && invoice.currency !== 'VND' && <span>Tiền tệ: <strong className="text-gray-700">{invoice.currency}</strong></span>}
            </div>
          </div>

          {/* Parties card */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Bên tham gia</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="space-y-1">
                <p className="text-xs text-gray-400 font-medium">Người bán</p>
                <p className="text-sm font-semibold text-gray-900">{invoice.seller_name || '—'}</p>
                <p className="text-xs font-mono text-gray-500 bg-gray-50 rounded px-1.5 py-0.5 inline-block">{invoice.seller_tax_code || '—'}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-gray-400 font-medium">Người mua</p>
                <p className="text-sm font-semibold text-gray-900">{invoice.buyer_name || '—'}</p>
                <p className="text-xs font-mono text-gray-500 bg-gray-50 rounded px-1.5 py-0.5 inline-block">{invoice.buyer_tax_code || '—'}</p>
              </div>
            </div>
          </div>

          {/* Amounts card */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Giá trị</p>
            <div className="space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Tiền hàng (chưa VAT)</span>
                <span className="font-medium text-gray-900">{subtotal.toLocaleString('vi-VN')}đ</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Thuế GTGT {invoice.vat_rate != null ? `(${invoice.vat_rate}%)` : '(không chịu thuế)'}</span>
                <span className="font-medium text-gray-900">{vatAmt.toLocaleString('vi-VN')}đ</span>
              </div>
              <div className="border-t border-gray-100 pt-2.5 flex justify-between">
                <span className="font-semibold text-gray-900">Tổng thanh toán</span>
                <span className="font-bold text-xl text-gray-900">{total.toLocaleString('vi-VN')}đ</span>
              </div>
            </div>
          </div>
        </div>

        {/* ════ RIGHT COLUMN ════ */}
        <div className="space-y-4">

          {/* Line items card */}
          {realItems.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">
                Chi tiết hàng hóa / dịch vụ <span className="text-gray-300 font-normal">({realItems.length})</span>
              </p>
              <div className="space-y-3">
                {realItems.map((li, idx) => {
                  const qty        = Number(li.quantity) || 0;
                  const price      = Number(li.unit_price) || 0;
                  const liSubtotal = Number(li.subtotal) || 0;
                  const liVatRate  = Number(li.vat_rate) || 0;
                  const liVat      = Number(li.vat_amount) > 0 ? Number(li.vat_amount) : (liVatRate > 0 ? Math.round(liSubtotal * liVatRate / 100) : 0);
                  const liTotal    = Number(li.total) > 0 ? Number(li.total) : liSubtotal + liVat;
                  return (
                    <div key={li.id ?? idx} className={`rounded-xl p-3.5 border ${li.is_manual ? 'border-amber-200 bg-amber-50/60' : 'border-gray-100 bg-gray-50/40'}`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1">
                          {li.is_manual && <span className="text-xs bg-amber-100 text-amber-700 rounded px-1.5 py-0.5 font-medium mr-1.5">Thủ công</span>}
                          <span className="text-sm font-semibold text-gray-900">
                            {li.line_number ? `${li.line_number}. ` : ''}{li.item_name || 'Không tên'}
                          </span>
                          {li.item_code && <p className="text-xs text-gray-400 mt-0.5">Mã: <span className="font-mono">{li.item_code}</span></p>}
                        </div>
                        <span className="text-sm font-bold text-gray-900 whitespace-nowrap">{liTotal.toLocaleString('vi-VN')}đ</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 pt-1.5 border-t border-gray-100">
                        {qty > 0 && <span>{qty.toLocaleString('vi-VN')}{li.unit ? ` ${li.unit}` : ''}</span>}
                        {price > 0 && <span>× {price.toLocaleString('vi-VN')}đ</span>}
                        <span>Hàng: {liSubtotal.toLocaleString('vi-VN')}đ</span>
                        {li.vat_rate != null && <span>VAT {li.vat_rate}%: {liVat.toLocaleString('vi-VN')}đ</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual line item entry */}
          {showManualForm && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
              <div className="flex items-start gap-2 mb-4">
                <span className="text-amber-500 text-lg shrink-0">⚠️</span>
                <div>
                  <p className="text-sm font-semibold text-amber-800">Header-only — chưa có tên sản phẩm</p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Nhập tên hàng hóa để hóa đơn xuất hiện trong phụ lục NQ142.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-4 text-center">
                {[['SL', '1'], ['Giá trị', `${subtotal.toLocaleString('vi-VN')}đ`], [`VAT ${vatRate}%`, `${vatAmt.toLocaleString('vi-VN')}đ`]].map(([k, v]) => (
                  <div key={k} className="bg-white rounded-lg p-2 border border-amber-100">
                    <p className="text-xs text-gray-400 mb-0.5">{k}</p>
                    <p className="text-xs font-semibold text-gray-700">{v}</p>
                  </div>
                ))}
              </div>
              <input
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveItemName(); }}
                placeholder="VD: Cước viễn thông tháng 3/2026"
                className="w-full border border-amber-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white mb-3"
              />
              {formMsg && (
                <p className={`text-xs mb-2 ${formMsg.type === 'ok' ? 'text-green-700' : 'text-red-600'}`}>
                  {formMsg.type === 'ok' ? '✅' : '❌'} {formMsg.text}
                </p>
              )}
              <div className="flex gap-2">
                <button onClick={() => void handleSaveItemName()} disabled={saving || !itemName.trim()}
                  className="flex-1 bg-amber-600 text-white rounded-xl py-2 text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Đang lưu...' : hasManualItem ? 'Cập nhật tên' : 'Lưu tên sản phẩm'}
                </button>
                {hasManualItem && (
                  <button onClick={() => void handleDeleteManual()} disabled={deleting}
                    className="px-4 border border-red-200 text-red-600 rounded-xl py-2 text-sm hover:bg-red-50 disabled:opacity-50 transition-colors">
                    {deleting ? '...' : 'Xóa'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Payment & Validation card */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Thanh toán & Xác thực</p>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Phương thức TT</span>
                <span className="font-medium text-gray-800">{invoice.payment_method || '—'}</span>
              </div>
              {invoice.payment_date && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Ngày TT</span>
                  <span className="font-medium text-gray-800">{fmtDate(invoice.payment_date)}</span>
                </div>
              )}
              {invoice.payment_due_date && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Hạn TT</span>
                  <span className="font-medium text-gray-800">{fmtDate(invoice.payment_due_date)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Đã thanh toán</span>
                {(() => {
                  const gdtStatus = getGdtPaymentStatus(invoice.raw_data);
                  if (gdtStatus) {
                    const isPaid = !gdtStatus.toLowerCase().includes('chưa');
                    return <span className={isPaid ? 'text-green-600 font-semibold' : 'text-gray-400'}>{gdtStatus}</span>;
                  }
                  return <span className={invoice.is_paid ? 'text-green-600 font-semibold' : 'text-gray-400'}>{invoice.is_paid ? 'Có' : 'Chưa'}</span>;
                })()}
              </div>
              <div className="flex justify-between pt-1 border-t border-gray-50">
                <span className="text-gray-500">GDT xác nhận</span>
                <span className={invoice.gdt_validated ? 'text-green-600 font-semibold' : 'text-yellow-600'}>
                  {invoice.gdt_validated
                    ? `✓ Đã xác nhận${invoice.gdt_validated_at ? ' · ' + fmtDate(invoice.gdt_validated_at) : ''}`
                    : '○ Chờ xác nhận'}
                </span>
              </div>
            </div>
          </div>

          <p className="text-center text-xs text-gray-400">Nhập lúc: {fmtDate(invoice.created_at)}</p>
        </div>
        {/* END RIGHT COLUMN */}
      </div>
    </div>
  );
}
