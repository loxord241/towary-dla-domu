'use client';

import Link from 'next/link';
import { useCart } from '@/app/lib/cart-context';
import { CartIcon } from './icons';

/**
 * Client island for the header cart button. The rest of SiteHeader stays a
 * server component. The counter bubble is hidden while empty (no «0» noise).
 */
export default function CartBadge() {
  const { totalCount, hydrated } = useCart();
  const count = hydrated ? totalCount : 0;

  return (
    <Link
      href="/cart"
      title="Кошик"
      aria-label={`Кошик, товарів: ${count}`}
      className="p-2 text-gray-600 hover:text-blue-600 relative"
    >
      <CartIcon className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
          {count}
        </span>
      )}
    </Link>
  );
}
