'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { buildRouteKey, getPreviousRoute } from '../lib/navigationHistory';

interface BackButtonProps {
  fallbackHref: string;
  label?: string;
  className?: string;
}

export default function BackButton({
  fallbackHref,
  label = 'Quay lại',
  className = '',
}: BackButtonProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleBack = () => {
    if (typeof window !== 'undefined') {
      const currentRoute = buildRouteKey(pathname || '/', searchParams);
      const previousRoute = getPreviousRoute(currentRoute);
      if (previousRoute && previousRoute !== currentRoute) {
        router.push(previousRoute);
        return;
      }

      const referrer = document.referrer;
      const sameOrigin = referrer.startsWith(window.location.origin);
      if (sameOrigin && window.history.length > 1) {
        router.back();
        return;
      }
    }
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
