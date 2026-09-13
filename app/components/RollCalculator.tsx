'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useCart, MAX_ITEM_QUANTITY } from '@/app/lib/cart-context';
import { ANALYTICS_EVENTS } from '@/app/lib/analytics';
import { trackEvent } from '@/app/lib/track-event';
import {
  calculateRolls,
  type RollCalculation,
} from '@/app/lib/wallpapers/roll-math';
import type { RollSize } from '@/app/lib/wallpapers/parse';

interface RollCalculatorProps {
  productId: string;
  /**
   * Roll geometry parsed on the SERVER from the product name
   * (parseRollSize, app/lib/wallpapers/parse.ts). MAY BE NULL: most 1C
   * names state no size at all (bug report 2026-09-11 — those products
   * had no calculator). Null does NOT hide the calculator: the size
   * select starts on a disabled «оберіть розмір» placeholder and the
   * customer picks explicitly — a guessed width (53 vs 106) would give
   * a wrong purchase quantity, so nothing is assumed.
   */
  rollSize: RollSize | null;
}

interface RollOption {
  key: string;
  label: string;
  widthM: 0.53 | 1.06;
  lengthM: 10 | 15;
}

/** Nominal roll sizes stocked by the 1C feed (106×15 included: parseRollSize
 *  can legitimately yield it, so the select must be able to show it). */
const ROLL_OPTIONS: RollOption[] = [
  { key: '53x10', label: '0,53 × 10 м', widthM: 0.53, lengthM: 10 },
  { key: '53x15', label: '0,53 × 15 м', widthM: 0.53, lengthM: 15 },
  { key: '106x10', label: '1,06 × 10 м', widthM: 1.06, lengthM: 10 },
  { key: '106x15', label: '1,06 × 15 м', widthM: 1.06, lengthM: 15 },
];

function optionKeyOf(size: RollSize): string {
  return `${size.widthCm}x${size.lengthM}`;
}

function rollOptionOf(key: string): RollOption {
  // rollKey only ever comes from optionKeyOf() or the select's values, but
  // keep a safe fallback for defensive robustness.
  return ROLL_OPTIONS.find((o) => o.key === key) ?? ROLL_OPTIONS[0]!;
}

/** Accepts "18" and "18,5" (some keyboards/IMEs type a comma into inputs). */
function parsePositive(value: string): number | null {
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Roll calculator for wallpaper PDPs («як на Славі»): perimeter + height +
 * pattern toggle → recommended roll count, addable straight to the cart.
 * The math lives in the pure, unit-tested app/lib/wallpapers/roll-math.ts.
 */
export default function RollCalculator({
  productId,
  rollSize,
}: RollCalculatorProps) {
  const { addItem } = useCart();

  const [perimeter, setPerimeter] = useState('');
  const [height, setHeight] = useState('');
  const [pattern, setPattern] = useState(false);
  // '' = розмір не розпізнано з назви: покупець обирає його в select вручну.
  const [rollKey, setRollKey] = useState(rollSize === null ? '' : optionKeyOf(rollSize));
  const [added, setAdded] = useState(false);
  const [limitNotice, setLimitNotice] = useState(false);

  // Any input change invalidates the previous outcome feedback.
  const resetFeedback = () => {
    setAdded(false);
    setLimitNotice(false);
  };

  const roll = rollKey === '' ? null : rollOptionOf(rollKey);

  // null until both numbers are positive AND a roll size is chosen — no
  // premature recommendation.
  const calc = useMemo<RollCalculation | null>(() => {
    if (roll === null) return null;
    const perimeterM = parsePositive(perimeter);
    const heightM = parsePositive(height);
    if (perimeterM === null || heightM === null) return null;
    return calculateRolls({
      wallPerimeterM: perimeterM,
      wallHeightM: heightM,
      roll: { widthM: roll.widthM, lengthM: roll.lengthM },
      patternMatch: pattern,
    });
  }, [perimeter, height, roll, pattern]);

  const handleAdd = () => {
    if (!calc || calc.impossible || calc.rolls === null) return;
    // addItem() silently rejects quantities above MAX_ITEM_QUANTITY —
    // surface that as an explicit notice instead of a fake success.
    if (calc.rolls > MAX_ITEM_QUANTITY) {
      setLimitNotice(true);
      return;
    }
    const addedOk = addItem(productId, null, calc.rolls);
    if (!addedOk) {
      setLimitNotice(true);
      return;
    }
    setLimitNotice(false);
    // Anonymous analytics: product UUID only, no PII (same as AddToCartButton).
    trackEvent(ANALYTICS_EVENTS.ADD_TO_CART, { product_id: productId });
    setAdded(true);
  };

  return (
    <div className="wrap-anywhere mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <h3 className="mb-3 font-semibold text-gray-900">
        Розрахунок кількості рулонів
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">
            Периметр приміщення, м
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.1}
            value={perimeter}
            onChange={(e) => {
              setPerimeter(e.target.value);
              resetFeedback();
            }}
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-gray-700">
            Висота стін, м
          </span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.1}
            value={height}
            onChange={(e) => {
              setHeight(e.target.value);
              resetFeedback();
            }}
            className="w-full rounded-md border border-gray-300 p-2"
          />
        </label>
      </div>

      {rollSize === null && (
        <p className="mb-3 text-sm text-amber-700" role="note">
          Розмір рулона не вказано в назві товару — оберіть його вручну, щоб
          розрахунок був точним.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={pattern}
            onChange={(e) => {
              setPattern(e.target.checked);
              resetFeedback();
            }}
            className="h-4 w-4"
          />
          Малюнок з підбором
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <span className="font-medium">Розмір рулона:</span>
          <select
            value={rollKey}
            onChange={(e) => {
              setRollKey(e.target.value);
              resetFeedback();
            }}
            className="rounded-md border border-gray-300 p-2"
          >
            <option value="" disabled>
              оберіть розмір
            </option>
            {ROLL_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {calc !== null && roll !== null && calc.impossible && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          Смуга заввишки {calc.stripLengthM.toLocaleString('uk-UA')} м не
          вміщується в рулон {roll.label}. Перевірте висоту стін або оберіть
          інший розмір рулона.
        </p>
      )}

      {calc !== null && roll !== null && !calc.impossible && calc.rolls !== null && (
        <div className="added-in motion-reduce:animate-none mt-3 rounded-md bg-white p-3 shadow-sm">
          <p className="text-gray-700">
            Рекомендовано:{' '}
            <span className="text-lg font-extrabold text-blue-700">
              {calc.rolls} рул.
            </span>
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {calc.strips} смуг × {calc.stripLengthM.toLocaleString('uk-UA')} м;
            {calc.stripsPerRoll}{' '}
            {calc.stripsPerRoll === 1 ? 'смуга' : calc.stripsPerRoll < 5 ? 'смуги' : 'смуг'} з
            рулона
          </p>
          {added ? (
            <Link
              href="/cart"
              className="mt-2 block rounded-lg bg-green-600 py-2 text-center font-semibold text-white transition-colors hover:bg-green-700 motion-reduce:transition-none"
            >
              Додано — перейти в кошик
            </Link>
          ) : (
            <button
              type="button"
              onClick={handleAdd}
              className="mt-2 w-full rounded-lg bg-blue-600 py-2 font-semibold text-white transition-colors hover:bg-blue-700 motion-reduce:transition-none"
            >
              Додати {calc.rolls} у кошик
            </button>
          )}
          {limitNotice && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              Максимум {MAX_ITEM_QUANTITY} рулонів за одну позицію кошика.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
