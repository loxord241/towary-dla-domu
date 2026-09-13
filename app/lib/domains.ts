/**
 * Product-domain vocabulary — the SINGLE source of truth for
 * «шпалери vs техніка» (owner task 2026-09-13, audit follow-up 8a).
 *
 * Wallpaper products are exactly those whose sku/slug carries the `wc-`
 * prefix (assigned by the daily 1C wallpaper feed importer); everything
 * else is the tech domain. Before this module the prefix lived in FOUR
 * independent places (catalog constants, a search-suggest literal, a
 * private importer const, and an inline startsWith in the checkout) —
 * a new prefix or domain would have needed four coordinated edits.
 *
 * Pure module: no next/server, no supabase — safe for client components
 * and node:test sandboxes.
 */

export const WALLPAPER_SKU_PREFIX = 'wc-';

/** PostgREST `like` pattern for SQL-side wallpaper exclusion. */
export const WALLPAPER_SKU_LIKE = `${WALLPAPER_SKU_PREFIX}%`;

export type ProductDomain = 'wallpaper' | 'tech';

/** Wallpapers are exactly the `wc-`-prefixed slugs (sku = slug prefix). */
export function isWallpaperSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.startsWith(WALLPAPER_SKU_PREFIX);
}

export function domainOfSlug(slug: string | null | undefined): ProductDomain {
  return isWallpaperSlug(slug) ? 'wallpaper' : 'tech';
}
