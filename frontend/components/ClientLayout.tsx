'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import axios from 'axios';
import { setAccessToken } from '../lib/apiClient';
import { CompanyProvider } from '../contexts/CompanyContext';
import { ViewProvider, useView } from '../contexts/ViewContext';
import { SyncProvider, useSyncContext } from '../contexts/SyncContext';
import Header from './Header';
import BottomNav from './BottomNav';
import SyncProgressPanel from './SyncProgressPanel';
import { useCompany } from '../contexts/CompanyContext';
import { usePushSubscription } from '../lib/usePushSubscription';
import BackButton from './BackButton';
import { buildRouteKey, pushNavigationEntry } from '../lib/navigationHistory';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Renders the floating sync progress panel, persists across all page navigations. */
function SyncOverlay() {
  const { syncJobIds, syncCompanyId, clearSync } = useSyncContext();
  if (syncJobIds.length === 0) return null;
  return (
    <div className="fixed bottom-20 lg:bottom-6 inset-x-0 z-40 px-4" style={{ maxWidth: '42rem', left: '50%', transform: 'translateX(-50%)' }}>
      <SyncProgressPanel
        jobIds={syncJobIds}
        companyId={syncCompanyId}
        onClose={clearSync}
        onDone={clearSync}
      />
    </div>
  );
}

/** Redirects to company creation when user has no companies yet, except on the settings page itself. */
function NoCompanyGuard() {
  const { companies, loading } = useCompany();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (companies.length === 0 && pathname !== '/settings/companies') {
      router.replace('/settings/companies');
    }
  }, [loading, companies.length, pathname, router]);

  return null;
}

function NavigationHistoryTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!pathname) return;
    const routeKey = buildRouteKey(pathname, searchParams);
    pushNavigationEntry(routeKey);
  }, [pathname, searchParams]);

  return null;
}

function GlobalBackStrip() {
  const pathname = usePathname();
  const { mode, orgId } = useView();

  const homeHref = mode === 'portfolio'
    ? '/portfolio'
    : mode === 'group' && orgId
      ? `/group/${orgId}`
      : '/dashboard';

  const isHomeRoute = pathname === '/dashboard'
    || pathname === '/portfolio'
    || (pathname?.startsWith('/group/') && pathname.split('/').length === 3);

  const hasLocalBackControl = !!pathname && [
    '/import',
    '/import/history',
    '/settings/bot',
    '/settings/profile',
    '/settings/connectors',
    '/settings/companies',
    '/settings/sync-logs',
    '/reports/invoices',
  ].some((p) => pathname === p || pathname.startsWith(`${p}/`));

  const hasRouteSpecificBack = !!pathname && (
    pathname.startsWith('/declarations/')
    || pathname.startsWith('/reports/monthly/')
    || pathname.startsWith('/invoices/')
    || pathname.startsWith('/admin/users/')
    || pathname.startsWith('/settings/organizations/')
  );

  if (isHomeRoute || hasLocalBackControl || hasRouteSpecificBack) return null;

  return (
    <div className="max-w-2xl lg:max-w-5xl mx-auto px-4 pt-3">
      <BackButton fallbackHref={homeHref} className="mb-1" />
    </div>
  );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const router = useRouter();

  // Register push subscription once user is authenticated
  usePushSubscription(ready);

  useEffect(() => {
    // On every page load, silently refresh the access token using the
    // HTTP-only refresh-token cookie. This restores the in-memory token
    // after a hard refresh without sending the token to localStorage.
    axios
      .post<{ data: { accessToken: string } }>(
        `${API_URL}/api/auth/refresh`,
        {},
        { withCredentials: true }
      )
      .then((res) => {
        setAccessToken(res.data.data.accessToken);
        setReady(true);
      })
      .catch(() => {
        router.replace('/login');
      });
  }, [router]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
          <p className="text-sm text-gray-500">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <SyncProvider>
      <CompanyProvider>
        <ViewProvider>
          <div className="min-h-screen bg-gray-50">
            <NoCompanyGuard />
            <NavigationHistoryTracker />
            <Header />
            <main className="pb-20 lg:pb-6 pt-14 safe-bottom">
              <GlobalBackStrip />
              {children}
            </main>
            <SyncOverlay />
            <BottomNav />
          </div>
        </ViewProvider>
      </CompanyProvider>
    </SyncProvider>
  );
}
