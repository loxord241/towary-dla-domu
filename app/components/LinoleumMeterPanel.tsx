'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart, MAX_ITEM_QUANTITY, MAX_CART_LINES } from '@/app/lib/cart-context';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { trackEvent } from '@/app/lib/track-event';
import {
  calcLinoleumMeters,
  DEFAULT_WASTE_PERCENT,
} from '@/app/lib/linoleum/product-view';
import { formatPrice } from '@/app/lib/format';

interface LinoleumMeterPanelProps {
  productId: string;
  /** products.price = грн за ПОГОННЫЙ метр (ln-* contract, import-plan.ts). */
  price: number;
  currency: string;
  /** Free stock in METRES: for ln-* stock_quantity = qtyM (import-plan.ts). */
  stockQuantity: number;
  availabilityStatus: string;
}

/** Accepts "5" and "5,5" (some keyboards type a comma into inputs). */
function parsePositive(value: string): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const intUk = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });

/**
 * Buy-box for ln-* products (linoleum vertical, batch 3, owner plan
 * 2026-09-17): the customer buys WHOLE METRES of a running good, so the
 * quantity label is «Метраж (м)», the unit price (грн/пог.м) is shown as a
 * hint and the line total updates live: «{qty} м × {price} = {итого} грн».
 * The integer cart path is reused unchanged (addItem with variantId=null,
 * 1..MAX_ITEM_QUANTITY — place_order() stays the real boundary).
 *
 * Below the buy-box: the room calculator (clone of the wallpaper
 * RollCalculator UX) — length × width + default +10 % waste → whole metres,
 * one click «Підставити в метраж» fills the quantity field. Math lives in
 * the pure, unit-tested app/lib/linoleum/product-view.ts.
 */
export default function LinoleumMeterPanel({
  productId,
  price,
  currency,
  stockQuantity,
  availabilityStatus,
}: LinoleumMeterPanelProps) {
  const { addItem } = useCart();

  const [meters, setMeters] = useState(1);
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [added, setAdded] = useState(false);
  const [meterNotice, setMeterNotice] = useState(false);
  const [cartNotice, setCartNotice] = useState(false);

  // Any input change invalidates the previous outcome feedback.
  const resetFeedback = () => {
    setAdded(false);
    setMeterNotice(false);
    setCartNotice(false);
  };

  // stock_quantity for ln-* carries METRES — clamp the purchasable meterage
  // to it, never above MAX_ITEM_QUANTITY (place_order re-checks anyway).
  const maxMeters = Math.max(
    1,
    Math.min(stockQuantity || MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY)
  );
  const outOfStock = availabilityStatus === 'out_of_stock' || stockQuantity <= 0;

  const clampMeters = (n: number): number =>
    Number.isInteger(n) ? Math.max(1, Math.min(n, maxMeters)) : 1;

  // null until both room dimensions are positive — no premature estimate.
  const calc = useMemo(() => {
    const lengthM = parsePositive(length);
    const widthM = parsePositive(width);
    if (lengthM === null || widthM === null) return null;
    return calcLinoleumMeters({
      roomLengthM: lengthM,
      roomWidthM: widthM,
      wastePercent: DEFAULT_WASTE_PERCENT,
    });
  }, [length, width]);

  if (outOfStock) {
    return (
      <button
        type="button"
        disabled
        className="w-full bg-gray-300 text-gray-600 py-3 rounded-lg font-semibold cursor-not-allowed"
      >
        Немає в наявності
      </button>
    );
  }

  const handleAdd = () => {
    const qty = clampMeters(meters);
    // addItem() silently rejects quantities above MAX_ITEM_QUANTITY —
    // surface that as an explicit notice instead of a fake success.
    if (meters > MAX_ITEM_QUANTITY || qty > MAX_ITEM_QUANTITY) {
      setMeterNotice(true);
      return;
    }
    const addedOk = addItem(productId, null, qty);
    if (!addedOk) {
      setCartNotice(true);
      return;
    }
    // Anonymous analytics: product UUID only, no PII (same as AddToCartButton).
    trackEvent(ANALYTICS_EVENTS.ADD_TO_CART, { product_id: productId });
    setAdded(true);
  };

  const applyCalculation = () => {
    if (calc === null || calc.meters === null) return;
    setMeters(clampMeters(calc.meters));
    resetFeedback();
  };

  const unitPrice = formatPrice(price, currency);

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-gray-700">
          Метраж (м):
        </span>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={maxMeters}
            step={1}
            value={meters}
            onChange={(e) => {
              const n = Number(e.target.value);
              setMeters(Number.isInteger(n) ? n : 1);
              resetFeedback();
            }}
            onBlur={() => setMeters(clampMeters(meters))}
            className="w-20 text-base min-h-[44px] border border-gray-300 rounded-md p-2"
          />
          <span className="text-xs text-gray-500">макс. {maxMeters} м</span>
        </div>
      </label>

      <p className="text-xs text-gray-500">ціна: {unitPrice}/пог.м</p>
      <p className="text-sm font-semibold text-gray-900">
        {meters} м × {unitPrice} = {formatPrice(meters * price, currency)}
      </p>

      {added ? (
        <div className="added-in motion-reduce:animate-none flex gap-3">
          <Link
            href="/cart"
            className="flex-1 text-center bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors motion-reduce:transition-none"
          >
            У кошику — перейти
          </Link>
          <button
            type="button"
            onClick={() => setAdded(false)}
            className="px-4 border border-gray-300 rounded-lg text-sm text-gray-600 hover:bg-gray-50"
          >
            Ще
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleAdd}
          className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition-colors motion-reduce:transition-none"
        >
          Додати в кошик
        </button>
      )}

      {meterNotice && (
        <p className="text-sm text-red-600" role="alert">
          Максимум {MAX_ITEM_QUANTITY} м за одну позицію кошика.
        </p>
      )}
      {cartNotice && (
        <p className="text-sm text-red-600" role="alert">
          У кошику максимум {MAX_CART_LINES} позицій. Видаліть щось, щоб
          додати новий товар.
        </p>
      )}

      {/* Калькулятор метражу (клон RollCalculator): довжина × ширина кімнати
          + 10 % запасу → цілі метри, «Підставити в метраж» заповнює поле
          кількості вище. Математика — pure product-view.calcLinoleumMeters. */}
      <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h3 className="mb-3 font-semibold text-gray-900">Розрахунок метражу</h3>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Довжина кімнати, м
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={0.1}
              value={length}
              onChange={(e) => {
                setLength(e.target.value);
                resetFeedback();
              }}
              className="w-full rounded-md border border-gray-300 p-2"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Ширина кімнати, м
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={0.1}
              value={width}
              onChange={(e) => {
                setWidth(e.target.value);
                resetFeedback();
              }}
              className="w-full rounded-md border border-gray-300 p-2"
            />
          </label>
        </div>

        {calc !== null && calc.meters !== null && (
          <div className="added-in motion-reduce:animate-none mt-3 rounded-md bg-white p-3 shadow-sm">
            <p className="text-gray-700">
              Розраховано:{' '}
              <span className="text-lg font-extrabold text-blue-700">
                {calc.meters} м
              </span>
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              площа{' '}
              {intUk.format(
                Number(length.replace(',', '.')) *
                  Number(width.replace(',', '.'))
              )}{' '}
              м² + {DEFAULT_WASTE_PERCENT} % запасу
            </p>
            <button
              type="button"
              onClick={applyCalculation}
              className="mt-2 w-full rounded-lg bg-blue-600 py-2 font-semibold text-white transition-colors hover:bg-blue-700 motion-reduce:transition-none"
            >
              Підставити в метраж
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
