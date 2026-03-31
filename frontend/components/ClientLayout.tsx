'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import axios from 'axios';
import { setAccessToken } from '../lib/apiClient';
import { CompanyProvider } from '../contexts/CompanyContext';
import { ViewProvider } from '../contexts/ViewContext';
import { SyncProvider, useSyncContext } from '../contexts/SyncContext';
import Header from './Header';
import BottomNav from './BottomNav';
import SyncProgressPanel from './SyncProgressPanel';
import { useCompany } from '../contexts/CompanyContext';
import { usePushSubscription } from '../lib/usePushSubscription';

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
            <Header />
            <main className="pb-20 lg:pb-6 pt-14 safe-bottom">{children}</main>
            <SyncOverlay />
            <BottomNav />
          </div>
        </ViewProvider>
      </CompanyProvider>
    </SyncProvider>
  );
}
