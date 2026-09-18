/**
 * Pure view-layer helpers for ln-* products (linoleum vertical, batch 3,
 * task L6, 2026-09-17). Everything the PDP and ProductCard need to render
 * the linoleum price/badge/meter UX, decided ONCE here:
 *
 *   - extractPricePerSqm / extractWidthLabel read the specification entries
 *     the batch-2 importer writes (import-plan.ts: «Ціна за м²» in the
 *     formatPriceSqmValue canon «410,00», «Ширина» in the formatWidthM
 *     canon «1,5»). The entry NAMES come from import-plan's constants —
 *     no duplicated literals. Missing entry → null: callers render the
 *     fallback (running-meter price) instead of inventing a number.
 *
 *   - calcLinoleumMeters: room length × width + default +10 % waste,
 *     DIVIDED BY the roll width (widthM — required, one of
 *     LINOLEUM_WIDTHS_M), ceil to WHOLE running metres — the storefront
 *     sells integer metres 1–99 (owner plan 2026-09-17; the штатный
 *     integer cart path already enforces 1..MAX_ITEM_QUANTITY).
 *
 * Length arithmetic runs in INTEGER centimetres (same discipline as
 * app/lib/wallpapers/roll-math.ts): users type ≤2 decimals, so cm inputs
 * are exact integers and every subsequent multiply is exact double math —
 * IEEE-754 binary fractions never reach the ceil() that rounds to metres.
 * 1 м² = 10 000 см², waste is applied as an integer percent.
 *
 * Pure module — no React, no Next.js, no DB. Unit-tested with node:test
 * (tests/linoleum-product-view.test.ts) and safe to import from client
 * components.
 */

import { PRICE_SQM_SPEC_NAME, WIDTH_SPEC_NAME } from './import-plan.ts';
import { LINOLEUM_WIDTHS_M } from './parse.ts';

/** Real roll widths (parse.ts grid) for an EXACT Set lookup — every member
 * is exactly representable in binary floating point, so no epsilon needed
 * (same trick as parse.ts WIDTH_SET). */
const WIDTH_SET: ReadonlySet<number> = new Set<number>(LINOLEUM_WIDTHS_M);

/** One supplier characteristics entry (products.specifications jsonb). */
export interface SpecEntry {
  name: string;
  value: string;
}

/** Stored «Ціна за м²» value («410,00»), or null when the entry is absent. */
export function extractPricePerSqm(
  specifications: readonly SpecEntry[] | null | undefined
): string | null {
  if (!Array.isArray(specifications)) return null;
  return specifications.find((s) => s.name === PRICE_SQM_SPEC_NAME)?.value ?? null;
}

/** Stored «Ширина» value (uk format «1,5»), or null when the entry is absent. */
export function extractWidthLabel(
  specifications: readonly SpecEntry[] | null | undefined
): string | null {
  if (!Array.isArray(specifications)) return null;
  return specifications.find((s) => s.name === WIDTH_SPEC_NAME)?.value ?? null;
}

export interface LinoleumMeterInput {
  /** Room length along the roll, metres, > 0. */
  roomLengthM: number;
  /** Room width, metres, > 0. */
  roomWidthM: number;
  /**
   * Roll width, metres — REQUIRED and STRICTLY one of LINOLEUM_WIDTHS_M
   * (parse.ts grid 1.5|2|2.5|3|3.5|4). Bug fix 2026-09-17 (owner review):
   * running metres = (room area + waste) / roll width — the pre-fix version
   * ignored the width and returned the room area WITH waste as «пог. м»
   * (a 22 м² room on a 2,5 м roll showed 22 instead of 9 running metres).
   * Anything outside the grid (broken «Ширина» specification) → null: no
   * invented recommendation.
   */
  widthM: number;
  /** Cutting/pattern waste, whole percent, ≥ 0. Default 10. */
  wastePercent?: number;
}

export interface LinoleumMeterCalculation {
  /** Whole running metres to order, or null when impossible. */
  meters: number | null;
}

const CM_PER_M = 100;
const SQM_IN_SQCM = CM_PER_M * CM_PER_M; // 10 000 см² у м²
export const DEFAULT_WASTE_PERCENT = 10;

/**
 * Total function: never throws. Non-finite / non-positive dimensions, a
 * negative waste percent or a roll width outside LINOLEUM_WIDTHS_M degrade
 * to `{ meters: null }` so the caller renders a neutral state instead of a
 * wrong recommendation.
 */
export function calcLinoleumMeters(
  input: LinoleumMeterInput
): LinoleumMeterCalculation {
  const wastePercent = input.wastePercent ?? DEFAULT_WASTE_PERCENT;

  if (
    !Number.isFinite(input.roomLengthM) ||
    !Number.isFinite(input.roomWidthM) ||
    !Number.isFinite(input.widthM) ||
    !Number.isFinite(wastePercent) ||
    wastePercent < 0 ||
    input.widthM <= 0 ||
    // Точне порівняння: усі члени сітки точно представлені в binary float.
    !WIDTH_SET.has(input.widthM)
  ) {
    return { meters: null };
  }

  const lengthCm = Math.round(input.roomLengthM * CM_PER_M);
  const widthCm = Math.round(input.roomWidthM * CM_PER_M);
  const rollWidthCm = Math.round(input.widthM * CM_PER_M);
  if (lengthCm <= 0 || widthCm <= 0 || rollWidthCm <= 0) {
    return { meters: null };
  }

  // Погонні метри = (площа з запасом) / (ширина рулону). У сантиметрах:
  // площа (см²) × (100 + запас) — цілочисельно; дільник
  // SQM_IN_SQCM × rollWidthCm = 10 000 (см² → м²) × ширина (см), при цьому
  // приховані ÷100 відсотка запасу та ×100 переводу ширини см→м скорочуються.
  // Стеля — ОДНА, у цілі погонні метри. Числа побутових кімнат
  // (≤ ~10⁸ см² × 200) та дільник (≤ 4×10⁶) — точні doubles.
  const areaSqCm = lengthCm * widthCm;
  const withWasteSqCm = areaSqCm * (100 + wastePercent);
  return { meters: Math.ceil(withWasteSqCm / (SQM_IN_SQCM * rollWidthCm)) };
}
