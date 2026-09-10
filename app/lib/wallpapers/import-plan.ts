/**
 * Pure import planner for the 1C 7.7 wallpaper stock (wallpapers import,
 * Task 6). Same pattern as app/lib/yugcontract/import-plan.ts and
 * app/lib/wallpapers/categories.ts: everything is decided BEFORE any write so
 * the CLI executor (Task 7, scripts/wallpaper-import.ts) can show the exact
 * plan and stay idempotent. No Next.js / DB imports — unit-tested with
 * node:test.
 *
 * Identity rule: the wallpaper domain is defined by the `wc-` sku prefix
 * (products with yugcontract_id IS NULL AND sku LIKE 'wc-%'). Per feed row:
 *   - article present  → sku `wc-<article key>`  (lowercased, whitespace
 *     removed: `SP 531-34` → `wc-sp531-34`);
 *   - article absent   → sku `wc-x<code>` — the `x` marker separates
 *     code-derived skus from article-derived ones.
 *
 * Plan semantics (pinned by tests/wallpaper-import-plan.test.ts):
 *   - rows are deduplicated by the 1С `code` column; the LAST row for a code
 *     wins, order follows the first appearance of each code;
 *   - creates: slug === sku, name verbatim from 1С, availability derived from
 *     qty (0 → out_of_stock), isActive always false — publishing is a separate
 *     gate (Task 9, photo presence), never a planner decision;
 *   - updates: diff-aware, ONLY fields that actually diverge (price,
 *     stock_quantity); name/sku/slug/is_active of existing rows are never
 *     touched;
 *   - missing: existing wc-* products absent from the feed whose
 *     stock_quantity is not yet 0 (the executor OOS-es them, never deletes);
 *     already-reconciled (qty = 0) absent products are reported in noops so
 *     that re-planning over the applied result yields an empty plan;
 *   - a sku/slug collision (two codes claiming one article) is resolved with
 *     a `-2`, `-3`, … suffix — deterministically, so re-plans stay idempotent;
 *   - conflicts: always [] by contract — the executor pre-filters the
 *     existing-products read to the wc-* domain, so a foreign owner of a sku
 *     cannot reach the planner.
 *
 * Idempotency contract: feeding the planner its own applied output (creates
 * materialized, updates applied, missing set to qty 0) again produces
 * creates = updates = missing = [] and every domain sku in noops.
 */

import type { WallpaperRow } from './parse.ts';

/** Sku prefix that marks a product as owned by the wallpapers feed. */
const WALLPAPER_SKU_PREFIX = 'wc-';

/** A product row the executor already read from the DB (wc-* domain). */
export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stockQuantity: number;
  isActive: boolean;
}

export type WallpaperAvailability = 'in_stock' | 'out_of_stock';

/** A product the planner wants the executor to INSERT. */
export interface WallpaperPlanRow {
  sku: string;
  /** Equals `sku` (the sku is already slug-safe by construction). */
  slug: string;
  /** Verbatim from the 1С feed (Ukrainian content language). */
  name: string;
  price: number;
  stockQuantity: number;
  availability: WallpaperAvailability;
  /** Always false: publishing is the Task 9 photo-presence gate. */
  isActive: false;
}

/** A partial UPDATE restricted to the fields that actually diverged. */
export interface WallpaperPlanUpdate {
  id: string;
  fields: {
    price?: number;
    stock_quantity?: number;
  };
}

export interface WallpaperPlan {
  creates: WallpaperPlanRow[];
  updates: WallpaperPlanUpdate[];
  /** wc-* products absent from the feed and not yet at qty 0 (→ OOS write). */
  missing: { id: string }[];
  /** Skus with no pending write this run (exact matches + reconciled missing). */
  noops: string[];
  /** Always [] (contract): domain filtering happens upstream in the executor. */
  conflicts: string[];
}

function normalizeArticleKey(article: string): string {
  return article.trim().toLowerCase().replace(/\s+/g, '');
}

function wallpaperSkuFor(row: WallpaperRow): string {
  if (row.article !== null) {
    const key = normalizeArticleKey(row.article);
    if (key !== '') return `${WALLPAPER_SKU_PREFIX}${key}`;
  }
  return `${WALLPAPER_SKU_PREFIX}x${row.code}`;
}

export function planWallpaperImport(
  existing: Map<string, ExistingProduct>,
  rows: WallpaperRow[]
): WallpaperPlan {
  // Dedup by 1С code: last row for a code wins; JS Map keeps the
  // first-appearance order, which makes the plan deterministic.
  const byCode = new Map<string, WallpaperRow>();
  for (const row of rows) byCode.set(row.code, row);

  const creates: WallpaperPlanRow[] = [];
  const updates: WallpaperPlanUpdate[] = [];
  const missing: { id: string }[] = [];
  const noops: string[] = [];
  const conflicts: string[] = [];
  // Skus already decided this run (matched an existing row or claimed by a
  // create) — used to resolve collisions with a `-N` suffix.
  const claimed = new Set<string>();

  for (const row of byCode.values()) {
    const baseSku = wallpaperSkuFor(row);
    // Only the FIRST row of this run may claim an existing product; later
    // rows with the same derived sku are new sibling products (suffix below),
    // never silent re-writes of the same DB row.
    if (!claimed.has(baseSku)) {
      const found = existing.get(baseSku);
      if (found !== undefined) {
        claimed.add(baseSku);
        const fields: WallpaperPlanUpdate['fields'] = {};
        if (found.price !== row.priceRetail) fields.price = row.priceRetail;
        if (found.stockQuantity !== row.qty) fields.stock_quantity = row.qty;
        if (fields.price === undefined && fields.stock_quantity === undefined) {
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
      name: row.name,
      price: row.priceRetail,
      stockQuantity: row.qty,
      availability: row.qty > 0 ? 'in_stock' : 'out_of_stock',
      isActive: false,
    });
  }

  // Positions that left the feed: report them for the OOS write until the
  // stock actually reached 0; already-reconciled ones are plain noops.
  for (const [sku, product] of existing) {
    if (!sku.startsWith(WALLPAPER_SKU_PREFIX)) continue; // defensive: pre-filtered upstream
    if (claimed.has(sku)) continue;
    if (product.stockQuantity !== 0) missing.push({ id: product.id });
    else noops.push(sku);
  }

  return { creates, updates, missing, noops, conflicts };
}
