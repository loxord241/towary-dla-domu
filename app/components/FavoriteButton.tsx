'use client';

import { useState } from 'react';
import { useFavorites, MAX_FAVORITES } from '@/app/lib/favorites-context';
import { HeartIcon } from './icons';

/**
 * Heart toggle. Stops propagation so it can sit inside clickable cards.
 * Pure client preference — no server state, no trusted data involved.
 */
export default function FavoriteButton({
  productId,
  productName,
}: {
  productId: string;
  /** product name for accessible labels */
  productName?: string;
}) {
  const { isFavorite, toggleFavorite, hydrated } = useFavorites();
  const active = hydrated && isFavorite(productId);
  const [limitNotice, setLimitNotice] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`${
          active ? 'Прибрати з обраного' : 'Додати до обраного'
        }${productName ? `: ${productName}` : ''}`}
        aria-pressed={active}
        title={active ? 'Прибрати з обраного' : 'Додати до обраного'}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // A full favorites list used to swallow the toggle silently —
          // surface the cap instead of pretending nothing happened.
          setLimitNotice(!toggleFavorite(productId));
        }}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition ${
          active ? 'text-red-500' : 'opacity-40 hover:opacity-80'
        }`}
      >
        <HeartIcon filled={active} className="h-5 w-5" />
      </button>
      {limitNotice && (
        <span
          role="alert"
          className="absolute left-1/2 top-full z-10 mt-1 w-44 -translate-x-1/2 rounded-md bg-gray-900 px-2 py-1 text-center text-xs text-white shadow"
        >
          У вибраному максимум {MAX_FAVORITES} товарів
        </span>
      )}
    </span>
  );
}
