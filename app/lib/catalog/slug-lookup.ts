//
// Slug → UUID/display-name lookups for catalog filters (React cache()
// over a 60s Data Cache).
//

import { cache } from 'react';
import { cachePublicRead, CATALOG_PUBLIC_READ_TTL_SECONDS, supabase } from './shared.ts';

/**
 * Resolve a category/brand slug to its UUID. Catalog filters target plain
 * FK columns (category_id/brand_id) instead of PostgREST embedded-resource
 * filters: embed filters require the embed in `select`, and without
 * `!inner` they degrade to left-join semantics that keep non-matching
 * rows (verified against the live database 2026-08). Returns null when
 * the slug does not exist.
 *
 * Perf audit Step 3 (2026-08-28): the slug lookups are React `cache()`d —
 * generateMetadata and the page render resolve the SAME slug through ONE
 * request per render instead of duplicated reads (per-request memo only;
 * nothing is cached across requests).
 * Caching step 2 (2026-08-31): wrapped in unstable_cache (60s) UNDER the
 * React cache() — cross-request Data Cache for hot slug lookups.
 */
const fetchCategoryBySlugStore = cachePublicRead(
  'catalog:category-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchCategoryBySlugUncached
);
export const lookupCategoryBySlugCached = cache(fetchCategoryBySlugStore);
const fetchBrandBySlugStore = cachePublicRead(
  'catalog:brand-slug',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchBrandBySlugUncached
);
export const lookupBrandBySlugCached = cache(fetchBrandBySlugStore);

export async function findCategoryIdBySlug(slug: string): Promise<string | null> {
  return (await lookupCategoryBySlugCached(slug))?.id ?? null;
}

export async function findBrandIdBySlug(slug: string): Promise<string | null> {
  return (await lookupBrandBySlugCached(slug))?.id ?? null;
}

/**
 * Light slug → display-name lookups for UI chrome (filter chips, H1,
 * generateMetadata). Single indexed selects; return null for unknown or
 * inactive slugs.
 */
async function fetchCategoryBySlugUncached(
  slug: string
): Promise<{ id: string; name: string; slug: string } | null> {
  const { data } = await supabase
    .from('categories')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data ?? null;
}

async function fetchBrandBySlugUncached(
  slug: string
): Promise<{ id: string; name: string; slug: string } | null> {
  const { data } = await supabase
    .from('brands')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data ?? null;
}

export const fetchCategoryBySlug = lookupCategoryBySlugCached;
export const fetchBrandBySlug = lookupBrandBySlugCached;
