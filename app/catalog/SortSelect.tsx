'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { buildSortSearchParams, isSortDocumentNavigation } from '@/app/lib/filter-url';

const SORT_OPTIONS = [
  // Default ('newest') is honest about what it does: the SQL default branch
  // puts in-stock rows first, then newest (see fetchCatalogProducts).
  { value: 'newest', label: 'Спочатку в наявності' },
  { value: 'price_asc', label: 'Ціна ▲' },
  { value: 'price_desc', label: 'Ціна ▼' },
  { value: 'name_asc', label: 'Назва А–Я' },
];

function SortSelectInner({ basePath = '/catalog' }: { basePath?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('sort') ?? 'newest';

  return (
    <select
      value={current}
      aria-label="Сортування"
      onChange={(e) => {
        // Sort change always resets to page 1 (URL contract lives in the
        // pure, unit-tested buildSortSearchParams). Since the category path
        // URLs (2026-09-13) the sort must stay ON the category page —
        // dropping to bare /catalog here leaked OTHER products into a
        // sorted category view (wallpapers excluded from the general
        // catalog), which is exactly the bug the owner reported.
        const qs = buildSortSearchParams(searchParams, e.target.value);
        const href = qs ? `${basePath}?${qs}` : basePath;
        // OWNER BUG 2026-09-15 («сортировка через раз работает»): on the ISR
        // category path pages a router.push to ?sort=… can be satisfied by
        // Next 16's client segment-cache route prediction, which renders the
        // cached PURE (default-order) page for the query URL WITHOUT a server
        // request — the proxy rewrite to the sorting twin never runs, and the
        // outcome depends on prefetch freshness (intermittent). A document
        // navigation always reaches the server (proxy → force-dynamic twin →
        // sorted HTML). Decision + mechanism: isSortDocumentNavigation in
        // app/lib/filter-url.ts. Bare /catalog stays a soft navigation (its
        // route is dynamic — every navigation already fetches).
        if (isSortDocumentNavigation(basePath)) {
          window.location.assign(href);
        } else {
          router.push(href);
        }
      }}
      className="p-2 text-base min-h-[44px] w-full sm:w-auto border border-gray-300 rounded"
    >
      {SORT_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export default function SortSelect({ basePath }: { basePath?: string }) {
  return (
    <Suspense fallback={<select className="min-h-[44px] w-full rounded border border-gray-300 p-2 text-base sm:w-auto" aria-label="Сортування" />}>
      <SortSelectInner basePath={basePath} />
    </Suspense>
  );
}
