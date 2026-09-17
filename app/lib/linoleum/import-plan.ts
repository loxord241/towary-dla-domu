/**
 * Pure import planner for the 1C linoleum stock (linoleum vertical, batch 2,
 * task L3, 2026-09-17). Mirrors app/lib/wallpapers/import-plan.ts and
 * app/lib/wallpapers/categories.ts: everything is decided BEFORE any write so
 * the CLI executor (scripts/linoleum-import.ts) can show the exact plan and
 * stay idempotent. No Next.js / DB imports — unit-tested with node:test.
 *
 * Identity rule (card = design × width, owner decision 2026-09-17): the
 * linoleum domain is defined by the `ln-` sku prefix (app/lib/domains.ts;
 * storefront: LINOLEUM_ROOT_SLUG in app/lib/catalog/shared.ts). Per feed row
 * (LinoleumRow, one row = one design×width from the daily export):
 *   sku = `ln-x<code>-w<widthToken>` where
 *     - `<code>` is the 1С code normalized (trim + lowercase + whitespace
 *       stripped — same recipe as the wallpaper article key). Codes already
 *       inside the slug charset [a-z0-9-] pass through unchanged; codes
 *       carrying any character OUTSIDE it (real supplier codes are often
 *       Cyrillic: «ЛІН-01160049») fall back to their DIGITS-ONLY core
 *       («01160049»), so every sku/slug stays in [a-z0-9-]. Deterministic
 *       and idempotent; a surviving collision (two codes sharing a digits
 *       core) resolves with a `-2`, `-3`, … suffix;
 *     - `<widthToken>` = width × 10 (`1.5→15, 2→20, 2.5→25, 3→30, 3.5→35,
 *       4→40`).
 *   Deterministic, idempotent, 1:1 over the fixed width whitelist
 *   LINOLEUM_WIDTHS_M (width tokens share no suffix relation, so distinct
 *   (code,width) pairs can never produce the same base sku). The token keeps
 *   every slug inside the [a-z0-9-] charset shared by the whole catalog —
 *   no dotted/comma slug class is introduced. A collision that survives this
 *   (two codes normalizing together) resolves with a `-2`, `-3`, … suffix —
 *   deterministically, so re-plans stay idempotent.
 *
 * Card display decisions (owner plan 2026-09-17):
 *   - name = `{name} {width} м` with the width in UKRAINIAN comma format
 *     (formatWidthM: `1,5` / `2` / `2,5` / `3` / `3,5` / `4`) — the site content
 *     language is Ukrainian and app/lib/format.ts renders uk-UA decimal
 *     commas everywhere; this formatter is THE single canonical width string
 *     for the product name, the «Ширина» specification value AND the future
 *     hub width filter (jsonb contains must match this exact literal);
 *   - products.price = грн за ПОГОННЫЙ метр = price_sqm × width_m rounded
 *     HALF-UP to a kopiyka (runningMeterPrice: integer-cents math that
 *     matches Postgres NUMERIC half-up — a naive Math.round on binary floats
 *     would give 15.22 for 10.15×1.5 where NUMERIC gives 15.23);
 *   - specifications (jsonb array, create): `{name:'Ціна за м²',
 *     value:'350,50'}` (formatPriceSqmValue: exactly 2 decimals, comma —
 *     the NUMERIC(12,2) canon) + `{name:'Ширина', value:'2,5'}`.
 *
 * Plan semantics (pinned by tests/linoleum-import-plan.test.ts):
 *   - rows are deduplicated by the (code, width_m) key; the LAST row for a
 *     key wins, order follows the first appearance of each key;
 *   - creates: slug === sku, availability derived from qty (0 →
 *     out_of_stock), isActive always false — publishing is a separate
 *     photo-presence gate (CLI --publish), never a planner decision;
 *   - updates: diff-aware, ONLY fields that actually diverge:
 *       price           — stored running-meter price ≠ computed;
 *       specifications  — stored «Ціна за м²» value ≠ formatted feed
 *                         price_sqm (rewritten in the SAME UPDATE statement:
 *                         a stale m² price next to a correct running-meter
 *                         price would be factually wrong on the PDP; the
 *                         rewrite replaces only that entry in place and
 *                         preserves every other entry and the order).
 *                         Rationale for touching specifications at all:
 *                         it is one extra field on an already-issued
 *                         diff-gated UPDATE — zero extra statements, honest
 *                         data. The «Ширина» entry is NEVER rewritten on
 *                         update: (code, width) IS the card identity, a
 *                         width change is a different card;
 *       stock_quantity  — stored qty ≠ feed qtyM;
 *     name/sku/slug/is_active of existing rows are never touched;
 *   - missing: existing ln-* products absent from the feed whose
 *     stock_quantity is not yet 0 (the executor OOS-es them, never deletes);
 *     already-reconciled (qty = 0) absent products are reported in noops so
 *     that re-planning over the applied result yields an empty plan;
 *   - conflicts: always [] by contract — the executor pre-filters the
 *     existing-products read to the ln-* domain, so a foreign owner of a sku
 *     cannot reach the planner.
 *
 * Idempotency contract: feeding the planner its own applied output (creates
 * materialized, updates applied, missing set to qty 0) again produces
 * creates = updates = missing = [] and every domain sku in noops.
 *
 * Categories: the linoleum subtree currently is exactly its root category
 * (LINOLEUM_ROOT_CATEGORY — «Лінолеум», slug = LINOLEUM_ROOT_SLUG);
 * subcategories arrive later with the 1С category data. planRootCategory is
 * the pure create-or-reuse-or-conflict decision for the CLI executor
 * (importer never renames: a slug under a different name is a conflict).
 */

import type { LinoleumRow, LinoleumWidthM } from './parse.ts';
import { LINOLEUM_SKU_PREFIX } from '../domains.ts';

/** Specification entry names, canon of the hub width filter (jsonb contains). */
export const PRICE_SQM_SPEC_NAME = 'Ціна за м²';
export const WIDTH_SPEC_NAME = 'Ширина';

export type SpecificationEntry = { name: string; value: string };

/** Storefront root category for the whole linoleum domain (uk name). */
export const LINOLEUM_ROOT_CATEGORY = {
  name: 'Лінолеум',
  slug: 'linoleum',
} as const;

/** A product row the executor already read from the DB (ln-* domain). */
export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  /** грн за погонный метр (products.price). */
  price: number;
  stockQuantity: number;
  isActive: boolean;
  /** Parsed specifications jsonb ([] when null/absent). */
  specifications: SpecificationEntry[];
}

export type LinoleumAvailability = 'in_stock' | 'out_of_stock';

/** A product the planner wants the executor to INSERT. */
export interface LinoleumPlanRow {
  sku: string;
  /** Equals `sku` (the sku is already slug-safe by construction). */
  slug: string;
  /** `{name} {width} м` — card = design × width (width in uk comma format). */
  name: string;
  /** грн за погонный метр = runningMeterPrice(priceSqm, widthM). */
  price: number;
  stockQuantity: number;
  availability: LinoleumAvailability;
  /** Always false: publishing is the CLI --publish photo-presence gate. */
  isActive: false;
  /** `[Ціна за м², Ширина]` — see module doc. */
  specifications: SpecificationEntry[];
}

/** A partial UPDATE restricted to the fields that actually diverged. */
export interface LinoleumPlanUpdate {
  id: string;
  fields: {
    price?: number;
    stock_quantity?: number;
    specifications?: SpecificationEntry[];
  };
}

export interface LinoleumPlan {
  creates: LinoleumPlanRow[];
  updates: LinoleumPlanUpdate[];
  /** ln-* products absent from the feed and not yet at qty 0 (→ OOS write). */
  missing: { id: string }[];
  /** Skus with no pending write this run (exact matches + reconciled missing). */
  noops: string[];
  /** Always [] (contract): domain filtering happens upstream in the executor. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// canonical formatters (single source for name + specs + future hub filter)
// ---------------------------------------------------------------------------

/** Width in uk comma format: `1.5→"1,5"`, `2→"2"` (see module doc). */
export function formatWidthM(widthM: LinoleumWidthM): string {
  return String(widthM).replace('.', ',');
}

/** «Ціна за м²» value: exactly 2 decimals with a comma (`350.5→"350,50"`). */
export function formatPriceSqmValue(priceSqm: number): string {
  return (Math.round(priceSqm * 100) / 100).toFixed(2).replace('.', ',');
}

/**
 * грн за погонный метр = price_sqm × width_m, HALF-UP to a kopiyka.
 * Integer-cents math: price_sqm carries ≤2 decimals (NUMERIC(12,2) canon →
 * exact cents via Math.round), width × 2 is a small exact integer
 * (3|4|5|6|7|8), so `(cents × widthHalf) / 2` is exact binary float and
 * Math.round resolves the `.5` cases HALF-UP — the same rounding Postgres
 * NUMERIC applies (naive `Math.round(priceSqm * widthM * 100)` loses on
 * binary representation: 10.15×1.5 = 15.224999… → 15.22 instead of 15.23).
 */
export function runningMeterPrice(priceSqm: number, widthM: LinoleumWidthM): number {
  const priceCents = Math.round(priceSqm * 100);
  const widthHalf = Math.round(widthM * 2);
  return Math.round((priceCents * widthHalf) / 2) / 100;
}

/** Card name: `{name} {width} м` (width in uk comma format). */
export function linoleumCardName(name: string, widthM: LinoleumWidthM): string {
  return `${name} ${formatWidthM(widthM)} м`;
}

/** Width token inside the sku: width × 10 (`1.5→"15"`, `2→"20"`). */
function skuWidthToken(widthM: LinoleumWidthM): string {
  return String(Math.round(widthM * 10));
}

/** Same recipe as the wallpaper article key: trim + lowercase, no whitespace.
 *  Codes already inside the slug charset [a-z0-9-] pass through unchanged
 *  (back-compat with every already-issued sku); anything carrying characters
 *  outside it — real supplier codes are often Cyrillic («ЛІН-01160049») —
 *  falls back to its DIGITS-ONLY core, keeping skus/slugs in [a-z0-9-]
 *  (owner task L7, 2026-09-17). */
function normalizeCode(code: string): string {
  const base = code.trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9-]+$/.test(base)) return base;
  return (base.match(/\d+/g) ?? []).join('');
}

/** `ln-x<code>-w<width×10>` — see module doc (deterministic, 1:1, slug-safe). */
export function linoleumSku(code: string, widthM: LinoleumWidthM): string {
  return `${LINOLEUM_SKU_PREFIX}x${normalizeCode(code)}-w${skuWidthToken(widthM)}`;
}

/** specifications payload for a create: `[Ціна за м², Ширина]`. */
function buildSpecifications(
  priceSqm: number,
  widthM: LinoleumWidthM
): SpecificationEntry[] {
  return [
    { name: PRICE_SQM_SPEC_NAME, value: formatPriceSqmValue(priceSqm) },
    { name: WIDTH_SPEC_NAME, value: formatWidthM(widthM) },
  ];
}

/** Stored «Ціна за м²» value, or undefined when the entry is absent. */
export function findSpecValue(
  specs: readonly SpecificationEntry[],
  name: string
): string | undefined {
  return specs.find((s) => s.name === name)?.value;
}

/**
 * Deterministic rewrite: the «Ціна за м²» entry is replaced IN PLACE (or
 * appended when absent); every other entry keeps its name, value and order.
 */
export function withPriceSqmSpec(
  specs: readonly SpecificationEntry[],
  value: string
): SpecificationEntry[] {
  const out = specs.map((s) =>
    s.name === PRICE_SQM_SPEC_NAME ? { name: PRICE_SQM_SPEC_NAME, value } : s
  );
  if (!specs.some((s) => s.name === PRICE_SQM_SPEC_NAME)) {
    out.push({ name: PRICE_SQM_SPEC_NAME, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// root category plan (create-or-reuse-or-conflict; importer never renames)
// ---------------------------------------------------------------------------

/** A category row the executor already read from the DB. */
export interface ExistingCategoryRow {
  id: string;
  slug: string;
  name: string;
}

export interface RootCategoryPlan {
  /** INSERT {name, slug: LINOLEUM_ROOT_CATEGORY} (root, parent_id null). */
  create: boolean;
  /** id of the existing root row when create === false. */
  existingId: string | null;
  /** true = the slug exists under a different name → executor aborts. */
  conflict: boolean;
}

export function planRootCategory(
  existing: readonly ExistingCategoryRow[]
): RootCategoryPlan {
  const row = existing.find((c) => c.slug === LINOLEUM_ROOT_CATEGORY.slug);
  if (row === undefined) return { create: true, existingId: null, conflict: false };
  if (row.name.trim() !== LINOLEUM_ROOT_CATEGORY.name) {
    return { create: false, existingId: null, conflict: true };
  }
  return { create: false, existingId: row.id, conflict: false };
}

// ---------------------------------------------------------------------------
// the planner
// ---------------------------------------------------------------------------

export function planLinoleumImport(
  existing: Map<string, ExistingProduct>,
  rows: LinoleumRow[]
): LinoleumPlan {
  // Dedup by (code, width_m): last row for a key wins; JS Map keeps the
  // first-appearance order, which makes the plan deterministic. The `|`
  // separator is collision-free here: the width suffixes
  // (`|1.5`,`|2`,`|2.5`,`|3`,`|3.5`,`|4`) share no suffix relation, so
  // `code1|w1 === code2|w2` implies `code1 === code2 && w1 === w2`.
  const byKey = new Map<string, LinoleumRow>();
  for (const row of rows) byKey.set(`${row.code}|${row.widthM}`, row);

  const creates: LinoleumPlanRow[] = [];
  const updates: LinoleumPlanUpdate[] = [];
  const missing: { id: string }[] = [];
  const noops: string[] = [];
  const conflicts: string[] = [];
  // Skus already decided this run (matched an existing row or claimed by a
  // create) — used to resolve collisions with a `-N` suffix.
  const claimed = new Set<string>();

  for (const row of byKey.values()) {
    const baseSku = linoleumSku(row.code, row.widthM);
    // Only the FIRST row of this run may claim an existing product; later
    // rows with the same derived sku are new sibling products (suffix below),
    // never silent re-writes of the same DB row.
    if (!claimed.has(baseSku)) {
      const found = existing.get(baseSku);
      if (found !== undefined) {
        claimed.add(baseSku);
        const expectedPrice = runningMeterPrice(row.priceSqm, row.widthM);
        const expectedSqm = formatPriceSqmValue(row.priceSqm);
        const storedSqm = findSpecValue(found.specifications, PRICE_SQM_SPEC_NAME);
        const fields: LinoleumPlanUpdate['fields'] = {};
        if (found.price !== expectedPrice) fields.price = expectedPrice;
        if (storedSqm !== expectedSqm) {
          fields.specifications = withPriceSqmSpec(found.specifications, expectedSqm);
        }
        if (found.stockQuantity !== row.qtyM) fields.stock_quantity = row.qtyM;
        if (
          fields.price === undefined &&
          fields.stock_quantity === undefined &&
          fields.specifications === undefined
        ) {
          noops.push(baseSku);
        } else {
          updates.push({ id: found.id, fields });
        }
        continue;
      }
    }

    let sku = baseSku;
    let n = 2;
    while (claimed.has(sku) || existing.has(sku)) {
      sku = `${baseSku}-${n}`;
      n += 1;
    }
    claimed.add(sku);
    creates.push({
      sku,
      slug: sku,
      name: linoleumCardName(row.name, row.widthM),
      price: runningMeterPrice(row.priceSqm, row.widthM),
      stockQuantity: row.qtyM,
      availability: row.qtyM > 0 ? 'in_stock' : 'out_of_stock',
      isActive: false,
      specifications: buildSpecifications(row.priceSqm, row.widthM),
    });
  }

  // Positions that left the feed: report them for the OOS write until the
  // stock actually reached 0; already-reconciled ones are plain noops.
  for (const [sku, product] of existing) {
    if (!sku.startsWith(LINOLEUM_SKU_PREFIX)) continue; // defensive: pre-filtered upstream
    if (claimed.has(sku)) continue;
    if (product.stockQuantity !== 0) missing.push({ id: product.id });
    else noops.push(sku);
  }

  return { creates, updates, missing, noops, conflicts };
}
