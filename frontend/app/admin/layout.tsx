'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import axios from 'axios';
import apiClient, { setAccessToken } from '../../lib/apiClient';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const NAV_ITEMS = [
  { href: '/admin',                    label: 'Tổng quan',        icon: '📊' },
  { href: '/admin/users',              label: 'Người dùng',       icon: '👥' },
  { href: '/admin/plans',              label: 'Gói dịch vụ',      icon: '💼' },
  { href: '/admin/analytics',          label: 'Phân tích',        icon: '📈' },
  { href: '/admin/crawler-recipes',    label: 'Crawler Recipes',  icon: '🔧' },
];

function SidebarContent({ pathname, onClose }: { pathname: string; onClose?: () => void }) {
  return (
    <>
      <div className="px-5 mb-6 flex items-center justify-between">
        <span className="text-xs font-bold tracking-wider text-indigo-600 uppercase">
          Admin Panel
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 p-1 text-xl leading-none"
            aria-label="Đóng menu"
          >
            ✕
          </button>
        )}
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV_ITEMS.map(({ href, label, icon }) => {
          const active = pathname === href || (href !== '/admin' && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <span className="text-base">{icon}</span>
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 pt-4 border-t border-gray-200">
        <Link href="/dashboard" className="text-xs text-gray-400 hover:text-gray-600">
          ← Về Dashboard
        </Link>
      </div>
    </>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [checking, setChecking]     = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    axios
      .post<{ data: { accessToken: string } }>(
        `${API_URL}/api/auth/refresh`,
        {},
        { withCredentials: true },
      )
      .then((res) => {
        setAccessToken(res.data.data.accessToken);
        return apiClient.get<{ data: { is_platform_admin?: boolean } }>('/auth/me');
      })
      .then((res) => {
        if (!res.data.data.is_platform_admin) {
          router.replace('/dashboard');
        } else {
          setChecking(false);
        }
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  // Close drawer whenever route changes
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500 text-sm">Đang xác thực quyền admin…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Mobile top bar ──────────────────────────────────────────────── */}
      <header className="md:hidden fixed top-0 inset-x-0 z-30 bg-white border-b border-gray-200 flex items-center px-4 h-14 shadow-sm">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 mr-3 text-xl leading-none"
          aria-label="Mở menu"
        >
          ☰
        </button>
        <span className="text-sm font-bold text-indigo-600 uppercase tracking-wider">Admin Panel</span>
      </header>

      {/* ── Mobile backdrop ─────────────────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile sidebar drawer ───────────────────────────────────────── */}
      <aside
        className={`md:hidden fixed top-0 left-0 bottom-0 z-50 w-64 bg-white border-r border-gray-200 flex flex-col pt-6 pb-4 shadow-xl transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarContent pathname={pathname} onClose={() => setMobileOpen(false)} />
      </aside>

      {/* ── Desktop layout ───────────────────────────────────────────────── */}
      <div className="flex min-h-screen">
        {/* Desktop sidebar — always visible on md+ */}
        <aside className="hidden md:flex w-56 shrink-0 bg-white border-r border-gray-200 flex-col pt-6 pb-4">
          <SidebarContent pathname={pathname} />
        </aside>

        {/* Main content — top padding on mobile to clear fixed top bar */}
        <main className="flex-1 min-w-0 overflow-auto p-4 md:p-6 pt-[72px] md:pt-6">
          {children}
        </main>
      </div>
    </div>
  );
}
