'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import SiteHeader from '@/app/components/SiteHeader'
import EmptyState from '@/app/components/EmptyState';
import { CartIcon } from '@/app/components/icons';
import SiteFooter from '@/app/components/SiteFooter';
import { useCart, MAX_ITEM_QUANTITY } from '@/app/lib/cart-context';
import {
  fetchCartPreview,
  type CartPreviewLine,
} from '@/app/lib/cart-preview';
import { formatPrice } from '@/app/lib/format';

function availabilityLabel(status: string | null): string {
  if (status === 'in_stock') return 'В наявності';
  if (status === 'out_of_stock') return 'Немає в наявності';
  return 'Обмежена наявність';
}

export default function CartPage() {
  const { items, hydrated, updateQuantity, removeItem, clearCart } = useCart();

  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hydrated || items.length === 0) return;
    let cancelled = false;
    // fetchCartPreview is time-bounded and always ends in onDone(); dispose()
    // aborts superseded requests (e.g. quantity changed mid-flight).
    const dispose = fetchCartPreview(
      items.map((i) => ({ productId: i.productId, variantId: i.variantId })),
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
  }, [hydrated, items, attempt]);

  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };

  const lineFor = (productId: string, variantId: string | null) =>
    lines.find(
      (l) => l.productId === productId && (l.variantId ?? null) === variantId
    );

  // Server data is the display source of truth; quantities live in context.
  const rows = items.map((item) => ({
    item,
    preview: lineFor(item.productId, item.variantId),
  }));
  const purchasableRows = rows.filter(
    ({ preview }) =>
      preview?.found === true &&
      preview.unitPrice !== null &&
      preview.availabilityStatus !== 'out_of_stock'
  );
  const subtotal = purchasableRows.reduce(
    (sum, { item, preview }) => sum + (preview?.unitPrice ?? 0) * item.quantity,
    0
  );
  const currency = purchasableRows[0]?.preview?.currency ?? '';

  if (!hydrated || (loading && items.length > 0)) {
    return (
      <div className="min-h-screen bg-gray-50">
        <SiteHeader />
        <div className="container mx-auto px-4 py-16 flex justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">Кошик</h1>

        {error && (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded"
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

        {items.length === 0 ? (
          <EmptyState
            icon={<CartIcon className="h-10 w-10" />}
            title="Кошик порожній"
            description="Додайте товари з каталогу, щоб оформити замовлення."
            ctaHref="/catalog"
            ctaLabel="До каталогу"
          />
        ) : (
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Lines */}
            <div className="lg:w-2/3 space-y-3">
              {rows.map(({ item, preview }) => {
                const unavailable =
                  !preview?.found ||
                  preview.unitPrice === null ||
                  preview.availabilityStatus === 'out_of_stock';
                const maxQty = Math.max(
                  1,
                  Math.min(preview?.stock ?? MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY)
                );
                return (
                  <div
                    key={`${item.productId}::${item.variantId ?? ''}`}
                    className="card flex flex-col items-start gap-4 p-4 sm:flex-row sm:items-center"
                  >
                    {preview?.imageUrl ? (
                      <Image
                        src={preview.imageUrl}
                        alt={preview.name ?? ''}
                        width={80}
                        height={80}
                        unoptimized
                        className="w-20 h-20 object-cover rounded"
                      />
                    ) : (
                      <div className="w-20 h-20 bg-gray-100 rounded flex items-center justify-center text-[10px] text-gray-400">
                        фото?
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {preview?.found ? (
                        <>
                          <Link
                            href={`/product/${preview.slug}`}
                            className="font-semibold hover:text-blue-600"
                          >
                            {preview.name}
                          </Link>
                          {preview.variantName && (
                            <p className="text-sm text-gray-500">{preview.variantName}</p>
                          )}
                          {!unavailable ? (
                            <p className="text-sm text-gray-600 mt-1">
                              {formatPrice(preview.unitPrice ?? 0, preview.currency)} / шт ·{' '}
                              {availabilityLabel(preview.availabilityStatus)}
                            </p>
                          ) : (
                            <p className="text-sm text-red-600 mt-1">
                              Товар недоступний — видаліть його з кошика
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-red-600">
                          Товар більше не доступний у каталозі
                        </p>
                      )}
                    </div>

                    {!unavailable && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Зменшити кількість"
                          onClick={() =>
                            updateQuantity(item.productId, item.variantId, item.quantity - 1)
                          }
                          disabled={item.quantity <= 1}
                          className="h-8 w-8 rounded-lg border border-gray-300 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40"
                        >
                          −
                        </button>
                        <span className="w-8 text-center">{item.quantity}</span>
                        <button
                          type="button"
                          aria-label="Збільшити кількість"
                          onClick={() =>
                            updateQuantity(item.productId, item.variantId, item.quantity + 1)
                          }
                          disabled={item.quantity >= maxQty}
                          className="h-8 w-8 rounded-lg border border-gray-300 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40"
                        >
                          +
                        </button>
                      </div>
                    )}

                    {!unavailable && preview?.unitPrice != null && (
                      <div className="w-28 text-right font-semibold whitespace-nowrap">
                        {formatPrice(preview.unitPrice * item.quantity, preview.currency)}
                      </div>
                    )}

                    <button
                      type="button"
                      aria-label="Видалити з кошика"
                      onClick={() => removeItem(item.productId, item.variantId)}
                      className="rounded-lg p-1.5 text-xl leading-none text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      ×
                    </button>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={clearCart}
                className="text-sm text-gray-500 hover:text-red-600 underline"
              >
                Очистити кошик
              </button>
            </div>

            {/* Summary */}
            <div className="lg:w-1/3">
              <div className="card p-6 lg:sticky lg:top-24">
                <h2 className="text-lg font-semibold mb-4">Разом</h2>
                <div className="flex justify-between mb-2 text-sm text-gray-600">
                  <span>Товарів</span>
                  <span>{items.reduce((s, i) => s + i.quantity, 0)} шт</span>
                </div>
                <div className="flex justify-between font-semibold text-lg mb-1">
                  <span>До сплати</span>
                  <span>
                    {formatPrice(subtotal, currency)}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  Остаточна сума буде перерахована сервером при оформленні.
                </p>
                {purchasableRows.length > 0 ? (
                  <Link
                    href="/checkout"
                    className="btn btn-primary w-full py-3 text-base"
                  >
                    Оформити замовлення
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="block w-full bg-blue-600 text-white py-3 rounded-md font-semibold opacity-50 cursor-not-allowed"
                  >
                    Немає доступних товарів
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <SiteFooter />
    </div>
  );
}
