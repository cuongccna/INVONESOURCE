'use client';

import Link from 'next/link';

const REPORT_GROUPS = [
  {
    title: '📊 Báo cáo tổng hợp',
    items: [
      { href: '/reports/invoices', icon: '📄', title: 'Báo cáo hóa đơn', desc: 'Lọc và xuất danh sách hóa đơn theo kỳ, loại, trạng thái', color: 'bg-blue-50 text-blue-700 border-blue-100' },
      { href: `/reports/monthly/${new Date().getFullYear()}/${new Date().getMonth() + 1}`, icon: '📊', title: 'Báo cáo tháng', desc: 'Tóm tắt doanh thu, thuế GTGT, top đối tác — in được (A4)', color: 'bg-green-50 text-green-700 border-green-100' },
      { href: '/reports/revenue-expense', icon: '💹', title: 'Doanh thu & Chi phí', desc: 'Phân tích theo thuế suất, top khách hàng & nhà cung cấp', color: 'bg-teal-50 text-teal-700 border-teal-100' },
      { href: '/reports/profit-loss', icon: '📈', title: 'Kết quả HĐKD (B02-DN)', desc: 'Lợi nhuận gộp, chi phí bán hàng, QLDN, lợi nhuận sau thuế', color: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
    ],
  },
  {
    title: '📒 Kế toán chi tiết',
    items: [
      { href: '/reports/sales-journal', icon: '📑', title: 'Bảng kê bán ra / mua vào', desc: 'Bảng kê theo thuế suất 0%/5%/8%/10% tương thích HTKK', color: 'bg-indigo-50 text-indigo-700 border-indigo-100' },
      { href: '/reports/inventory', icon: '📦', title: 'Xuất Nhập Tồn (XNT)', desc: 'Tồn kho từ hóa đơn — không cần phần mềm kho riêng', color: 'bg-amber-50 text-amber-700 border-amber-100' },
      { href: '/reports/cash-book', icon: '💵', title: 'Sổ Quỹ Tiền', desc: 'Phiếu thu chi, số dư luỹ kế, tự đồng bộ từ hóa đơn', color: 'bg-yellow-50 text-yellow-700 border-yellow-100' },
    ],
  },
  {
    title: '🧾 Khai báo thuế',
    items: [
      { href: '/declarations', icon: '📋', title: 'Tờ khai 01/GTGT', desc: 'Tờ khai thuế GTGT khấu trừ — tải XML HTKK nộp GDT', color: 'bg-purple-50 text-purple-700 border-purple-100' },
      { href: '/declarations/hkd', icon: '🏪', title: 'Hộ kinh doanh (HKD)', desc: 'Tính thuế khoán VAT + TNCN, cảnh báo ngưỡng 8.33 triệu', color: 'bg-rose-50 text-rose-700 border-rose-100' },
    ],
  },
  {
    title: '🗂️ Danh mục',
    items: [
      { href: '/catalogs/products', icon: '🏷️', title: 'Danh mục hàng hóa', desc: 'Mã hàng hóa tự động, danh mục, giá mua/bán trung bình', color: 'bg-gray-50 text-gray-700 border-gray-200' },
      { href: '/catalogs/customers', icon: '👥', title: 'Danh mục khách hàng', desc: 'Mã KH tự động theo tỉnh/thành, doanh thu 12 tháng', color: 'bg-gray-50 text-gray-700 border-gray-200' },
      { href: '/catalogs/suppliers', icon: '🏭', title: 'Danh mục nhà cung cấp', desc: 'Mã NCC tự động, chi tiêu 12 tháng', color: 'bg-gray-50 text-gray-700 border-gray-200' },
    ],
  },
];

export default function ReportsPage() {
  return (
    <div className="p-4 max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Báo Cáo & Kê Khai</h1>
        <p className="text-sm text-gray-500 mt-1">Toàn bộ báo cáo kế toán và thuế</p>
      </div>

      {REPORT_GROUPS.map((g) => (
        <div key={g.title}>
          <p className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">{g.title}</p>
          <div className="space-y-2">
            {g.items.map((r) => (
              <Link
                key={r.href}
                href={r.href}
                className={`flex items-start gap-4 p-4 rounded-xl border ${r.color} hover:opacity-90 transition-opacity`}
              >
                <span className="text-2xl">{r.icon}</span>
                <div>
                  <p className="font-semibold">{r.title}</p>
                  <p className="text-sm opacity-70 mt-0.5">{r.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

