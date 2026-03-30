'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import axios from 'axios';
import { setAccessToken } from '../lib/apiClient';
import { CompanyProvider } from '../contexts/CompanyContext';
import { ViewProvider } from '../contexts/ViewContext';
import Header from './Header';
import BottomNav from './BottomNav';
import { useCompany } from '../contexts/CompanyContext';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
    <CompanyProvider>
      <ViewProvider>
        <div className="min-h-screen bg-gray-50">
          <NoCompanyGuard />
          <Header />
          <main className="pb-20 pt-14 safe-bottom">{children}</main>
          <BottomNav />
        </div>
      </ViewProvider>
    </CompanyProvider>
  );
}
