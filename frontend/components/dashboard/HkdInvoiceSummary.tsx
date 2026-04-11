'use client';

import { formatVNDCompact } from '../../utils/formatCurrency';

interface HkdInvoiceSummaryProps {
  invoiceCount: number;
  totalValue: number;
  above20mCount: number;
  totalTax: number;
}

export function HkdInvoiceSummary({ invoiceCount, totalValue, above20mCount, totalTax }: HkdInvoiceSummaryProps) {
  const compact = (n: number | string) => formatVNDCompact(n).replace(/\s*₫$/, '');
  return (
    <div className="bg-white rounded-xl shadow-sm p-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3">🧾 Hóa Đơn Mua Vào</h2>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Tổng hóa đơn</span>
          <span className="font-medium">{invoiceCount} hóa đơn</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Tổng giá trị</span>
          <span className="font-medium">{compact(totalValue)} ₫</span>
        </div>
        {above20mCount > 0 && (
          <div className="flex justify-between text-amber-700 bg-amber-50 rounded px-2 py-1">
            <span>⚠ HĐ &gt;20Tr cần thanh toán phi tiền mặt</span>
            <span className="font-medium">{above20mCount} HĐ</span>
          </div>
        )}
        <div className="pt-1 border-t border-gray-100 flex justify-between">
          <span className="text-gray-500">Tổng thuế khoán phải nộp</span>
          <span className="font-semibold text-red-600">{compact(totalTax)} ₫</span>
        </div>
      </div>
    </div>
  );
}
