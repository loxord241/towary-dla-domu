//
// /catalog listing: filters → count + paged data queries, wallpaper-domain
// decision, zero-result typo/fuzzy fallback and relevance ranking.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { collectSubtreeIds } from '../category-tree.ts';
import { CATALOG_CARD_SELECT, ELIGIBLE_COUNT_SELECT, JUNCTION_COUNT_SELECT, normalizeCatalogCard, supabase, WALLPAPER_CATEGORY_SLUGS, WALLPAPER_SKU_LIKE } from './shared.ts';
import type { CatalogCardProduct, Category, SearchCardRow } from './shared.ts';
import { buildFuzzyFallbackPlan, buildSearchConditions, identifyAppliedSearch, rankSearchResults, relaxSearchTerm, SEARCH_RANK_SCAN_LIMIT } from './search.ts';
import type { FuzzyFallbackPlan } from './search.ts';
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE } from './filters.ts';
import type { CatalogFilters } from './filters.ts';
import { findBrandIdBySlug, findCategoryIdBySlug } from './slug-lookup.ts';
import { fetchActiveCategories } from './categories.ts';

export interface CatalogPage {
  products: CatalogCardProduct[];
  total: number;
  page: number;
  size: number;
  /**
   * Set ONLY when the zero-result typo fallback rewrote the search term
   * (e.g. user typed «блендерр», we searched «блендер» instead).
   * Null/undefined means results come from the user's original query.
   */
  appliedSearch?: string | null;
}

/**
 * Paginated variant used by /catalog. Same filtering as above; returns the
 * total matching count so the UI can render real pagination. Out-of-range
 * pages are clamped to the last valid one.
 */
export async function fetchCatalogProducts(
  filters: CatalogFilters = {}
): Promise<CatalogPage> {
  const size = Math.min(
    Math.max(filters.size ?? CATALOG_PAGE_SIZE, 1),
    CATALOG_MAX_PAGE_SIZE
  );

  // ---- shared filter inputs (computed once, reused by both queries) ----
  // One `or` expression per token; the caller chains .or() per item so the
  // tokens AND together (word-order-independent search, see the helper).
  let searchConditions = buildSearchConditions(filters.search ?? '');
  // Search term actually applied. Null while the user's own query is in
  // effect; set to the relaxed term when the zero-result typo fallback
  // (below) rewrites it — the UI shows «Показані результати для ...».
  let appliedSearch: string | null = null;

  const [categoryId, brandId] = await Promise.all([
    filters.categorySlug ? findCategoryIdBySlug(filters.categorySlug) : null,
    filters.brandSlug ? findBrandIdBySlug(filters.brandSlug) : null,
  ]);

  // Unknown category/brand slug → nothing can match; skip the queries.
  if ((filters.categorySlug && categoryId === null) ||
      (filters.brandSlug && brandId === null)) {
    return { products: [], total: 0, page: 1, size };
  }

  // Multi-category model (2026-08-26): products match a category through
  // product_categories DIRECT assignments; selecting any parent pulls in
  // every descendant via in-memory subtree expansion over the already
  // fetched active list (one dictionary read per catalog page, no N+1).
  // The legacy products.category_id holds only the default assignment, so
  // filtering by it would miss multi-assigned products.
  let subtreeIds: string[] = [];
  let activeCategories: Category[] = [];
  if (categoryId) {
    activeCategories = await fetchActiveCategories();
    subtreeIds = Array.from(collectSubtreeIds(activeCategories, categoryId));
  }

  // Wallpaper separation (owner task 2026-09-10, see WALLPAPER_SKU_PREFIX):
  // a category view scoped to the wallpaper subtree (shpaleri-*) keeps its
  // wc-* products — /oboi's subcategory chips link to these views — while
  // every GENERAL listing (bare catalog, brand views, filters) excludes
  // them. SEARCH keeps them too (owner bug report 2026-09-11: «шпалери»
  // yielded zero hits because wallpapers were hidden from the search view):
  // the header search box is a cross-domain surface, and wallpaper names
  // («...шпалери,53см*10м») are exactly what such queries must find.
  const hasSearch = (filters.search ?? '').trim() !== '';
  const isWallpaperView =
    categoryId !== null &&
    activeCategories.some(
      (category) =>
        WALLPAPER_CATEGORY_SLUGS.has(category.slug) &&
        subtreeIds.includes(category.id)
    );
  const hideWallpapers = !isWallpaperView && !hasSearch;

  // ---- total count with identical filters (no pagination) ----
  // The eligibility join MUST mirror PRODUCT_SELECT, otherwise totals
  // would count imageless products that the data query can never return.
  // Built via a factory so the typo fallback can rebuild the SAME count
  // query with RELAXED conditions (replacing, not adding to, the original
  // search terms) without duplicating filter wiring.
  const buildCountQuery = (conditions: string[] | null) => {
    let q = supabase
      .from('products')
      .select(categoryId ? JUNCTION_COUNT_SELECT : ELIGIBLE_COUNT_SELECT, {
        count: 'exact',
        head: true,
      })
      .eq('is_active', true);

    // General listings hide the wallpaper domain (owner task 2026-09-10);
    // wallpaper-scoped category views and search keep it (see hideWallpapers).
    if (hideWallpapers) {
      q = q.not('sku', 'like', WALLPAPER_SKU_LIKE);
    }

    if (categoryId) {
      q = q.in('pc.category_id', subtreeIds);
    }
    if (brandId) {
      q = q.eq('brand_id', brandId);
    }

    if (conditions) {
      for (const condition of conditions) {
        q = q.or(condition);
      }
    }

    if (filters.minPrice !== undefined) {
      q = q.gte('price', filters.minPrice);
    }
    if (filters.maxPrice !== undefined) {
      q = q.lte('price', filters.maxPrice);
    }
    if (filters.inStockOnly) {
      q = q.eq('availability_status', 'in_stock');
    }
    return q;
  };

  const { count, error: countError } = await buildCountQuery(searchConditions);
  if (countError) {
    // Same honesty contract as the data query below: a transient count
    // failure must reach app/error.tsx, not render an empty catalog that
    // reads as "the shop has no products".
    throw new Error(`Failed to count catalog products: ${countError.message}`);
  }

  let total = count ?? 0;

  // ---- typo fallback (Task #40): only when the ORIGINAL query matched zero
  // rows. Progressively drop the LAST character of ONE token (longest first)
  // until a non-zero count appears or the retry budget / min-length floor is
  // hit. Same ILIKE grammar, same sanitized tokens — no new operators, no new
  // API. A fallback hit records `appliedSearch` so the UI can tell the user
  // which term actually produced the results.
  if (total === 0 && searchConditions) {
    for (const relaxedTerm of relaxSearchTerm(filters.search ?? '')) {
      const relaxedConditions = buildSearchConditions(relaxedTerm);
      if (!relaxedConditions) continue;

      // The retry REPLACES the original search conditions entirely —
      // chaining them on top would keep the unmatched term in the AND
      // tree and pin the count to zero forever.
      const { count: retryCount, error: retryError } =
        await buildCountQuery(relaxedConditions);
      if (retryError) {
        console.error(
          'Failed to count catalog products (fallback):',
          retryError.message
        );
        break;
      }
      if ((retryCount ?? 0) > 0) {
        total = retryCount ?? 0;
        searchConditions = relaxedConditions;
        appliedSearch = relaxedTerm;
        break;
      }
    }
  }

  // ---- fuzzy fallback (Phase 1): ONE batched probe, only when the trim
  // ladder ALSO matched zero rows. The probe REPLACES the search conditions
  // for both the count and the data query (same contract as the trim
  // ladder); `appliedSearch` is identified from the fetched rows further
  // below, so no per-variant retry requests exist at all.
  let fuzzyPlan: FuzzyFallbackPlan | null = null;
  if (total === 0 && searchConditions) {
    const plan = buildFuzzyFallbackPlan(filters.search ?? '');
    if (plan) {
      const { count: probeCount, error: probeError } =
        await buildCountQuery(plan.conditions);
      if (probeError) {
        console.error(
          'Failed to count catalog products (fuzzy probe):',
          probeError.message
        );
      } else if ((probeCount ?? 0) > 0) {
        total = probeCount ?? 0;
        searchConditions = plan.conditions;
        fuzzyPlan = plan;
      }
    }
  }

  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(filters.page ?? 1, 1), maxPage);

  // ---- paged data query ----
  // Relevance ranking (2026-09 audit): with an active search and the default
  // «нові» sort (undefined or 'newest' — the sort switch's default branch),
  // matched rows are ranked by match quality instead of raw recency — the
  // newest import is not automatically the best answer. An
  // explicitly chosen sort (price/name) keeps its SQL ordering: the user
  // overrode the default on purpose. The ranked path fetches up to
  // SEARCH_RANK_SCAN_LIMIT rows in one request, ranks them and slices the
  // page in JS; broader searches keep server-side pagination with the plain
  // SQL ordering.
  const rankedSearch =
    searchConditions !== null &&
    (filters.sort === undefined || filters.sort === 'newest') &&
    total <= SEARCH_RANK_SCAN_LIMIT;

  let query = supabase
    .from('products')
    .select(
      (rankedSearch
        ? CATALOG_CARD_SELECT +
          ', short_description, description, sku, yugcontract_id, created_at'
        : CATALOG_CARD_SELECT) +
        (categoryId ? ', pc:product_categories!inner(category_id)' : '')
    )
    .eq('is_active', true);

  // Same wallpaper decision as the count query — total and the grid must
  // never disagree (owner task 2026-09-10).
  if (hideWallpapers) {
    query = query.not('sku', 'like', WALLPAPER_SKU_LIKE);
  }

  if (categoryId) {
    // PostgREST dedups the top-level entities of this one-to-many inner
    // join (same verified behavior as the images!inner eligibility join).
    query = query.in('pc.category_id', subtreeIds);
  }
  if (brandId) {
    query = query.eq('brand_id', brandId);
  }

  if (searchConditions) {
    for (const condition of searchConditions) {
      query = query.or(condition);
    }
  }

  if (filters.minPrice !== undefined) {
    query = query.gte('price', filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    query = query.lte('price', filters.maxPrice);
  }
  if (filters.inStockOnly) {
    query = query.eq('availability_status', 'in_stock');
  }

  // Every sort gets `id` as a deterministic tiebreaker: imported rows share
  // created_at timestamps in bulk, and without a unique secondary key
  // Postgres may return ties in different orders per request, which makes
  // pagination overlap. The ranked search path uses the same recency pair as
  // its deterministic BASE order — relevance ties fall back to it in JS.
  if (rankedSearch) {
    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, SEARCH_RANK_SCAN_LIMIT - 1);
  } else {
    switch (filters.sort) {
      case 'price_asc':
        query = query.order('price', { ascending: true }).order('id', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('price', { ascending: false }).order('id', { ascending: false });
        break;
      case 'name_asc':
        query = query.order('name', { ascending: true }).order('id', { ascending: true });
        break;
      default:
        // In-stock first (2026-09 UX audit): the storefront's default view
        // must not open on a wall of out-of-stock novelties. The DB only
        // holds 'in_stock'/'out_of_stock' (verified 2026-09), and
        // 'in_stock' < 'out_of_stock' lexicographically, so ascending
        // availability_status IS the in-stock-first contract; each tier
        // keeps the recency ordering.
        query = query
          .order('availability_status', { ascending: true })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });
    }

    query = query.range((page - 1) * size, page * size - 1);
  }

  const { data, error } = await query.returns<SearchCardRow[]>();

  if (error) {
    // A data error must reach app/error.tsx (honest failure) — an empty
    // catalog page would read as "the shop has no products".
    throw new Error(`Failed to load catalog products: ${error.message}`);
  }

  const rows = data ?? [];
  // Fuzzy probe adoption: derive the human-facing appliedSearch from the
  // rows actually returned, BEFORE ranking — the ranked path scores against
  // the adopted term (appliedSearch ?? original), same contract as the trim
  // ladder. The probe CONDITIONS (not the identified term) remain the
  // count/data filter set, so total and pagination never diverge.
  if (fuzzyPlan) {
    appliedSearch = identifyAppliedSearch(rows, fuzzyPlan);
  }
  // Ranked path: rank the full scanned match set (total ≤ cap ⇒ the scan is
  // complete) and slice the requested page in JS. Ties resolve to the same
  // created_at/id order the SQL base ordering produced, so page windows are
  // identical to the un-ranked layout whenever scores tie.
  const products = (
    rankedSearch
      ? rankSearchResults(rows, appliedSearch ?? filters.search ?? '').slice(
          (page - 1) * size,
          page * size
        )
      : rows
  ).map(normalizeCatalogCard);

  return {
    products,
    total,
    page,
    size,
    appliedSearch,
  };
}
