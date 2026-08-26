import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Business rule: the home «Популярні товари» shelf shows AT MOST 8 curated
 * (is_featured=true) products. The limit is deliberately enforced in the
 * admin API + UI — NOT as a database constraint (admins may exceed it
 * temporarily via SQL without breaking anything; the storefront query stays
 * bounded at 8 either way).
 */

export const MAX_FEATURED_PRODUCTS = 8;

export const FEATURED_LIMIT_MESSAGE =
  'Досягнуто ліміт: у блоці «Популярні товари» вже 8 товарів. Зніміть один з них, щоб додати інший.';

export type FeaturedDecision =
  | { allowed: true }
  | { allowed: false; reason: 'limit_reached' };

/**
 * Pure decision for a featured toggle:
 *  - switching OFF: always fine (frees a slot);
 *  - staying ON: a no-op, allowed even at capacity;
 *  - switching ON: allowed only while fewer than 8 products are featured.
 */
export function decideFeaturedToggle(input: {
  currentlyFeatured: boolean;
  requestedFeatured: boolean;
  featuredCount: number;
}): FeaturedDecision {
  if (!input.requestedFeatured) return { allowed: true };
  if (input.currentlyFeatured) return { allowed: true };
  if (input.featuredCount < MAX_FEATURED_PRODUCTS) return { allowed: true };
  return { allowed: false, reason: 'limit_reached' };
}

/**
 * Indexed head-count of featured products. Used by the admin routes for the
 * pre-check and the post-update race guard.
 */
export async function countFeaturedProducts(
  client: SupabaseClient
): Promise<number> {
  const { count, error } = await client
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('is_featured', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
