'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart, MAX_ITEM_QUANTITY, MAX_CART_LINES } from '@/app/lib/cart-context';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { trackEvent } from '@/app/lib/track-event';
import {
  calcLinoleumMeters,
  DEFAULT_WASTE_PERCENT,
  extractPricePerSqm,
  extractWidthLabel,
} from '@/app/lib/linoleum/product-view';
import { formatPrice } from '@/app/lib/format';

/**
 * One selectable roll width — a product_variants row of a consolidated ln-*
 * product (owner plan C3 2026-09-18): the product is ONE design, the widths
 * are its variants (import-plan.ts). name = formatWidthM canon («1,5»/«2»),
 * price = грн за ПОГОННЫЙ метр of THAT width, stockQuantity = free METRES.
 */
export interface LinoleumWidthOption {
  id: string;
  name: string;
  price: number;
  stockQuantity: number;
  availabilityStatus: string;
}

interface LinoleumMeterPanelProps {
  productId: string;
  /**
   * Fallback price (грн за погонный метр): used only while the product has
   * NO width variants (0 вариантов — не должно после C2; honest fallback,
   * addItem с variantId=null — поведение до C3).
   */
  price: number;
  currency: string;
  /** Fallback free stock in METRES (products.stock_quantity) — no variants. */
  stockQuantity: number;
  availabilityStatus: string;
  /**
   * products.specifications — fallback roll width source for the calculator
   * («Ширина», uk-канон formatWidthM «2,5») and the «Ціна за м²» caption.
   * With variants the SELECTED variant's name IS the roll width (same
   * canon), so the spec read only backs the variant-less fallback.
   */
  specifications?: { name: string; value: string }[] | null;
  /**
   * Width variants for the chips — is_active product_variants mapped by the
   * page (RLS final_001 already returns only is_active rows; the page filter
   * is defense-in-depth). Empty/absent → the variant-less fallback above.
   */
  variants?: LinoleumWidthOption[];
}

/** Accepts "5" and "5,5" (some keyboards type a comma into inputs). */
function parsePositive(value: string): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Numeric width behind a variant name (uk comma canon «1,5»); null when the
 * name is not a width — such chips sort last and never crash the panel. */
function widthValueOf(name: string): number | null {
  return parsePositive(name);
}

/** Chips render narrowest-first, so the DEFAULT («перший in-stock або
 * найвужчий», owner plan C3) is deterministic: the first in-stock chip IS
 * the narrowest in-stock width. uk-«1,5» compares NUMERICALLY, never
 * lexically («10» would sort before «2» as text). */
function sortWidthOptions(
  options: LinoleumWidthOption[]
): LinoleumWidthOption[] {
  return [...options].sort((a, b) => {
    const wa = widthValueOf(a.name);
    const wb = widthValueOf(b.name);
    if (wa === null && wb === null) return 0;
    if (wa === null) return 1;
    if (wb === null) return -1;
    return wa - wb;
  });
}

/** Default width id: the NARROWEST (first in the sorted list) in-stock chip;
 * every width exhausted → the narrowest overall (the panel then shows the
 * «Цієї ширини немає в наявності» state, chips stay switchable). */
function pickDefaultWidthId(sorted: LinoleumWidthOption[]): string | null {
  const firstAvailable = sorted.find(
    (o) => o.stockQuantity > 0 && o.availabilityStatus !== 'out_of_stock'
  );
  return (firstAvailable ?? sorted[0])?.id ?? null;
}

const intUk = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });

/**
 * Buy-box for ln-* products (linoleum vertical, batch 3, owner plan
 * 2026-09-17; width selection — C3, owner plan 2026-09-18): the customer
 * buys WHOLE METRES of a running good AT A CHOSEN WIDTH. Width chips are
 * built from the product's product_variants (name = formatWidthM, price =
 * грн/пог.м of that width, stock = metres); the headline price and the
 * «{qty} м × {price} = {итого} грн» line update LIVE on chip switch, and
 * addItem carries the SELECTED variantId — place_order() (variant path)
 * stays the real boundary: it decrements variant stock at variant price.
 * 0 variants → the honest pre-C3 fallback: single running-meter price,
 * product-level stock, addItem(productId, null, qty).
 *
 * Below the buy-box: the room calculator (clone of the wallpaper
 * RollCalculator UX) — length × width + default +10 % waste, divided by the
 * SELECTED variant's width (fallback: the «Ширина» specification) → whole
 * running metres, one click «Підставити в метраж» fills the quantity field.
 * Math lives in the pure, unit-tested app/lib/linoleum/product-view.ts;
 * without a real width the calculator renders no estimate at all (no
 * invented numbers).
 */
export default function LinoleumMeterPanel({
  productId,
  price,
  currency,
  stockQuantity,
  availabilityStatus,
  specifications,
  variants,
}: LinoleumMeterPanelProps) {
  const { addItem } = useCart();

  const widthOptions = useMemo(
    () => sortWidthOptions(variants ?? []),
    [variants]
  );
  const defaultWidthId = useMemo(
    () => pickDefaultWidthId(widthOptions),
    [widthOptions]
  );
  // null = «дефолт ще не перевизначено кліком» — selectedWidthId падає на
  // дефолт (найвужча ширина в наявності), а не зберігає зайвий стан.
  const [pickedWidthId, setPickedWidthId] = useState<string | null>(null);
  const selectedWidthId = pickedWidthId ?? defaultWidthId;
  const selectedVariant =
    widthOptions.find((o) => o.id === selectedWidthId) ?? null;

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

  // Цена/сток ВЫБРАННОЙ ширины; без вариантов — продукт-фолбэк (до-C3).
  const effectivePrice = selectedVariant ? selectedVariant.price : price;
  const effectiveStock = selectedVariant
    ? selectedVariant.stockQuantity
    : stockQuantity;

  // Исчерпание ВЫБРАННОЙ ширины ≠ исчерпание продукта: другие ширины
  // остаются покупабельными, эта — с явным сообщением вместо кнопки.
  const widthUnavailable =
    selectedVariant !== null &&
    (selectedVariant.stockQuantity <= 0 ||
      selectedVariant.availabilityStatus === 'out_of_stock');

  // stock for ln-* carries METRES — clamp the purchasable meterage to the
  // selected width's stock, never above MAX_ITEM_QUANTITY (place_order
  // re-checks anyway).
  const maxMeters = Math.max(
    1,
    Math.min(effectiveStock || MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY)
  );
  const outOfStock = availabilityStatus === 'out_of_stock' || stockQuantity <= 0;

  const clampMeters = (n: number): number =>
    Number.isInteger(n) ? Math.max(1, Math.min(n, maxMeters)) : 1;

  // Ширина рулону для калькулятора: ПРИОРИТЕТ — імʼя ВИБРАНОГО варіанта
  // (formatWidthM «1,5» — той самий канон, що й у спеки; після C2 спеки
  // «Ширина» кілька, і find() по них дав би завжди першу). Fallback (0
  // варіантів) — перша «Ширина» зі специфікацій. Поза сіткою
  // LINOLEUM_WIDTHS_M валідує сам calc (→ meters: null).
  const rollWidthM = useMemo(() => {
    if (selectedVariant) return parsePositive(selectedVariant.name);
    const label = extractWidthLabel(specifications);
    return label === null ? null : parsePositive(label);
  }, [selectedVariant, specifications]);

  // null until both room dimensions are positive — no premature estimate.
  const calc = useMemo(() => {
    const lengthM = parsePositive(length);
    const widthM = parsePositive(width);
    if (lengthM === null || widthM === null || rollWidthM === null) return null;
    return calcLinoleumMeters({
      roomLengthM: lengthM,
      roomWidthM: widthM,
      wastePercent: DEFAULT_WASTE_PERCENT,
      widthM: rollWidthM,
    });
  }, [length, width, rollWidthM]);

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

  const selectWidth = (option: LinoleumWidthOption) => {
    if (option.id === selectedWidthId) return;
    const optionMax = Math.max(
      1,
      Math.min(option.stockQuantity || MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY)
    );
    setPickedWidthId(option.id);
    // Метраж покупця зберігаємо, але піджимаємо під залишок нової ширини.
    setMeters((m) => (Number.isInteger(m) ? Math.max(1, Math.min(m, optionMax)) : 1));
    resetFeedback();
  };

  const handleAdd = () => {
    const qty = clampMeters(meters);
    // addItem() silently rejects quantities above MAX_ITEM_QUANTITY —
    // surface that as an explicit notice instead of a fake success.
    if (meters > MAX_ITEM_QUANTITY || qty > MAX_ITEM_QUANTITY) {
      setMeterNotice(true);
      return;
    }
    // C3: метри додаються для ОБРАНОЇ ширини (place_order декрементить сток
    // варіанта за ціною варіанта); 0 варіантів → variantId=null (фолбэк).
    const addedOk = addItem(productId, selectedVariant ? selectedVariant.id : null, qty);
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

  const unitPrice = formatPrice(effectivePrice, currency);
  const priceSqm = extractPricePerSqm(specifications);
  const widthLabel = selectedVariant
    ? selectedVariant.name
    : extractWidthLabel(specifications);

  return (
    <div className="space-y-3">
      {widthOptions.length > 0 && (
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700">
            Ширина рулону:
          </span>
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="Ширина рулону"
          >
            {widthOptions.map((option) => {
              const selected = option.id === selectedWidthId;
              const soldOut =
                option.stockQuantity <= 0 ||
                option.availabilityStatus === 'out_of_stock';
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => selectWidth(option)}
                  className={`min-h-[44px] rounded-md border px-3 text-sm font-semibold transition-colors motion-reduce:transition-none ${
                    selected
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {option.name} м{soldOut ? ' · немає' : ''}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Заголовок ціни ОБРАНОЇ ширини (план C3): «{variant.price} грн/пог.м»
          + підпис «{price_sqm} грн/м²» — змінюються наживо при виборі чіпа. */}
      <div>
        <p className="text-2xl font-extrabold tracking-tight text-blue-700">
          {unitPrice}/пог.м
        </p>
        {priceSqm && (
          <p className="text-xs text-gray-500">{priceSqm} грн/м²</p>
        )}
      </div>

      {widthUnavailable ? (
        <p className="text-sm text-red-600" role="alert">
          Цієї ширини немає в наявності — оберіть іншу ширину рулону.
        </p>
      ) : (
        <>
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

          <p className="text-sm font-semibold text-gray-900">
            {meters} м × {unitPrice} = {formatPrice(meters * effectivePrice, currency)}
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
        </>
      )}

      {/* Калькулятор метражу (клон RollCalculator): довжина × ширина кімнати
          + 10 % запасу, ДІЛЕННЯ на ширину ВИБРАНОГО варіанта (fallback —
          специфікація «Ширина») → цілі погонні метри, «Підставити в метраж»
          заповнює поле кількості вище. Математика — pure
          product-view.calcLinoleumMeters. */}
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
                {intUk.format(
                  Number(length.replace(',', '.')) *
                    Number(width.replace(',', '.'))
                )}{' '}
                м² → {calc.meters} пог. м
              </span>{' '}
              (рулон {widthLabel} м)
            </p>
            <p className="mt-0.5 text-xs text-gray-500">
              + {DEFAULT_WASTE_PERCENT} % запасу
            </p>
            {calc.requiresSeam === true && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2" role="alert">
                Ширина рулону менша за обидві сторони кімнати — знадобиться стикування смуг.
              </p>
            )}
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
