'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { buildSortSearchParams } from '@/app/lib/filter-url';

const SORT_OPTIONS = [
  // Default ('newest') is honest about what it does: the SQL default branch
  // puts in-stock rows first, then newest (see fetchCatalogProducts).
  { value: 'newest', label: 'Спочатку в наявності' },
  { value: 'price_asc', label: 'Ціна ▲' },
  { value: 'price_desc', label: 'Ціна ▼' },
  { value: 'name_asc', label: 'Назва А–Я' },
];

function SortSelectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('sort') ?? 'newest';

  return (
    <select
      value={current}
      aria-label="Сортування"
      onChange={(e) => {
        // Sort change always resets to page 1 (URL contract lives in the
        // pure, unit-tested buildSortSearchParams).
        const qs = buildSortSearchParams(searchParams, e.target.value);
        router.push(qs ? `/catalog?${qs}` : '/catalog');
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

export default function SortSelect() {
  return (
    <Suspense fallback={<select className="p-2 border border-gray-300 rounded" aria-label="Сортування" />}>
      <SortSelectInner />
    </Suspense>
  );
}
