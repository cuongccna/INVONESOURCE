import { Suspense } from 'react';
import { AnalyticsClient } from './analytics-client';

function AnalyticsLoading() {
  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-gray-400 text-sm">Đang tải…</p>
    </div>
  );
}

export default function AdminAnalyticsPage() {
  return (
    <Suspense fallback={<AnalyticsLoading />}>
      <AnalyticsClient />
    </Suspense>
  );
}
