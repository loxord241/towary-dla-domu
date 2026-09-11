'use client';

import { useFavorites } from '@/app/lib/favorites-context';

/** Removes one product from favorites; used on /favorites for stale items. */
export default function RemoveFavoriteButton({
  productId,
}: {
  productId: string;
}) {
  const { removeFavorite } = useFavorites();
  return (
    <button
      type="button"
      onClick={() => removeFavorite(productId)}
      className="mt-3 inline-flex min-h-[40px] items-center px-3 py-2 text-xs text-gray-500 underline transition-colors hover:text-red-600"
    >
      Прибрати з обраного
    </button>
  );
}
