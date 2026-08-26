'use client';

import { useEffect, useState } from 'react';
import ProductCard from '@/app/components/ProductCard';
import {
  fetchCartPreview,
  type CartPreviewLine,
} from '@/app/lib/cart-preview';
import {
  MAX_RECENTLY_VIEWED,
  readRecentlyViewed,
} from '@/app/lib/recently-viewed-storage';

/**
 * «Нещодавно переглянуті» shelf. Data flow mirrors the favorites page:
 * localStorage holds ONLY product UUIDs; every price/name/image arrives from
 * the existing bounded batch endpoint /api/cart-preview via the sanctioned
 * time-bounded fetcher. Products that disappeared (inactive/deleted) come
 * back found:false and are dropped silently — stale ids can never break the
 * UI. The block renders nothing (server AND first client render) until the
 * post-mount read finishes: SSR-safe, no hydration mismatch.
 */
export default function RecentProducts({
  excludeProductId,
}: {
  excludeProductId: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  const [hasEntries, setHasEntries] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;
    // Deferred out of the effect body (react-hooks: no synchronous setState
    // within effects — same pattern as use-admin-list-state).
    const timer = setTimeout(() => {
      if (cancelled) return;
      setMounted(true);
      const ids = readRecentlyViewed((key) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      })
        .filter((id) => id !== excludeProductId)
        .slice(0, MAX_RECENTLY_VIEWED);

      if (ids.length === 0) return;

      setHasEntries(true);
      // fetchCartPreview is time-bounded (12s) and always ends in onDone();
      // dispose() aborts superseded requests when the component unmounts.
      dispose = fetchCartPreview(
        ids.map((productId) => ({ productId, variantId: null })),
        {
          onData: (data) => {
            if (cancelled) return;
            // Preserve recency order of the STORED ids, not response order.
            const byId = new Map(data.map((line) => [line.productId, line]));
            setLines(
              ids
                .map((id) => byId.get(id))
                .filter((line): line is CartPreviewLine =>
                  Boolean(line && line.found)
                )
            );
          },
          onError: (message) => {
            // Supplementary shelf: a network hiccup hides it, never blocks the page.
            console.error('recently-viewed preview failed:', message);
            if (!cancelled) setHasEntries(false);
          },
          onDone: () => {},
        }
      );
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      dispose?.();
    };
  }, [excludeProductId]);

  if (!mounted || !hasEntries || lines.length === 0) return null;

  // Rendered INSIDE the product page's <main class="container">: no own
  // container wrapper — the card must align with sibling sections (P3-N1).
  return (
    <section className="mb-8 rounded-lg bg-white p-6 shadow">
      <h2 className="mb-4 text-xl font-bold">Нещодавно переглянуті</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {lines.map((line) => (
            <ProductCard
              key={line.productId}
              product={{
                id: line.productId,
                name: line.name ?? '',
                slug: line.slug ?? '',
                price: line.unitPrice ?? 0,
                currency: line.currency ?? '',
                old_price: null,
                availability_status: line.availabilityStatus ?? 'out_of_stock',
                brand: null,
              }}
              imageUrl={line.imageUrl}
            />
          ))}
        </div>
    </section>
  );
}
