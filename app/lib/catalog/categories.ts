//
// Active category/brand dictionaries (dictionary-TTL Data Cache).
//

import { cache } from 'react';
import { cachePublicRead, CATALOG_DICTIONARY_TTL_SECONDS, supabase } from './shared.ts';
import type { Brand, Category } from './shared.ts';

/**
 * Active categories — React `cache()`d per request (perf audit Step 3):
 * the catalog page, the category-subtree expansion inside
 * fetchCatalogProducts and the related-products leg all need the SAME
 * dictionary read; within one render it now executes once.
 * Caching step 2 (2026-08-31): unstable_cache (120s) UNDER the React
 * cache() — one Data Cache entry shared across requests.
 */
export async function fetchActiveCategories(): Promise<Category[]> {
  return fetchActiveCategoriesCached();
}

export const fetchActiveCategoriesStore = cachePublicRead(
  'catalog:categories',
  CATALOG_DICTIONARY_TTL_SECONDS,
  async (): Promise<Category[]> => {
    const { data, error } = await supabase
      .from('categories')
      // Explicit projection (egress audit №2, 2026-09-08, owner GO): the
      // dictionary is read on every catalog/PDP/drawer render, and `*`
      // dragged along `description`/`image` (~2-3 GB/ Month at live traffic)
      // that no storefront consumer reads — admin's categories API keeps its
      // own full SELECT. `updated_at` stays: app/sitemap.ts uses it as
      // lastModified. Field list mirrors the Category type minus
      // description/image, so the type stays truthful.
      .select(
        'id, parent_id, name, slug, sort_order, is_active, created_at, updated_at'
      )
      .eq('is_active', true)
      // Commercial order is sort_order alone; the deterministic id fallback
      // keeps ties stable. No row-timestamp tiebreak here: the uk-name
      // fallback for display lives in compareCategories.
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .returns<Category[]>();

    if (error) {
      throw new Error(`Failed to load categories: ${error.message}`);
    }

    return data ?? [];
  }
);

const fetchActiveCategoriesCached = cache(fetchActiveCategoriesStore);

/**
 * Active brands — same caching contract as fetchActiveCategories.
 */
export async function fetchActiveBrands(): Promise<Brand[]> {
  return fetchActiveBrandsCached();
}

const fetchActiveBrandsStore = cachePublicRead(
  'catalog:brands',
  CATALOG_DICTIONARY_TTL_SECONDS,
  async (): Promise<Brand[]> => {
    const { data, error } = await supabase
      .from('brands')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true })
      .returns<Brand[]>();

    if (error) {
      throw new Error(`Failed to load brands: ${error.message}`);
    }

    return data ?? [];
  }
);

const fetchActiveBrandsCached = cache(fetchActiveBrandsStore);
