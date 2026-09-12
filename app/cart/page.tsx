'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import EmptyState from '@/app/components/EmptyState';
import { CartIcon } from '@/app/components/icons';
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

/**
 * Debounce for preview refreshes (perf audit Step 4): every quantity click
 * mutates `items`, which re-runs the effect — without the delay each +/-
 * press fired its own POST /api/cart-preview. The FIRST load (no lines yet)
 * stays immediate. Race safety is unchanged: the effect cleanup disposes
 * the pending timer AND aborts the superseded request, so the freshest
 * quantity always wins.
 */
const PREVIEW_DEBOUNCE_MS = 350;

function CartLineSkeleton() {
  return (
    <div className="card flex flex-col items-start gap-4 p-4 sm:flex-row sm:items-center">
      <div className="skeleton h-20 w-20 rounded" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
      </div>
      <div className="skeleton h-8 w-24 rounded-lg" />
      <div className="skeleton h-5 w-20" />
    </div>
  );
}

export default function CartPage() {
  const { items, hydrated, updateQuantity, removeItem, clearCart } = useCart();

  const [lines, setLines] = useState<CartPreviewLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // First preview fetch runs immediately; later refreshes are debounced.
  const firstLoadRef = useRef(true);
  // Abort handle of the in-flight preview request (see effect below).
  const disposeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!hydrated || items.length === 0) return;
    let cancelled = false;
    // fetchCartPreview is time-bounded and always ends in onDone(); dispose()
    // aborts superseded requests (e.g. quantity changed mid-flight) and the
    // cleanup also clears the debounce timer, so a stale response can never
    // land. First load stays immediate; subsequent refreshes (quantity
    // clicks, retries) are debounced.
    const delay = firstLoadRef.current ? 0 : PREVIEW_DEBOUNCE_MS;
    firstLoadRef.current = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
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
      disposeRef.current = dispose;
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      disposeRef.current?.();
      disposeRef.current = null;
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
  // Checkout parity (CheckoutForm.tsx): a MISSING preview (preview fetch
  // failed or a line is absent) is UNKNOWN, never unavailable — only a
  // RECEIVED preview proving !found / no price / out_of_stock marks the row
  // unavailable. An unknown row must not read as «no longer available» and
  // must not block the checkout CTA; place_order() revalidates server-side.
  const isConfirmedUnavailable = (preview: CartPreviewLine | undefined) =>
    preview !== undefined &&
    (!preview.found ||
      preview.unitPrice === null ||
      preview.availabilityStatus === 'out_of_stock');
  const purchasableRows = rows.filter(
    ({ preview }) =>
      preview?.found === true &&
      preview.unitPrice !== null &&
      preview.availabilityStatus !== 'out_of_stock'
  );
  const unknownRows = rows.filter(({ preview }) => preview === undefined);
  // Subtotals are grouped per currency: summing UAH and USD into one
  // number and signing it with the first row's currency is meaningless.
  // Single-currency carts keep the exact pre-existing display shape.
  const subtotalByCurrency = new Map<string, number>();
  for (const { item, preview } of purchasableRows) {
    const cur = preview?.currency ?? '';
    subtotalByCurrency.set(
      cur,
      (subtotalByCurrency.get(cur) ?? 0) + (preview?.unitPrice ?? 0) * item.quantity
    );
  }
  const currency = purchasableRows[0]?.preview?.currency ?? '';

  // First load: skeleton rows instead of a full-page spinner (perf audit
  // Step 4) — the header, title and summary layout stay in place, so the
  // content settles instead of "blank page → sudden pop-in".
  if (!hydrated || (loading && items.length > 0)) {
    return (
      <main className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-6">Кошик</h1>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="lg:w-2/3 space-y-3" aria-hidden>
            {Array.from({ length: Math.min(Math.max(items.length, 2), 4) }).map((_, i) => (
              <CartLineSkeleton key={i} />
            ))}
          </div>
          <div className="lg:w-1/3">
            <div className="card p-6 space-y-3">
              <div className="skeleton h-5 w-24" />
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-6 w-40" />
              <div className="skeleton h-12 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8">
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
                const unavailable = isConfirmedUnavailable(preview);
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
                        sizes="80px"
                        className="w-20 h-20 object-cover rounded"
                      />
                    ) : (
                      <div className="w-20 h-20 bg-gray-100 rounded flex items-center justify-center">
                        {/* Neutral placeholder in the ProductCard style — not
                            a dev prompt (UX audit 2026-09). */}
                        <span className="text-[10px] text-gray-500">
                          Фото відсутнє
                        </span>
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      {preview?.found ? (
                        <>
                          <Link
                            href={`/product/${preview.slug}`}
                            className="wrap-anywhere font-semibold hover:text-blue-600"
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
                      ) : preview === undefined ? (
                        <p className="text-sm text-gray-500">
                          Дані товару не завантажились — ціну та наявність буде
                          перевірено при оформленні.
                        </p>
                      ) : (
                        <p className="text-sm text-red-600">
                          Товар більше не доступний у каталозі
                        </p>
                      )}
                    </div>

                    {/*
                      Mobile fix 2026-09-11: stepper, price and the remove
                      button share one wrapping row so on narrow screens they
                      spread across the full width instead of huddling left.
                      Render conditions are unchanged — the remove button
                      still renders even for unavailable rows.
                    */}
                    <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto">
                      {!unavailable && (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label="Зменшити кількість"
                            onClick={() =>
                              updateQuantity(item.productId, item.variantId, item.quantity - 1)
                            }
                            disabled={item.quantity <= 1}
                            className="h-11 w-11 rounded-lg border border-gray-300 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40"
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
                            className="h-11 w-11 rounded-lg border border-gray-300 text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-40"
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
                        className="flex h-11 w-11 items-center justify-center rounded-lg text-xl leading-none text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={clearCart}
                className="inline-flex min-h-[40px] items-center text-sm text-gray-500 hover:text-red-600 underline"
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
                     {subtotalByCurrency.size <= 1
                       ? formatPrice(
                           [...subtotalByCurrency.values()][0] ?? 0,
                           currency
                         )
                       : [...subtotalByCurrency.entries()]
                           .map(([cur, sum]) => formatPrice(sum, cur))
                           .join(' + ')}
                   </span>
                 </div>
                <p className="text-xs text-gray-500 mb-4">
                  Остаточна сума буде перерахована сервером при оформленні.
                </p>
                {purchasableRows.length > 0 || unknownRows.length > 0 ? (
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
    </main>
  );
}
