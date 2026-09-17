//
// /linoleum mirror listing restricted to the ln-* sku domain (linoleum
// vertical, batch 2, task L4, 2026-09-17). Clone of wallpaper-listing.ts.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { WIDTH_SPEC_NAME, formatWidthM } from '../linoleum/import-plan.ts';
import type { LinoleumWidthM } from '../linoleum/parse.ts';
import { CATALOG_CARD_SELECT, normalizeCatalogCard, supabase, LINOLEUM_SKU_LIKE } from './shared.ts';
import type { CatalogCardProduct, SearchCardRow } from './shared.ts';
import { CATALOG_MAX_PAGE_SIZE, CATALOG_PAGE_SIZE } from './filters.ts';
import type { CatalogFilters } from './filters.ts';

// ---------------------------------------------------------------------------
// /linoleum — linoleum storefront (owner plan 2026-09-17, batch 2).
//
// The mirror listing of fetchWallpaperProducts restricted to the ln-* domain:
// same eligibility join (product_images!inner inside CATALOG_CARD_SELECT),
// same sort contracts (explicit sorts + id tiebreaker, in-stock-first
// default), same single merged count+data request and same page clamp with
// the one-shot replay (see wallpaper-listing.ts for the full rationale).
//
// Width filter (KEY contract): a card IS a design × width pair, and the
// importer writes the width as a specification entry with the value in UK
// comma format — {name:'Ширина', value: formatWidthM(w)} → '1,5'|'2'|'2,5'|
// '3'|'4' (app/lib/linoleum/import-plan.ts, single canon for the product
// name AND the spec). The query therefore builds its jsonb contains literal
// THROUGH formatWidthM — any other spelling ('1.5') would silently miss
// every stored row.
//
// Deliberately NOT wrapped in unstable_cache: user-controlled `page` would
// multiply cache entries; the /linoleum route bounds the read like /oboi.
// ---------------------------------------------------------------------------

export interface LinoleumPage {
  products: CatalogCardProduct[];
  total: number;
  page: number;
  size: number;
}

export async function fetchLinoleumProducts(
  filters: Pick<CatalogFilters, 'sort' | 'page' | 'size'> & {
    /** Roll width (dictionary: app/lib/linoleum/parse.ts LINOLEUM_WIDTHS_M). */
    width?: LinoleumWidthM;
  } = {}
): Promise<LinoleumPage> {
  const size = Math.min(
    Math.max(filters.size ?? CATALOG_PAGE_SIZE, 1),
    CATALOG_MAX_PAGE_SIZE
  );
  const width = filters.width;

  // ---- merged count+data query (single PostgREST round-trip) ----
  const buildPagedQuery = (page: number) => {
    let query = supabase
      .from('products')
      .select(CATALOG_CARD_SELECT, { count: 'exact' })
      .eq('is_active', true)
      .like('sku', LINOLEUM_SKU_LIKE);
    if (width !== undefined) {
      // JSON.stringify: supabase-js would mangle object ELEMENTS passed as a
      // JS array (cs.{[object Object]}); the wire form must be the jsonb
      // array containment cs.[{"name":"Ширина","value":"<uk width>"}] —
      // formatWidthM is THE canon the importer writes.
      query = query.contains(
        'specifications',
        JSON.stringify([{ name: WIDTH_SPEC_NAME, value: formatWidthM(width) }])
      );
    }

    // Same sort switch as fetchWallpaperProducts: every branch keeps the `id`
    // tiebreaker, and the default branch is the in-stock-first contract.
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
    throw new Error(`Failed to load linoleum products: ${error.message}`);
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(requestedPage, maxPage);
  let rows = data ?? [];

  if (rows.length === 0 && total > 0 && page !== requestedPage) {
    // Out-of-range ?page: replay ONCE on the clamped page (same contract as
    // the wallpaper listing).
    const retry = await buildPagedQuery(page).returns<SearchCardRow[]>();
    if (retry.error) {
      throw new Error(`Failed to load linoleum products: ${retry.error.message}`);
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
