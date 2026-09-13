//
// «Клей для шпалер» — bounded cross-sell shelf for WALLPAPER PDPs.
// Reads the active, photo-eligible products of the glue category
// (scripts/glues-import.ts, owner 2026-09-13) as card projections.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler (repo-wide pattern).
import {
  cachePublicRead,
  CATALOG_CARD_SELECT,
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  normalizeCatalogCard,
  supabase,
} from './shared.ts';
import type { CatalogCardProduct, CatalogCardRow } from './shared.ts';
import { findCategoryIdBySlug } from './slug-lookup.ts';

/**
 * Single source of truth for the glue category slug (written by
 * scripts/glues-import.ts). Deliberately NOT in WALLPAPER_CATEGORY_SLUGS:
 * a /catalog view on this slug is a GENERAL view (wc-* stay excluded), so
 * the shelf must filter gl-* products through the junction, not the sku
 * domain.
 */
export const GLUE_CATEGORY_SLUG = 'kleyi-dlya-shpaler';

/** Hard cap — the owner's current assortment is exactly 5 SKUs. */
export const GLUE_CROSS_SELL_LIMIT = 5;

/**
 * Pure assembly step (mirrors collectRelated's shape): category id → the
 * query contract. Exported for the wire test; the run path composes it
 * with the cached id lookup below.
 */
export function buildGlueCrossSellQuery(client: typeof supabase, categoryId: string) {
  // Card projection only (egress pattern, 2026-09-08): the shelf renders
  // ProductCard, which reads nothing beyond CATALOG_CARD_SELECT. The
  // product_images!inner join is the storefront eligibility contract
  // (is_active rows only are selected by the caller). The junction embed
  // (`pc`) scopes the shelf to DIRECT glue-category assignments; its
  // disambiguation hint follows the same PGRST201-discovered constraint
  // naming as the related-products category stage.
  return client
    .from('products')
    .select(CATALOG_CARD_SELECT + ', pc:product_categories!inner(category_id)')
    .eq('is_active', true)
    .eq('pc.category_id', categoryId)
    // Catalog default-sort contract: in-stock first, then name, id as the
    // deterministic tiebreaker (same ordering the suggest dropdown uses).
    .order('availability_status', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .returns<CatalogCardRow[]>()
    .limit(GLUE_CROSS_SELL_LIMIT);
}

async function fetchGlueCrossSellUncached(): Promise<CatalogCardProduct[]> {
  const categoryId = await findCategoryIdBySlug(GLUE_CATEGORY_SLUG);
  if (!categoryId) return []; // category not imported yet → hidden block

  const { data, error } = await buildGlueCrossSellQuery(supabase, categoryId);
  if (error) {
    // Supplementary PDP content: a failed read degrades to a hidden block
    // (the caller catches — same contract as reviews/related).
    throw new Error(`glue cross-sell read failed: ${error.message}`);
  }
  return (data ?? []).map(normalizeCatalogCard);
}

/**
 * Public read for the wallpaper PDP: user-independent, 60s Data Cache under
 * the shared catalog tag (same wiring as fetchRelatedProducts). Never called
 * with user context; ISR (revalidate = 60) bounds it further.
 */
export const fetchGlueCrossSell = cachePublicRead(
  'catalog:glue-cross-sell',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchGlueCrossSellUncached
);
