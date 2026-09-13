//
// /oboi mirror listing restricted to the wc-* sku domain.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { WALLPAPER_BASE_SPEC_NAME } from '../wallpapers/filters.ts';
import { CATALOG_CARD_SELECT, ELIGIBLE_COUNT_SELECT, normalizeCatalogCard, supabase, WALLPAPER_SKU_LIKE } from './shared.ts';
import type { CatalogCardProduct, SearchCardRow } from './shared.ts';
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE } from './filters.ts';
import type { CatalogFilters } from './filters.ts';

// ---------------------------------------------------------------------------
// /oboi — wallpapers storefront (owner task 2026-09-10).
//
// The mirror listing of fetchCatalogProducts restricted to the wc-* domain:
// same eligibility join (ELIGIBLE_COUNT_SELECT head-count + CATALOG_CARD_SELECT
// data projection with product_images!inner), same sort contracts (explicit
// sorts + id tiebreaker, in-stock-first default), same page clamp. v1 has no
// search and no category filter on /oboi (subcategory navigation lives in the
// page chips that link to /catalog?category=shpaleri-*), so the ranked-search
// path has no counterpart here and the wallpaper view needs no junction
// filter — the sku prefix alone IS the domain filter. Since 2026-09-11 the
// owner-requested ?base= spec filter narrows BOTH queries with a jsonb
// contains on products.specifications (see the function body).
// Deliberately NOT wrapped in unstable_cache: user-controlled `page` would
// multiply cache entries; the /oboi route bounds the read like the catalog.
// ---------------------------------------------------------------------------

export interface WallpaperPage {
  products: CatalogCardProduct[];
  total: number;
  page: number;
  size: number;
}

export async function fetchWallpaperProducts(
  filters: Pick<CatalogFilters, 'sort' | 'page' | 'size'> & {
    /** Exact «Основа» spec value (dictionary: app/lib/wallpapers/filters.ts). */
    base?: string;
  } = {}
): Promise<WallpaperPage> {
  const size = Math.min(
    Math.max(filters.size ?? CATALOG_PAGE_SIZE, 1),
    CATALOG_MAX_PAGE_SIZE
  );
  // Spec filter (owner task 2026-09-11): jsonb contains with an EXACT
  // element ({name:'Основа', value:…}) — applied to BOTH the count and the
  // data query below so the pagination totals always match the visible grid.
  // «Приміщення» stays deferred: its comma-joined values cannot substring-
  // match a jsonb contains (see app/lib/wallpapers/filters.ts).
  const base = filters.base?.trim() || undefined;

  // ---- total count (identical filters, no pagination) ----
  let countQuery = supabase
    .from('products')
    .select(ELIGIBLE_COUNT_SELECT, { count: 'exact', head: true })
    .eq('is_active', true)
    .like('sku', WALLPAPER_SKU_LIKE);
  if (base) {
    // JSON.stringify: supabase-js would mangle object ELEMENTS passed as a
    // JS array (cs.{[object Object]}); the wire form must be the jsonb array
    // containment cs.[{"name":…,"value":…}].
    countQuery = countQuery.contains(
      'specifications',
      JSON.stringify([{ name: WALLPAPER_BASE_SPEC_NAME, value: base }])
    );
  }
  const { count, error: countError } = await countQuery;
  if (countError) {
    throw new Error(`Failed to count wallpaper products: ${countError.message}`);
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(filters.page ?? 1, 1), maxPage);

  // ---- paged data query ----
  let query = supabase
    .from('products')
    .select(CATALOG_CARD_SELECT)
    .eq('is_active', true)
    .like('sku', WALLPAPER_SKU_LIKE);
  if (base) {
    query = query.contains(
      'specifications',
      JSON.stringify([{ name: WALLPAPER_BASE_SPEC_NAME, value: base }])
    );
  }

  // Same sort switch as fetchCatalogProducts: every branch keeps the `id`
  // tiebreaker (bulk-imported wc-* rows share created_at), and the default
  // branch is the in-stock-first contract.
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
      query = query
        .order('availability_status', { ascending: true })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });
  }

  query = query.range((page - 1) * size, page * size - 1);

  const { data, error } = await query.returns<SearchCardRow[]>();
  if (error) {
    throw new Error(`Failed to load wallpaper products: ${error.message}`);
  }

  return {
    products: (data ?? []).map(normalizeCatalogCard),
    total,
    page,
    size,
  };
}
