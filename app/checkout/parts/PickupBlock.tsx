'use client';

import Link from 'next/link';
import type { PickupPoint } from '@/app/lib/checkout-delivery';
import type { ProductDomain } from '@/app/lib/domains';
import type { PickupPaymentIntent } from '../delivery-apis';

/** Спеціалізація точки per домен — усі три, без старої ternary-брехні
 * «не шпалери = техніка» (лінолеумна точка з'явилася 2026-09-17). */
const DOMAIN_LABELS: Record<ProductDomain, string> = {
  wallpaper: 'шпалери',
  linoleum: 'лінолеум',
  tech: 'техніка',
};

interface PickupBlockProps {
  availablePickupPoints: readonly PickupPoint[];
  pickupPointId: string;
  paymentIntent: PickupPaymentIntent;
  setPickupPointId: (id: string) => void;
  setPaymentIntent: (intent: PickupPaymentIntent) => void;
  /** У кошику ≥2 різних доменів — усе замовлення чекатиме на одній точці
   * (розраховується в CheckoutForm як cartDomains.size > 1). */
  mixedCart: boolean;
}

// Самовивіз: точки під обраний домен кошика + спосіб оплати.
// Без довідників — статичний список PICKUP_POINTS; адресу
// точки сервер ще раз виводить канонічно.
// (Moved verbatim from CheckoutForm.tsx during the 2026-09-13 split.)
export default function PickupBlock({
  availablePickupPoints,
  pickupPointId,
  paymentIntent,
  setPickupPointId,
  setPaymentIntent,
  mixedCart,
}: PickupBlockProps) {
  return (
    <div className="mt-3 space-y-3">
      {mixedCart && (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          role="note"
        >
          У кошику товари різних напрямків — усе замовлення буде
          чекати на обраній точці.
        </p>
      )}
      <div className="space-y-2">
        {availablePickupPoints.map((p) => {
          const selected = pickupPointId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPickupPointId(p.id)}
              aria-pressed={selected}
              className={`min-h-[44px] w-full rounded-md border px-3 py-2 text-left text-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                selected
                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700'
                  : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
              }`}
            >
              <span className="block">{p.address}</span>
              <span className="block text-xs text-gray-500">
                {p.city} · безкоштовно ·{' '}
                {p.domains.map((d) => DOMAIN_LABELS[d]).join(' · ')}
              </span>
            </button>
          );
        })}
      </div>
      {/* Владелец 2026-09-14: ссылка на страницу точек с фото — адрес,
          телефоны, график. Точки и пины выше не трогаемы. */}
      <p className="text-right">
        <Link
          href="/samovyviz"
          className="inline-flex min-h-[44px] items-center text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline underline-offset-2"
        >
          Як нас знайти →
        </Link>
      </p>
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-gray-700">
          Оплата
        </legend>
        <div className="space-y-2">
          <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm">
            <input
              type="radio"
              name="pickup-payment"
              value="online"
              checked={paymentIntent === 'online'}
              onChange={() => setPaymentIntent('online')}
              className="h-4 w-4 text-blue-600"
            />
            Карткою онлайн (LiqPay) після оформлення
          </label>
          <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm">
            <input
              type="radio"
              name="pickup-payment"
              value="cash_on_pickup"
              checked={paymentIntent === 'cash_on_pickup'}
              onChange={() => setPaymentIntent('cash_on_pickup')}
              className="h-4 w-4 text-blue-600"
            />
            Готівкою при отриманні на точці
          </label>
        </div>
      </fieldset>
    </div>
  );
}
