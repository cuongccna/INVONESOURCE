'use client';

import Link from 'next/link';

const SETTINGS_SECTIONS = [
  {
    title: 'Công ty',
    items: [
      { href: '/settings/companies', label: 'Danh sách công ty', desc: 'Quản lý các công ty của bạn', icon: '🏢' },
      { href: '/settings/organizations', label: 'Tập đoàn / Nhóm', desc: 'Cấu trúc công ty đa cấp', icon: '🏛️' },
    ],
  },
  {
    title: 'Kết nối & Đồng bộ',
    items: [
      { href: '/settings/connectors', label: 'GDT Bot — Đồng bộ tự động', desc: 'Cấu hình tài khoản cổng thuế, lịch đồng bộ', icon: '🤖' },
      { href: '/settings/sync-logs', label: 'Lịch sử đồng bộ', desc: 'Nhật ký và trạng thái đồng bộ', icon: '📋' },
    ],
  },
  {
    title: 'Tài khoản',
    items: [
      { href: '/settings/profile', label: 'Hồ sơ cá nhân', desc: 'Thông tin và mật khẩu', icon: '👤' },
    ],
  },
];

export default function SettingsIndexPage() {
  return (
    <div className="p-4 max-w-2xl lg:max-w-5xl mx-auto space-y-5">
      <h1 className="text-2xl font-bold text-gray-900">Cài Đặt</h1>
      {SETTINGS_SECTIONS.map((section) => (
        <div key={section.title}>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-2 px-1">
            {section.title}
          </p>
          <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-50 overflow-hidden">
            {section.items.map((item) => (
              <Link key={item.href} href={item.href}
                className="flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors">
                <span className="text-xl w-8 text-center shrink-0">{item.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{item.label}</p>
                  <p className="text-xs text-gray-400">{item.desc}</p>
                </div>
                <span className="text-gray-300 text-lg">›</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
