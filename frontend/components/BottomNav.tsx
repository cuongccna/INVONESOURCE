'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useView } from '../contexts/ViewContext';

const DRAWER_SECTIONS = [
  {
    title: '📊 Phân Tích',
    items: [
      { href: '/reports/trends', label: 'Báo cáo xu hướng' },
      { href: '/reports/monthly', label: 'Báo cáo tháng' },
      { href: '/compare', label: 'So sánh công ty' },
    ],
  },
  {
    title: '👥 Khách Hàng (CRM)',
    items: [
      { href: '/crm/customers', label: 'Danh sách & RFM' },
      { href: '/crm/repurchase', label: 'Dự đoán mua lại' },
      { href: '/crm/aging', label: 'Báo cáo nợ' },
    ],
  },
  {
    title: '🏭 Nhà Cung Cấp',
    items: [
      { href: '/vendors', label: 'Tổng quan NCC' },
      { href: '/vendors/price-alerts', label: 'Cảnh báo giá' },
    ],
  },
  {
    title: '📦 Sản Phẩm',
    items: [
      { href: '/products/profitability', label: 'Lợi nhuận sản phẩm' },
    ],
  },
  {
    title: '💰 Dòng Tiền',
    items: [
      { href: '/cashflow', label: 'Dự báo 90 ngày' },
    ],
  },
  {
    title: '🔍 Kiểm Toán AI',
    items: [
      { href: '/audit/anomalies', label: 'Phát hiện bất thường' },
      { href: '/settings/audit-rules', label: 'Cấu hình quy tắc' },
    ],
  },
  {
    title: '🏢 Đa Công Ty',
    items: [
      { href: '/portfolio', label: 'Danh mục tổng' },
    ],
  },
];

const DRAWER_HREFS = DRAWER_SECTIONS.flatMap((s) => s.items.map((i) => i.href));

export default function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { mode, orgId } = useView();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const homeHref = mode === 'portfolio'
    ? '/portfolio'
    : mode === 'group' && orgId
      ? `/group/${orgId}`
      : '/dashboard';

  const isDrawerActive = !!pathname && DRAWER_HREFS.some((h) => pathname.startsWith(h));

  const mainItems = [
    {
      href: homeHref,
      label: 'Tổng Quan',
      matchPrefix: ['/dashboard', '/portfolio', '/group/'],
      icon: (active: boolean) => (
        <svg className={`w-6 h-6 ${active ? 'text-primary-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      ),
    },
    {
      href: '/invoices',
      label: 'Hóa Đơn',
      matchPrefix: ['/invoices'],
      icon: (active: boolean) => (
        <svg className={`w-6 h-6 ${active ? 'text-primary-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
    {
      href: '/declarations',
      label: 'Tờ Khai',
      matchPrefix: ['/declarations'],
      icon: (active: boolean) => (
        <svg className={`w-6 h-6 ${active ? 'text-primary-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      ),
    },
  ];

  return (
    <>
      {/* Drawer overlay */}
      {drawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-50"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Drawer panel — must be bottom-0 so translate-y-full hides it completely */}
      <div
        className={`fixed bottom-0 inset-x-0 bg-white rounded-t-2xl z-50 transition-transform duration-300 shadow-2xl max-h-[75vh] overflow-y-auto ${
          drawerOpen ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 sticky top-0 bg-white">
          <span className="font-semibold text-gray-800">Tất Cả Tính Năng</span>
          <button onClick={() => setDrawerOpen(false)} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4 pb-6">
          {DRAWER_SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                {section.title}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {section.items.map((item) => {
                  const active = !!pathname && pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        active
                          ? 'bg-primary-50 text-primary-700'
                          : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom navigation bar */}
      <nav className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 z-40 pb-safe">
        <div className="flex justify-around items-center h-16 max-w-lg mx-auto">
          {mainItems.map((item) => {
            const active = !!pathname && item.matchPrefix.some((p) =>
              p.startsWith('/group/') ? pathname.startsWith('/group/') : pathname.startsWith(p)
            );
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center gap-1 flex-1 py-2"
              >
                {item.icon(active)}
                <span className={`text-xs font-medium ${active ? 'text-primary-600' : 'text-gray-400'}`}>
                  {item.label}
                </span>
              </Link>
            );
          })}

          {/* "AI & Báo Cáo" drawer trigger */}
          <button
            onClick={() => setDrawerOpen((o) => !o)}
            className="flex flex-col items-center gap-1 flex-1 py-2"
          >
            <svg
              className={`w-6 h-6 ${isDrawerActive || drawerOpen ? 'text-primary-600' : 'text-gray-400'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <span className={`text-xs font-medium ${isDrawerActive || drawerOpen ? 'text-primary-600' : 'text-gray-400'}`}>
              Thêm
            </span>
          </button>

          {/* Settings */}
          <Link href="/settings" className="flex flex-col items-center gap-1 flex-1 py-2">
            <svg
              className={`w-6 h-6 ${!!pathname && pathname.startsWith('/settings') ? 'text-primary-600' : 'text-gray-400'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className={`text-xs font-medium ${!!pathname && pathname.startsWith('/settings') ? 'text-primary-600' : 'text-gray-400'}`}>
              Cài Đặt
            </span>
          </Link>
        </div>
      </nav>
    </>
  );
}
