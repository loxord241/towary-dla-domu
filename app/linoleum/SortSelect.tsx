'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { isSortDocumentNavigation } from '@/app/lib/filter-url';

/**
 * /linoleum sort control (mirror of the /oboi control, linoleum vertical
 * batch 2, task L4): the DEFAULT linoleum order is alphabetical (Назва
 * А–Я) — the server treats an absent ?sort= as name_asc, so the default
 * option posts NO param and the canonical /linoleum stays indexable
 * (buildLinoleumMetadata noindexes explicit sorts).
 * The width filter value is preserved across sort changes.
 */

const SORT_OPTIONS = [
  { value: '', label: 'Назва А–Я' },
  { value: 'newest', label: 'Спочатку в наявності' },
  { value: 'price_asc', label: 'Ціна ▲' },
  { value: 'price_desc', label: 'Ціна ▼' },
] as const;

function LinoleumSortSelectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('sort') ?? '';

  return (
    <select
      value={current}
      aria-label="Сортування"
      onChange={(e) => {
        const params = new URLSearchParams();
        const width = searchParams.get('width');
        if (width) params.set('width', width);
        if (e.target.value !== '') params.set('sort', e.target.value);
        const qs = params.toString();
        const href = qs !== '' ? `/linoleum?${qs}` : '/linoleum';
        // Same shape as OboiSortSelect — /linoleum is an ISR-static route,
        // and a router.push to ?sort=… can be satisfied by Next 16's
        // client segment-cache route prediction rendering the cached
        // default-order page without a server request (intermittent). A
        // document navigation always reaches the proxy → force-dynamic twin.
        if (isSortDocumentNavigation('/linoleum')) {
          window.location.assign(href);
        } else {
          router.push(href);
        }
      }}
      className="min-h-[44px] w-full sm:w-auto rounded-md border border-gray-300 p-2 text-base"
    >
      {SORT_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export default function LinoleumSortSelect() {
  return (
    <Suspense
      fallback={
        <select
          className="min-h-[44px] w-full sm:w-auto rounded-md border border-gray-300 p-2 text-base"
          aria-label="Сортування"
          disabled
        />
      }
    >
      <LinoleumSortSelectInner />
    </Suspense>
  );
}
