'use client';

import Link from 'next/link';

const REPORTS = [
  {
    href: '/reports/invoices',
    icon: '📄',
    title: 'Báo cáo hóa đơn',
    desc: 'Lọc và xuất danh sách hóa đơn theo kỳ, loại, trạng thái',
    color: 'bg-blue-50 text-blue-700 border-blue-100',
  },
  {
    href: `/reports/monthly/${new Date().getFullYear()}/${new Date().getMonth() + 1}`,
    icon: '📊',
    title: 'Báo cáo tháng',
    desc: 'Tóm tắt doanh thu, thuế GTGT, top đối tác — in được (A4)',
    color: 'bg-green-50 text-green-700 border-green-100',
  },
  {
    href: '/declarations',
    icon: '📋',
    title: 'Tờ khai 01/GTGT',
    desc: 'Tờ khai thuế GTGT đã tính — tải XML HTKK nộp GDT',
    color: 'bg-purple-50 text-purple-700 border-purple-100',
  },
];

export default function ReportsPage() {
  return (
    <div className="p-4 max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Báo Cáo</h1>
        <p className="text-sm text-gray-500 mt-1">Xuất báo cáo và bảng kê</p>
      </div>

      <div className="space-y-3">
        {REPORTS.map((r) => (
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
  );
}
