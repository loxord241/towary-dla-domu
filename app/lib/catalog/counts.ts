//
// Eligible-product counts per single category/brand view (noindex +
// sitemap emptiness contract, Task #14).
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { cache } from 'react';
import { collectSubtreeIds } from '../category-tree.ts';
import { cachePublicRead, CATALOG_PUBLIC_READ_TTL_SECONDS, ELIGIBLE_COUNT_SELECT, JUNCTION_COUNT_SELECT, supabase, WALLPAPER_CATEGORY_SLUGS, WALLPAPER_SKU_LIKE } from './shared.ts';
import { lookupBrandBySlugCached, lookupCategoryBySlugCached } from './slug-lookup.ts';
import { fetchActiveCategoriesStore } from './categories.ts';

// ---------------------------------------------------------------------------
// Eligible-product counts per single category/brand view (Task #14,
// 2026-09): /catalog?category=X and /catalog?brand=Y with ZERO eligible
// products (active + ≥1 photo; category via junction + subtree expansion)
// must be noindex'd (lib/seo.ts) and stay out of the sitemap. The counts
// reuse the exact ELIGIBLE_COUNT_SELECT / JUNCTION_COUNT_SELECT shapes of
// fetchCatalogProducts, so an «empty» verdict can never disagree with the
// grid's own total. Cached like the slug lookups (900s public TTL — perf
// package 2026-09-13; importer-driven data, targeted invalidation via the
// catalog-public-reads tag) — public and
// identical for every visitor; null = slug unknown/inactive. A DB error is
// rethrown (callers degrade to «non-empty» so a transient read can never
// noindex a full page).
// ---------------------------------------------------------------------------

async function countCategoryProductsUncached(
  slug: string
): Promise<number | null> {
  const category = await lookupCategoryBySlugCached(slug);
  if (!category) return null;
  const activeCategories = await fetchActiveCategoriesStore();
  const subtreeIds = Array.from(
    collectSubtreeIds(activeCategories, category.id)
  );
  // Mirror fetchCatalogProducts' wallpaper decision exactly (owner task
  // 2026-09-10): wallpaper-scoped views count their wc-* rows, every other
  // category view excludes them — the empty-view verdict can never disagree
  // with the grid's own total (noindex contract, Task #14).
  const isWallpaperView = activeCategories.some(
    (activeCategory) =>
      WALLPAPER_CATEGORY_SLUGS.has(activeCategory.slug) &&
      subtreeIds.includes(activeCategory.id)
  );
  let countQuery = supabase
    .from('products')
    .select(JUNCTION_COUNT_SELECT, { count: 'exact', head: true })
    .eq('is_active', true)
    .in('pc.category_id', subtreeIds);
  if (!isWallpaperView) {
    countQuery = countQuery.not('sku', 'like', WALLPAPER_SKU_LIKE);
  }
  const { count, error } = await countQuery;
  if (error) {
    throw new Error(
      `Failed to count eligible products for category "${slug}": ${error.message}`
    );
  }
  return count ?? 0;
}

const countCategoryProductsStore = cachePublicRead(
  'catalog:category-product-count',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  countCategoryProductsUncached
);

/** React cache() on top of the 900s Data Cache: one execution per request. */
export const fetchCategoryProductCount = cache(countCategoryProductsStore);

async function countBrandProductsUncached(
  slug: string
): Promise<number | null> {
  const brand = await lookupBrandBySlugCached(slug);
  if (!brand) return null;
  const { count, error } = await supabase
    .from('products')
    .select(ELIGIBLE_COUNT_SELECT, { count: 'exact', head: true })
    .eq('is_active', true)
    // Brand views are general listings: wallpapers (wc-*) excluded, same as
    // the grid (owner task 2026-09-10).
    .not('sku', 'like', WALLPAPER_SKU_LIKE)
    .eq('brand_id', brand.id);
  if (error) {
    throw new Error(
      `Failed to count eligible products for brand "${slug}": ${error.message}`
    );
  }
  return count ?? 0;
}

const countBrandProductsStore = cachePublicRead(
  'catalog:brand-product-count',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  countBrandProductsUncached
);

export const fetchBrandProductCount = cache(countBrandProductsStore);
