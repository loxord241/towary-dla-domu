'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

/**
 * /oboi sort control (owner task 2026-09-12): the DEFAULT wallpaper order
 * is alphabetical (Назва А–Я) — the server treats an absent ?sort= as
 * name_asc, so the default option posts NO param and the canonical /oboi
 * stays indexable (buildWallpapersMetadata noindexes explicit sorts).
 * The «Основа» filter value is preserved across sort changes.
 */

const SORT_OPTIONS = [
  { value: '', label: 'Назва А–Я' },
  { value: 'newest', label: 'Спочатку в наявності' },
  { value: 'price_asc', label: 'Ціна ▲' },
  { value: 'price_desc', label: 'Ціна ▼' },
] as const;

function OboiSortSelectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get('sort') ?? '';

  return (
    <select
      value={current}
      aria-label="Сортування"
      onChange={(e) => {
        const params = new URLSearchParams();
        const base = searchParams.get('base');
        if (base) params.set('base', base);
        if (e.target.value !== '') params.set('sort', e.target.value);
        const qs = params.toString();
        router.push(qs !== '' ? `/oboi?${qs}` : '/oboi');
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

export default function OboiSortSelect() {
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
      <OboiSortSelectInner />
    </Suspense>
  );
}
