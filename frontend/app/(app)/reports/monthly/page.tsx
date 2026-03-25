'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ReportsMonthlyRedirect() {
  const router = useRouter();

  useEffect(() => {
    const now = new Date();
    router.replace(`/reports/monthly/${now.getFullYear()}/${now.getMonth() + 1}`);
  }, [router]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
    </div>
  );
}
