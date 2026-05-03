'use client';

import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { buildRouteKey, getPreviousRoute } from '../lib/navigationHistory';

interface BackButtonProps {
  fallbackHref: string;
  label?: string;
  className?: string;
}

function BackButtonInner({
  fallbackHref,
  label = 'Quay lại',
  className = '',
}: BackButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleBack = () => {
    if (typeof window !== 'undefined') {
      // Try browser history first (most reliable)
      const referrer = document.referrer;
      const sameOrigin = referrer.startsWith(window.location.origin);
      if (sameOrigin && window.history.length > 1) {
        router.back();
        return;
      }

      // Try navigation history as fallback
      const currentRoute = buildRouteKey(pathname || '/', searchParams);
      const previousRoute = getPreviousRoute(currentRoute);
      if (previousRoute && previousRoute !== currentRoute) {
        router.push(previousRoute);
        return;
      }
    }

    // Final fallback
    router.push(fallbackHref);
  };

  return (
    <button
      type="button"
      onClick={handleBack}
      className={`inline-flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 transition-colors ${className}`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
      {label}
    </button>
  );
}

export default function BackButton(props: BackButtonProps) {
  return (
    <Suspense fallback={null}>
      <BackButtonInner {...props} />
    </Suspense>
  );
}
