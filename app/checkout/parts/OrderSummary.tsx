'use client';

import Image from 'next/image';
import type { CartItem } from '@/app/lib/cart-context';
import type { CartPreviewLine } from '@/app/lib/cart-preview';
import { formatPrice } from '@/app/lib/format';
import type { DeliveryType } from '../delivery-apis';

interface OrderSummaryProps {
  items: CartItem[];
  purchasable: { item: CartItem; preview: CartPreviewLine | undefined }[];
  unavailableItems: { item: CartItem; preview: CartPreviewLine | undefined }[];
  previewError: boolean;
  subtotalByCurrency: Map<string, number>;
  currency: string;
  deliveryType: DeliveryType | '';
  removeItem: (productId: string, variantId: string | null) => void;
}

// Order summary. order-first keeps it ABOVE the submit button on
// mobile (DOM order puts the aside after the whole form there);
// lg:order-none restores the natural two-column layout.
// (Moved verbatim from CheckoutForm.tsx during the 2026-09-13 split.)
export default function OrderSummary({
  items,
  purchasable,
  unavailableItems,
  previewError,
  subtotalByCurrency,
  currency,
  deliveryType,
  removeItem,
}: OrderSummaryProps) {
  return (
    <aside
      className="card order-first w-full p-6 lg:order-none lg:sticky lg:top-24 lg:w-96"
      aria-label="Склад замовлення"
    >
      <h2 className="mb-4 text-lg font-semibold">Ваше замовлення</h2>

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">Кошик порожній</p>
      ) : previewError && purchasable.length === 0 ? (
        <p
          className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          role="status"
        >
          Не вдалося завантажити ціни товарів. Оформіть замовлення — точну
          суму підтвердить менеджер.
        </p>
      ) : (
        <>
          {unavailableItems.length > 0 && (
            <div
              className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2"
              role="status"
            >
              <p className="text-sm font-medium text-red-800">
                Ці товари більше недоступні:
              </p>
              <ul className="mt-2 space-y-2">
                {unavailableItems.map(({ item, preview }) => (
                  <li
                    key={`${item.productId}::${item.variantId ?? ''}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate text-red-700">
                      {preview?.found
                        ? (preview.name ?? 'Товар')
                        : 'Товар більше не доступний у каталозі'}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        removeItem(item.productId, item.variantId)
                      }
                      className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition"
                    >
                      Видалити
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="mb-4 space-y-3 text-sm">
            {purchasable.map(({ item, preview }) => (
              <li key={`${item.productId}::${item.variantId ?? ''}`} className="flex gap-3">
                {preview?.imageUrl && (
                  <Image
                    src={preview.imageUrl}
                    alt={preview.name ?? ''}
                    width={48}
                    height={48}
                    sizes="48px"
                    className="h-12 w-12 rounded-lg border border-gray-100 object-cover"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block line-clamp-2 font-medium">{preview?.name}</span>
                  {preview?.variantName && (
                    <span className="block text-xs text-gray-500">{preview.variantName}</span>
                  )}
                  <span className="text-xs text-gray-500">{item.quantity} шт</span>
                </span>
                 <span className="whitespace-nowrap font-medium">
                   {formatPrice(
                     (preview?.unitPrice ?? 0) * item.quantity,
                     preview?.currency ?? currency
                   )}
                 </span>
              </li>
            ))}
          </ul>
           <dl className="space-y-1 border-t border-gray-100 pt-3 text-sm">
             <div className="flex justify-between text-gray-600">
               <dt>Товари</dt>
               <dd>
                 {subtotalByCurrency.size <= 1
                   ? formatPrice(
                       [...subtotalByCurrency.values()][0] ?? 0,
                       currency
                     )
                   : [...subtotalByCurrency.entries()]
                       .map(([cur, sum]) => formatPrice(sum, cur))
                       .join(' + ')}
               </dd>
             </div>
             <div className="flex justify-between text-gray-600">
               <dt>Доставка</dt>
               <dd>
                 {deliveryType === 'pickup'
                   ? 'Безкоштовно (самовивіз)'
                   : 'за тарифами перевізника'}
               </dd>
             </div>
             <div className="flex justify-between pt-1 text-base font-bold text-gray-900">
               <dt>До сплати</dt>
               <dd>
                 {subtotalByCurrency.size <= 1
                   ? formatPrice(
                       [...subtotalByCurrency.values()][0] ?? 0,
                       currency
                     )
                   : [...subtotalByCurrency.entries()]
                       .map(([cur, sum]) => formatPrice(sum, cur))
                       .join(' + ')}
               </dd>
             </div>
           </dl>
          {previewError && (
            <p
              className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
              role="status"
            >
              Не вдалося завантажити частину цін — точну суму підтвердить
              менеджер.
            </p>
          )}
          <p className="mt-3 border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-500">
            Для оформлення купівлі товару в оплату частинами від
            ПриватБанку, А-Банку та Пумб Банку звертатися за номером
            телефону{' '}
            <a
              href="tel:+380973144221"
              className="whitespace-nowrap font-medium text-blue-600 hover:underline"
            >
              +380 (97) 314 42 21
            </a>{' '}
            (приймаємо дзвінки до 16:00).
          </p>
        </>
      )}
    </aside>
  );
}
