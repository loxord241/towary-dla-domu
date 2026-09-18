/**
 * Product-domain vocabulary — the SINGLE source of truth for the product
 * domains: «шпалери vs техніка» (owner task 2026-09-13, audit follow-up
 * 8a) plus «лінолеум» (owner plan 2026-09-17, vertical batch 1).
 *
 * Wallpaper products are exactly those whose sku/slug carries the `wc-`
 * prefix (assigned by the daily 1C wallpaper feed importer); linoleum
 * products are exactly the `ln-`-prefixed ones (roll goods, card =
 * design × width, price = грн/погонный метр); everything else is the
 * tech domain. Before this module the prefix lived in FOUR independent
 * places (catalog constants, a search-suggest literal, a private importer
 * const, and an inline startsWith in the checkout) — a new prefix or
 * domain would have needed four coordinated edits.
 *
 * Pure module: no next/server, no supabase — safe for client components
 * and node:test sandboxes.
 */

export const WALLPAPER_SKU_PREFIX = 'wc-';

/** PostgREST `like` pattern for SQL-side wallpaper exclusion. */
export const WALLPAPER_SKU_LIKE = `${WALLPAPER_SKU_PREFIX}%`;

export const LINOLEUM_SKU_PREFIX = 'ln-';

/** PostgREST `like` pattern for SQL-side linoleum exclusion. */
export const LINOLEUM_SKU_LIKE = `${LINOLEUM_SKU_PREFIX}%`;

export type ProductDomain = 'wallpaper' | 'linoleum' | 'tech';

/** Wallpapers are exactly the `wc-`-prefixed slugs (sku = slug prefix). */
export function isWallpaperSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith(WALLPAPER_SKU_PREFIX);
}

/** Linoleum is exactly the `ln-`-prefixed slugs (sku = slug prefix). */
export function isLinoleumSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith(LINOLEUM_SKU_PREFIX);
}

export function domainOfSlug(slug: string | null | undefined): ProductDomain {
  if (isWallpaperSlug(slug)) return 'wallpaper';
  if (isLinoleumSlug(slug)) return 'linoleum';
  return 'tech';
}

/** Meter products (running goods sold by running metre, e.g. linoleum `ln-*`). */
export function isMeterProduct(sku?: string | null): boolean {
  return typeof sku === 'string' && sku.startsWith(LINOLEUM_SKU_PREFIX);
}

