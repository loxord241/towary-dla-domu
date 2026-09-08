'use client';

import { useEffect, useState } from 'react';
import SiteHeader from '@/app/components/SiteHeader';
import SiteFooter from '@/app/components/SiteFooter';
import EmptyState from '@/app/components/EmptyState';
import { HeartIcon, TrashIcon } from '@/app/components/icons';
import ProductCard from '@/app/components/ProductCard';
import RemoveFavoriteButton from '@/app/components/RemoveFavoriteButton';
import { useFavorites, MAX_FAVORITES } from '@/app/lib/favorites-context';
import {
  fetchCartPreview,
  type CartPreviewLine,
} from '@/app/lib/cart-preview';

export default function FavoritesPage() {
  const { ids, hydrated, clearFavorites } = useFavorites();
  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Skeleton placeholder lines for the first load (cart-page pattern): the
  // layout settles in place instead of "blank page → spinner → pop-in".
  const skeletonCount = Math.min(Math.max(ids.length, 2), 8);

  useEffect(() => {
    if (!hydrated || ids.length === 0) return;
    let cancelled = false;
    // fetchCartPreview is time-bounded and always ends in onDone(); dispose()
    // aborts superseded requests when the list changes mid-flight.
    const dispose = fetchCartPreview(
      ids.map((productId) => ({ productId, variantId: null })),
      {
        onData: (data) => {
          if (!cancelled) {
            setLines(data);
            setError(null);
          }
        },
        onError: (message) => {
          if (!cancelled) setError(message);
        },
        onDone: () => {
          if (!cancelled) setLoading(false);
        },
      }
    );
    return () => {
      cancelled = true;
      dispose();
    };
  }, [hydrated, ids, attempt]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };

  // First load: skeleton card grid instead of a full-page spinner (perf
  // audit Step 4 pattern, mirrors the cart page) — the header, title and
  // grid layout stay in place, so the content settles instead of popping in.
  if (!hydrated || (loading && ids.length > 0)) {
    return (
      <div className="min-h-screen bg-gray-50">
        <SiteHeader />
        <main className="container mx-auto px-4 py-8">
          <h1 className="text-2xl font-bold mb-6">Обране</h1>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4" aria-hidden>
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm"
              >
                <div className="skeleton h-48 w-full rounded-t-xl" />
                <div className="flex-1 space-y-2 p-4">
                  <div className="skeleton h-4 w-3/4" />
                  <div className="skeleton h-5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />
      <main className="container mx-auto flex-1 px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Обране
          </h1>
          {ids.length > 0 && (
            <button
              type="button"
              onClick={clearFavorites}
              className="text-sm text-gray-500 underline transition-colors hover:text-red-600"
            >
              Очистити список ({ids.length}
              {ids.length >= MAX_FAVORITES ? '+' : ''})
            </button>
          )}
        </div>

        {error && (
          <div
            className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-700"
            role="alert"
          >
            <span>{error}</span>
            <button
              type="button"
              onClick={retry}
              className="font-medium underline hover:text-red-800"
            >
              Спробувати ще
            </button>
          </div>
        )}

        {ids.length === 0 ? (
          <EmptyState
            icon={<HeartIcon className="h-10 w-10" />}
            title="В обраному поки що порожньо"
            description="Натисніть на сердечко на карточці товару, щоб зберегти його тут."
            ctaHref="/catalog"
            ctaLabel="До каталогу"
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {lines.map((line) =>
              line.found ? (
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
              ) : (
                <div
                  key={line.productId}
                  className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-red-200 bg-red-50/40 p-6 text-center"
                >
                  <p aria-hidden className="mb-2 opacity-60">
                    <TrashIcon className="h-7 w-7 mx-auto" />
                  </p>
                  <p className="text-sm text-red-600">
                    Товар більше недоступний у каталозі
                  </p>
                  <RemoveFavoriteButton productId={line.productId} />
                </div>
              )
            )}
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
