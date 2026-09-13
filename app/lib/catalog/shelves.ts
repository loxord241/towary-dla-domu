//
// Home shelves: «Обрані товари» / «Популярні товари» bounded reads.
//

import { normalizeProduct, PRODUCT_SELECT, supabase, WALLPAPER_SKU_LIKE } from './shared.ts';
import type { Product, ProductJoinedRow } from './shared.ts';
import { fetchProducts } from './product-feed.ts';

/**
 * Active products marked as featured for the home page.
 */
export async function fetchFeaturedProducts(): Promise<Product[]> {
  return fetchProducts({ featuredOnly: true });
}

/** Hard cap for the home «Обрані товари» shelf — bounded by design
    (mirror of the «Популярні товари» rule, MAX_FEATURED_PRODUCTS). */
export const SELECTED_LIMIT = 8;

export async function fetchSelectedProducts(): Promise<Product[]> {
  // Single bounded window (rows 0..7, partial index
  // idx_products_active_selected): the home grid renders at most two
  // 4-column rows, so admin flagging beyond 8 must not unbound the home
  // read. Deterministic order (created_at desc, id desc) — same priority
  // semantics as the popular shelf.
  //
  // In-stock first (2026-09 audit, mirrors the catalog default sort at
  // fetchCatalogProducts): with most of the catalog out of stock, the
  // recency-only order opened the home shelf on a wall of «Немає в
  // наявності». The DB only holds 'in_stock'/'out_of_stock' and
  // 'in_stock' < 'out_of_stock' lexicographically, so ascending
  // availability_status IS the in-stock-first contract; the set of shown
  // products (the admin-curated is_selected flag) is untouched — only the
  // display order changes. Recency stays the tiebreaker within each tier.
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .eq('is_selected', true)
    // Home shelves never surface the wallpaper domain (owner task
    // 2026-09-10): wc-* products render on /oboi only.
    .not('sku', 'like', WALLPAPER_SKU_LIKE)
    .order('availability_status', { ascending: true })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, SELECTED_LIMIT - 1)
    .returns<ProductJoinedRow[]>();

  if (error) {
    throw new Error(`Failed to load selected products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}

/** Hard cap for the home «Популярні товари» shelf — bounded by design. */
export const POPULAR_LIMIT = 8;

/**
 * Products for the home «Популярні товари» section — PURELY admin-curated.
 *
 * DECISION 2026-08-26 (supersedes the Stage-11 newest-arrivals fallback):
 * popularity has no real sales signal yet, and padding the shelf with
 * newest arrivals blurred who controls the block. It now shows EXACTLY the
 * active products flagged is_featured — newest first with an id tiebreaker,
 * hard-capped at 8. If an admin flags more than 8, the first 8 in this
 * deterministic order win and DATA IS NEVER CHANGED AUTOMATICALLY (the
 * max-8 business rule lives in the admin API/UI, see featured-limit.ts).
 * Zero featured ⇒ the home page skips the section entirely.
 *
 * `excludeIds` (2026-09 audit): ids ALREADY shown on the «Обрані» shelf —
 * a product flagged both is_selected and is_featured used to render on BOTH
 * home sections. The exclusion happens IN SQL: PostgREST applies the range
 * window AFTER the not-in filter, so the bounded read still returns exactly
 * `take` rows (backfilled from the next featured candidates in the same
 * deterministic order). UUIDs contain no commas, so the parenthesised
 * in-list is safe; the featured-first contract is untouched.
 */
export async function fetchPopularProducts(
  limit: number = POPULAR_LIMIT,
  excludeIds: string[] = []
): Promise<Product[]> {
  const take = Math.min(Math.max(limit, 1), POPULAR_LIMIT);

  let query = supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .eq('is_featured', true)
    // Home shelves never surface the wallpaper domain (owner task
    // 2026-09-10): wc-* products render on /oboi only. Chained BEFORE the
    // not-in/range tail so the bounded window still yields `take` rows.
    .not('sku', 'like', WALLPAPER_SKU_LIKE)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }

  // Single bounded window (rows 0..take-1 of the excluded set) — never a
  // paged scan.
  const { data, error } = await query
    .range(0, take - 1)
    .returns<ProductJoinedRow[]>();

  if (error) {
    throw new Error(`Failed to load popular products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}
