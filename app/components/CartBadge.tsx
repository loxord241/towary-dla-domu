'use client';

import Link from 'next/link';
import { useCart } from '@/app/lib/cart-context';

/**
 * Client island for the header cart button. The rest of SiteHeader stays a
 * server component. Renders 0 until hydration to avoid SSR mismatch.
 */
export default function CartBadge() {
  const { totalCount, hydrated } = useCart();

  return (
    <Link
      href="/cart"
      title="Кошик"
      aria-label={`Кошик, товарів: ${hydrated ? totalCount : 0}`}
      className="p-2 text-gray-600 hover:text-blue-600 relative"
    >
      🛒
      <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
        {hydrated ? totalCount : 0}
      </span>
    </Link>
  );
}
