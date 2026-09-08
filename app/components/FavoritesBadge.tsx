'use client';

import Link from 'next/link';
import { useFavorites } from '@/app/lib/favorites-context';
import { HeartIcon } from './icons';

/**
 * Client island: header favorites link with live counter.
 * The counter bubble is hidden while empty (no «0» noise).
 */
export default function FavoritesBadge() {
  const { totalCount, hydrated } = useFavorites();
  const count = hydrated ? totalCount : 0;

  return (
    <Link
      href="/favorites"
      title="Обране"
      aria-label={`Обране, товарів: ${count}`}
      className="p-2 text-gray-600 hover:text-blue-600 relative"
    >
      <HeartIcon filled className="h-5 w-5" />
      {count > 0 && (
        /* key={count} remounts the bubble on every count change → restarts
           the badge-pop keyframe (globals.css). Transform-only → CLS=0. */
        <span
          key={count}
          className="badge-pop motion-reduce:animate-none absolute -top-1 -right-1 bg-pink-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center"
        >
          {count}
        </span>
      )}
    </Link>
  );
}
