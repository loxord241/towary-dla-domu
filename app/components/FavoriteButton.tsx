'use client';

import { useFavorites } from '@/app/lib/favorites-context';
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

  return (
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
        toggleFavorite(productId);
      }}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition ${
        active ? 'text-red-500' : 'opacity-40 hover:opacity-80'
      }`}
    >
      <HeartIcon filled={active} className="h-5 w-5" />
    </button>
  );
}
