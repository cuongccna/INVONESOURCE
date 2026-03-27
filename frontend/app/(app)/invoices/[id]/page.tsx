'use client';

import { useEffect, useState } from 'react';
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
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  valid: { label: 'Hợp lệ', color: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Hủy', color: 'bg-red-100 text-red-700' },
  replaced: { label: 'Thay thế', color: 'bg-yellow-100 text-yellow-700' },
  adjusted: { label: 'Điều chỉnh', color: 'bg-orange-100 text-orange-700' },
  invalid: { label: 'Không hợp lệ', color: 'bg-gray-100 text-gray-700' },
};

const PROVIDER_LABELS: Record<string, string> = {
  misa: 'MISA',
  viettel: 'Viettel',
  bkav: 'BKAV',
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

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    apiClient.get<Invoice>(`/invoices/${id}`)
      .then((r: { data: { data?: Invoice } | Invoice }) => setInvoice((r.data as { data?: Invoice }).data ?? (r.data as Invoice)))
      .catch(() => setError('Không tìm thấy hóa đơn'))
      .finally(() => setLoading(false));
  }, [id]);

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

  return (
    <div className="px-4 py-6 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => router.back()} className="text-primary-600 text-sm font-medium">← Quay lại</button>
        <h1 className="text-xl font-bold text-gray-900 flex-1">Chi tiết Hóa Đơn</h1>
        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusInfo.color}`}>{statusInfo.label}</span>
      </div>

      {/* Invoice ID section */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-3">
        <div className="flex justify-between items-center mb-2">
          <span className="text-2xl font-bold text-gray-900">{invoice.invoice_number}</span>
          <span className={`px-2 py-1 rounded text-xs font-medium ${isOutput ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
            {isOutput ? 'Bán ra' : 'Mua vào'}
          </span>
        </div>
        {invoice.serial_number && (
          <p className="text-sm text-gray-500">Ký hiệu: {invoice.serial_number}</p>
        )}
        <p className="text-sm text-gray-500">Ngày lập: {fmtDate(invoice.invoice_date)}</p>
        <p className="text-sm text-gray-500">Nguồn: {PROVIDER_LABELS[invoice.provider] ?? invoice.provider}</p>
      </div>

      {/* Parties */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase mb-3">Bên tham gia</p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-400 mb-1">Người bán</p>
            <p className="text-sm font-medium text-gray-900">{invoice.seller_name || '—'}</p>
            <p className="text-xs text-gray-500">{invoice.seller_tax_code || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-gray-400 mb-1">Người mua</p>
            <p className="text-sm font-medium text-gray-900">{invoice.buyer_name || '—'}</p>
            <p className="text-xs text-gray-500">{invoice.buyer_tax_code || '—'}</p>
          </div>
        </div>
      </div>

      {/* Amounts */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase mb-3">Giá trị</p>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Tiền hàng (chưa VAT)</span>
            <span className="font-medium">{subtotal.toLocaleString('vi-VN')}đ</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">
              Thuế GTGT {invoice.vat_rate != null ? `(${invoice.vat_rate}%)` : '(KCT)'}
            </span>
            <span className="font-medium">{vatAmt.toLocaleString('vi-VN')}đ</span>
          </div>
          <div className="border-t pt-2 flex justify-between">
            <span className="font-semibold text-gray-900">Tổng tiền thanh toán</span>
            <span className="font-bold text-lg text-gray-900">{total.toLocaleString('vi-VN')}đ</span>
          </div>
        </div>
        {invoice.currency && invoice.currency !== 'VND' && (
          <p className="text-xs text-gray-400 mt-2">Tiền tệ: {invoice.currency}</p>
        )}
      </div>

      {/* Line Items */}
      {invoice.line_items && invoice.line_items.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-4 mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase mb-3">
            Chi tiết hàng hóa / dịch vụ ({invoice.line_items.length})
          </p>
          <div className="space-y-3">
            {invoice.line_items.map((li, idx) => {
              const qty = Number(li.quantity) || 0;
              const price = Number(li.unit_price) || 0;
              const liSubtotal = Number(li.subtotal) || 0;
              const liVat = Number(li.vat_amount) || 0;
              const liTotal = Number(li.total) || 0;
              return (
                <div key={li.id ?? idx} className="border border-gray-100 rounded-lg p-3">
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {li.line_number ? `${li.line_number}. ` : ''}{li.item_name || 'Không tên'}
                      </p>
                      {li.item_code && (
                        <p className="text-xs text-gray-400">Mã: {li.item_code}</p>
                      )}
                    </div>
                    <span className="text-sm font-semibold text-gray-900 ml-2 whitespace-nowrap">
                      {liTotal.toLocaleString('vi-VN')}đ
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    {li.unit && <span>{qty.toLocaleString('vi-VN')} {li.unit}</span>}
                    {price > 0 && <span>× {price.toLocaleString('vi-VN')}đ</span>}
                    <span>Tiền hàng: {liSubtotal.toLocaleString('vi-VN')}đ</span>
                    {li.vat_rate != null && <span>VAT {li.vat_rate}%: {liVat.toLocaleString('vi-VN')}đ</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Payment & Validation */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-3">
        <p className="text-xs font-semibold text-gray-400 uppercase mb-3">Thanh toán & Xác thực</p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Phương thức TT</span>
            <span>{invoice.payment_method || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Ngày TT</span>
            <span>{fmtDate(invoice.payment_date)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Hạn TT</span>
            <span>{fmtDate(invoice.payment_due_date)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Đã thanh toán</span>
            <span className={invoice.is_paid ? 'text-green-600 font-medium' : 'text-gray-400'}>{invoice.is_paid ? 'Có' : 'Chưa'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">GDT xác nhận</span>
            <span className={invoice.gdt_validated ? 'text-green-600 font-medium' : 'text-yellow-600'}>
              {invoice.gdt_validated ? `Đã xác nhận${invoice.gdt_validated_at ? ' ' + fmtDate(invoice.gdt_validated_at) : ''}` : 'Chờ xác nhận'}
            </span>
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-gray-400 mt-4">Nhập lúc: {fmtDate(invoice.created_at)}</p>
    </div>
  );
}
