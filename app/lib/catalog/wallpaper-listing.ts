//
// /oboi mirror listing restricted to the wc-* sku domain.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { WALLPAPER_BASE_SPEC_NAME } from '../wallpapers/filters.ts';
import { CATALOG_CARD_SELECT, normalizeCatalogCard, supabase, WALLPAPER_SKU_LIKE } from './shared.ts';
import type { CatalogCardProduct, SearchCardRow } from './shared.ts';
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE } from './filters.ts';
import type { CatalogFilters } from './filters.ts';

// ---------------------------------------------------------------------------
// /oboi — wallpapers storefront (owner task 2026-09-10).
//
// The mirror listing of fetchCatalogProducts restricted to the wc-* domain:
// same eligibility join (product_images!inner inside CATALOG_CARD_SELECT),
// same sort contracts (explicit sorts + id tiebreaker, in-stock-first
// default), same page clamp. v1 has no search and no category filter on
// /oboi (subcategory navigation lives in the page chips that link to
// /catalog?category=shpaleri-*), so the ranked-search path has no
// counterpart here and the wallpaper view needs no junction filter — the
// sku prefix alone IS the domain filter. Since 2026-09-11 the
// owner-requested ?base= spec filter narrows the query with a jsonb
// contains on products.specifications (see the function body).
//
// SINGLE REQUEST (perf package 2026-09-13): total and the paged page are
// fetched by ONE PostgREST request — select(..., { count: 'exact' }) makes
// PostgREST return the exact total in Content-Range alongside the rows, so
// the old separate head-count request is gone (one round-trip per page
// view; PostgREST does not inflate count=exact for the images!inner join —
// verified, see shared.ts). Page clamp: without the up-front count an
// out-of-range ?page can no longer be clamped BEFORE the request, so the
// requested window is sent as-is and, when it comes back empty while total
// says a last page exists, the SAME query is replayed once on the clamped
// page — the rendered result matches the old clamp contract exactly, at
// the cost of one extra request only on out-of-range URLs.
//
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
  // element ({name:'Основа', value:…}) — the pagination total now comes
  // from the SAME request's count, so the totals always match the visible
  // grid by construction. «Приміщення» stays deferred: its comma-joined
  // values cannot substring-match a jsonb contains (see
  // app/lib/wallpapers/filters.ts).
  const base = filters.base?.trim() || undefined;

  // ---- merged count+data query (single PostgREST round-trip) ----
  const buildPagedQuery = (page: number) => {
    let query = supabase
      .from('products')
      .select(CATALOG_CARD_SELECT, { count: 'exact' })
      .eq('is_active', true)
      .like('sku', WALLPAPER_SKU_LIKE);
    if (base) {
      // JSON.stringify: supabase-js would mangle object ELEMENTS passed as a
      // JS array (cs.{[object Object]}); the wire form must be the jsonb array
      // containment cs.[{"name":…,"value":…}].
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

    return query.range((page - 1) * size, page * size - 1);
  };

  const requestedPage = Math.max(filters.page ?? 1, 1);
  const { data, count, error } = await buildPagedQuery(requestedPage).returns<
    SearchCardRow[]
  >();
  if (error) {
    throw new Error(`Failed to load wallpaper products: ${error.message}`);
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(requestedPage, maxPage);
  let rows = data ?? [];

  if (rows.length === 0 && total > 0 && page !== requestedPage) {
    // Out-of-range ?page: the requested window is past the last row.
    // Replay ONCE on the clamped page so the URL renders the same last
    // page the old pre-clamped flow rendered.
    const retry = await buildPagedQuery(page).returns<SearchCardRow[]>();
    if (retry.error) {
      throw new Error(`Failed to load wallpaper products: ${retry.error.message}`);
    }
    rows = retry.data ?? [];
  }

  return {
    products: rows.map(normalizeCatalogCard),
    total,
    page,
    size,
  };
}
