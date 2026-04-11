'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useCompany } from '../contexts/CompanyContext';
import { useView } from '../contexts/ViewContext';
import NotificationPanel from './NotificationPanel';
import apiClient from '../lib/apiClient';
import { DRAWER_SECTIONS, DRAWER_HREFS } from '../lib/navSections';

interface UnreadCount {
  count: number;
}

export default function Header() {
  const { companies, activeCompany, setActiveCompanyId, loading } = useCompany();
  const { mode, orgId, setSingleCompany, setPortfolio, setGroup } = useView();
  const router = useRouter();
  const pathname = usePathname();
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showNotif, setShowNotif] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const switcherRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Fetch unread count on mount + every 30s
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const res = await apiClient.get<{ data: UnreadCount }>('/notifications/unread-count');
        setUnreadCount(res.data.data.count);
      } catch {
        // silent
      }
    };
    void fetchCount();
    const interval = setInterval(() => void fetchCount(), 30_000);
    return () => clearInterval(interval);
  }, [activeCompany?.id]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotif(false);
      }
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close "Thêm" dropdown on route change
  useEffect(() => { setShowMore(false); }, [pathname]);

  const handleMarkAllRead = () => setUnreadCount(0);

  const handleLogout = async () => {
    try { await apiClient.post('/auth/logout'); } catch { /* ignore */ }
    router.push('/login');
  };

  const activeOrgId = activeCompany?.organization_id ?? orgId ?? null;
  const modeTitle = mode === 'portfolio'
    ? 'Toàn bộ doanh nghiệp'
    : mode === 'group'
      ? 'Hợp nhất theo nhóm'
      : (activeCompany?.name ?? 'Chọn công ty');
  const modeSubtitle = mode === 'single'
    ? (activeCompany?.tax_code ?? '—')
    : mode === 'group'
      ? `Tổ chức: ${activeOrgId ?? 'Chưa xác định'}`
      : `${companies.length} công ty trong danh mục`;

  const homeHref = mode === 'portfolio'
    ? '/portfolio'
    : mode === 'group' && activeOrgId
      ? `/group/${activeOrgId}`
      : '/dashboard';

  return (
    <header className="fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-100 shadow-sm">
      <div className="max-w-2xl lg:max-w-5xl mx-auto flex items-center justify-between px-4 h-14">
        {/* Company Switcher */}
        <div ref={switcherRef} className="relative flex-1 min-w-0 mr-2">
          <button
            onClick={() => setShowSwitcher((v) => !v)}
            className="flex items-center gap-1.5 max-w-full text-left min-w-0"
            disabled={loading}
          >
            <div className="w-7 h-7 rounded-lg bg-primary-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {mode === 'portfolio' ? 'P' : mode === 'group' ? 'G' : (activeCompany?.name?.[0]?.toUpperCase() ?? '?')}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate leading-tight">
                {modeTitle}
              </div>
              <div className="text-xs text-gray-400 leading-tight">
                {modeSubtitle}
              </div>
            </div>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase ${
                mode === 'single'
                  ? 'bg-blue-50 text-blue-700'
                  : mode === 'group'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700'
              }`}
            >
              {mode}
            </span>
            {companies.length > 0 && (
              <svg
                className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${showSwitcher ? 'rotate-180' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </button>

          {showSwitcher && companies.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-72 max-w-[calc(100vw-2rem)] bg-white rounded-xl shadow-lg border border-gray-100 overflow-hidden z-50">
              <div className="border-b border-gray-100 p-2 space-y-1.5">
                <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Chế độ xem</p>
                <button
                  onClick={() => {
                    if (!activeCompany?.id) return;
                    setSingleCompany(activeCompany.id);
                    setShowSwitcher(false);
                    router.push('/dashboard');
                  }}
                  className={`w-full px-3 py-2 rounded-lg text-left text-sm font-medium transition-colors ${
                    mode === 'single' ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  Đơn vị đơn lẻ
                </button>
                <button
                  onClick={() => {
                    setPortfolio();
                    setShowSwitcher(false);
                    router.push('/portfolio');
                  }}
                  className={`w-full px-3 py-2 rounded-lg text-left text-sm font-medium transition-colors ${
                    mode === 'portfolio' ? 'bg-amber-50 text-amber-700' : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  Danh mục toàn bộ
                </button>
                <button
                  onClick={() => {
                    if (!activeOrgId) return;
                    setGroup(activeOrgId);
                    setShowSwitcher(false);
                    router.push(`/group/${activeOrgId}`);
                  }}
                  disabled={!activeOrgId}
                  className={`w-full px-3 py-2 rounded-lg text-left text-sm font-medium transition-colors ${
                    mode === 'group' ? 'bg-emerald-50 text-emerald-700' : 'hover:bg-gray-50 text-gray-700'
                  } disabled:bg-gray-100 disabled:text-gray-400`}
                >
                  Hợp nhất theo nhóm
                </button>
              </div>
              <div className="p-2">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Công ty</p>
                {companies.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setActiveCompanyId(c.id);
                      setSingleCompany(c.id);
                      setShowSwitcher(false);
                      router.push('/dashboard');
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                      c.id === activeCompany?.id
                        ? 'bg-primary-50 text-primary-700'
                        : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {c.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-xs text-gray-400">{c.tax_code}</div>
                    </div>
                    {c.id === activeCompany?.id && (
                      <svg className="w-4 h-4 text-primary-600 ml-auto flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <div className="border-t border-gray-100 p-2">
                <Link
                  href="/settings/companies"
                  onClick={() => setShowSwitcher(false)}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-primary-600 hover:bg-primary-50 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Thêm công ty
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Desktop navigation links — hidden on mobile */}
        <nav className="hidden lg:flex items-center gap-1 mx-4">
          {[
            { href: homeHref, label: 'Tổng Quan', matchPrefix: ['/dashboard', '/portfolio', '/group/'] },
            { href: '/invoices', label: 'Hóa Đơn', matchPrefix: ['/invoices'] },
            { href: '/declarations', label: 'Tờ Khai', matchPrefix: ['/declarations'] },
            { href: '/import', label: 'Nhập Liệu', matchPrefix: ['/import'] },
            { href: '/settings/bot', label: 'Cài Đặt GDT', matchPrefix: ['/settings/connectors', '/settings/bot'] },
          ].map((item) => {
            const active = item.matchPrefix.some((p) => pathname.startsWith(p));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  active ? 'bg-primary-50 text-primary-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}

          {/* Thêm dropdown — mirrors mobile drawer */}
          <div ref={moreRef} className="relative">
            <button
              onClick={() => setShowMore((v) => !v)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                (!!pathname && DRAWER_HREFS.some((h) => pathname.startsWith(h))) || showMore
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              Thêm
              <svg className={`w-3.5 h-3.5 transition-transform ${showMore ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showMore && (
              <div className="absolute top-full right-0 mt-1 w-[640px] max-w-[calc(100vw-1rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 max-h-[80vh] overflow-y-auto">
                <div className="p-4 grid grid-cols-2 gap-x-6 gap-y-4">
                  {DRAWER_SECTIONS.map((section) => (
                    <div key={section.title}>
                      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                        {section.title}
                      </p>
                      <div className="space-y-0.5">
                        {section.items.map((item) => {
                          const active = !!pathname && pathname.startsWith(item.href);
                          return (
                            <Link
                              key={item.href}
                              href={item.href}
                              onClick={() => setShowMore(false)}
                              className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                                active ? 'bg-primary-50 text-primary-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
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
            )}
          </div>
        </nav>

        {/* Right: Settings + Notification bell */}
        <div className="flex items-center gap-1">
          {/* Settings dropdown */}
          <div ref={settingsRef} className="relative">
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
              aria-label="Cài đặt"
            >
              <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </button>
            {showSettings && (
              <div className="absolute top-full right-0 mt-1 w-52 bg-white rounded-xl shadow-lg border border-gray-100 py-1.5 z-50">
                <Link href="/settings/profile" onClick={() => setShowSettings(false)}
                  className="flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  Hồ sơ cá nhân
                </Link>
                <Link href="/settings/sync-logs" onClick={() => setShowSettings(false)}
                  className="flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Lịch sử đồng bộ
                </Link>
                <Link href="/settings/bot" onClick={() => setShowSettings(false)}
                  className="flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Cài đặt GDT
                </Link>
                <Link href="/settings/companies" onClick={() => setShowSettings(false)}
                  className="flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
                  <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-2 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  Quản lý công ty
                </Link>
                <div className="border-t border-gray-100 mt-1 pt-1">
                  <button
                    onClick={() => void handleLogout()}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                    </svg>
                    Đăng xuất
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Notification bell */}
          <div ref={notifRef} className="relative">
          <button
            onClick={() => setShowNotif((v) => !v)}
            className="relative w-9 h-9 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
            aria-label="Thông báo"
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {showNotif && (
            <NotificationPanel
              onClose={() => setShowNotif(false)}
              onMarkAllRead={handleMarkAllRead}
            />
          )}
        </div>
        </div>
      </div>
    </header>
  );
}
