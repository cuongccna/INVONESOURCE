import { Suspense } from 'react';
import { CrawlerRecipesClient } from './crawler-recipes-client';

function CrawlerRecipesLoading() {
  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-gray-400 text-sm">Đang tải…</p>
    </div>
  );
}

export default function CrawlerRecipesPage() {
  return (
    <Suspense fallback={<CrawlerRecipesLoading />}>
      <CrawlerRecipesClient />
    </Suspense>
  );
}
