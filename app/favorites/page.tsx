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

  if (!hydrated || (loading && ids.length > 0)) {
    return (
      <div className="min-h-screen bg-gray-50">
        <SiteHeader />
        <div className="container mx-auto flex justify-center px-4 py-16">
          <div className="h-12 w-12 animate-spin rounded-full border-t-2 border-b-2 border-pink-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <SiteHeader />
      <div className="container mx-auto flex-1 px-4 py-8">
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
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
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
      </div>
      <SiteFooter />
    </div>
  );
}
