'use client';

import Link from 'next/link';
import { useFavorites } from '@/app/lib/favorites-context';

/** Client island: header favorites link with live counter. */
export default function FavoritesBadge() {
  const { totalCount, hydrated } = useFavorites();

  return (
    <Link
      href="/favorites"
      title="Избранное"
      aria-label={`Избранное, товаров: ${hydrated ? totalCount : 0}`}
      className="p-2 text-gray-600 hover:text-blue-600 relative"
    >
      ❤️
      <span className="absolute -top-1 -right-1 bg-pink-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
        {hydrated ? totalCount : 0}
      </span>
    </Link>
  );
}
