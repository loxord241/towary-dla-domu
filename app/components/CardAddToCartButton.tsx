'use client';

import { useEffect, useRef, useState } from 'react';
import { useCart } from '@/app/lib/cart-context';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { trackEvent } from '@/app/lib/track-event';

/** How long the «Додано ✓» confirmation stays visible after a click. */
const ADDED_FEEDBACK_MS = 2000;

/**
 * Compact add-to-cart island for ProductCard (conversion fix, UI audit
 * 2026-09-14: grids — /oboi above all — lost every add that did not
 * justify a PDP visit). One click = quantity 1; repeated clicks merge
 * into the same cart line via the cart reducer, and the header badge
 * updates through the same context. The card projection carries no
 * variant data, so the line is added with variantId null — place_order()
 * then prices it from the product row (the Yugcontract importer never
 * creates variants; a variant product still has its PDP selector as the
 * precise path).
 */
export default function CardAddToCartButton({
  productId,
  productName,
}: {
  productId: string;
  productName?: string;
}) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);
  const [cartFull, setCartFull] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Grids re-render wholesale on filter/sort/page changes: a pending
  // feedback timer must never setState into an unmounted card.
  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const handleClick = () => {
    // addItem is a no-op (false) for a full cart or a bad id — flashing
    // «Додано ✓» then would be a lie, so the full-cart case gets its own
    // honest 2s label instead of the success flash.
    const ok = addItem(productId, null, 1);
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    if (ok) {
      setCartFull(false);
      setAdded(true);
      // Anonymous analytics: product UUID only, no PII (same event as PDP).
      trackEvent(ANALYTICS_EVENTS.ADD_TO_CART, { product_id: productId });
    } else {
      setAdded(false);
      setCartFull(true);
    }
    feedbackTimer.current = setTimeout(() => {
      setAdded(false);
      setCartFull(false);
    }, ADDED_FEEDBACK_MS);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={cartFull}
      title={productName}
      aria-live="polite"
      className={
        'w-full min-h-[44px] rounded-lg text-sm font-semibold transition-colors motion-reduce:transition-none ' +
        (cartFull
          ? 'cursor-not-allowed border border-red-300 bg-white text-red-600'
          : added
            ? 'bg-green-600 text-white hover:bg-green-700'
            : 'bg-blue-600 text-white hover:bg-blue-700')
      }
    >
      {cartFull ? 'Кошик переповнений' : added ? 'Додано ✓' : 'У кошик'}
    </button>
  );
}
