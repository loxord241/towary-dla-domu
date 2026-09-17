//
// «Схожі товари»: category → brand → newest bounded stages + PURE merge.
//

// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { collectSubtreeIds } from '../category-tree.ts';
import { cachePublicRead, CATALOG_CARD_SELECT, CATALOG_PUBLIC_READ_TTL_SECONDS, LINOLEUM_SKU_LIKE, LINOLEUM_SKU_PREFIX, normalizeCatalogCard, supabase, WALLPAPER_SKU_LIKE, WALLPAPER_SKU_PREFIX } from './shared.ts';
import type { CatalogCardProduct, CatalogCardRow, Product } from './shared.ts';
import { fetchActiveCategories } from './categories.ts';

// ---------------------------------------------------------------------------
// «Схожі товари» (related products) — read-only discovery shelf for the
// product page. Up to THREE bounded reads (one window ≤limit each), merged
// by the PURE collectRelated: same category first, then same brand, then
// newest. Eligibility mirrors the storefront exactly (the product_images!inner
// join ⇒ is_active + ≥1 photo — identical in PRODUCT_SELECT and the card
// projection); the current product is excluded in SQL. No RPC, no new tables
// (spec A 2026-08-26). Egress fix (2026-09-08): the stages select
// CATALOG_CARD_SELECT (~2.3 KB/product) instead of PRODUCT_SELECT
// (~9.8 KB/product) — ProductCard reads only card fields.
// ---------------------------------------------------------------------------

/** Hard cap for «Схожі товари» — bounded by design. */
export const RELATED_LIMIT = 8;

/**
 * PURE merge of pre-fetched candidate groups into the final related list.
 * Group order IS the priority; within a group the DB already returned
 * created_at desc → id desc. Dedupes by id, skips currentId, caps at `cap`.
 */
export function collectRelated(
  groups: CatalogCardProduct[][],
  currentId: string,
  cap: number = RELATED_LIMIT
): CatalogCardProduct[] {
  const seen = new Set<string>([currentId]);
  const collected: CatalogCardProduct[] = [];
  for (const group of groups) {
    for (const row of group) {
      if (collected.length >= cap) return collected;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      collected.push(row);
    }
  }
  return collected;
}

type RelatedStageFilter =
  | { kind: 'brand'; id: string }
  | { kind: 'category'; subtreeIds: string[] }
  | null;

/** Related-products sku domain (owner task 2026-09-10): a wc-* PDP gets its
    related from the wallpaper domain only, any other PDP gets none of it.
    Linoleum (owner plan 2026-09-17): ln-* PDPs relate within ln-*, general
    PDPs see neither domain. */
type RelatedSkuDomain = 'wallpaper' | 'linoleum' | 'general';

async function fetchRelatedStage(
  filter: RelatedStageFilter,
  currentId: string,
  limit: number,
  skuDomain: RelatedSkuDomain
): Promise<CatalogCardProduct[]> {
  // Card projection only (egress fix 2026-09-08): the shelf renders
  // ProductCard, which reads nothing beyond CATALOG_CARD_SELECT, and the
  // product_images!inner eligibility join is identical to the one on the
  // full-row projection (~2.3 KB vs ~9.8 KB per product). The select string
  // is computed up front and .select() is called exactly once (same
  // single-select shape as fetchCatalogProducts — a second .select()
  // replaces the param at runtime but no longer type-checks against the
  // typed card projection).
  let query = supabase
    .from('products')
    .select(
      CATALOG_CARD_SELECT +
        (filter?.kind === 'category'
          ? ', pc:product_categories!inner(category_id)'
          : '')
    )
    .eq('is_active', true)
    .neq('id', currentId);
  // Sku-domain separation: every stage stays inside the current product's
  // sku domain (wallpaper PDPs see wc-* candidates, linoleum PDPs see ln-*,
  // the rest never sees either). postgrest-js appends both not-like params;
  // PostgREST ANDs repeated same-key filters.
  query =
    skuDomain === 'wallpaper'
      ? query.like('sku', WALLPAPER_SKU_LIKE)
      : skuDomain === 'linoleum'
        ? query.like('sku', LINOLEUM_SKU_LIKE)
        : query
            .not('sku', 'like', WALLPAPER_SKU_LIKE)
            .not('sku', 'like', LINOLEUM_SKU_LIKE);
  if (filter?.kind === 'category') {
    // Same junction + subtree semantics as fetchCatalogProducts. The count
    // embed uses product_id (see JUNCTION_COUNT_SELECT note).
    query = query.in('pc.category_id', filter.subtreeIds);
  } else if (filter?.kind === 'brand') {
    query = query.eq('brand_id', filter.id);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, limit - 1)
    .returns<CatalogCardRow[]>();
  if (error) {
    throw new Error(`Failed to load related products: ${error.message}`);
  }
  return (data ?? []).map(normalizeCatalogCard);
}

export async function fetchRelatedProducts(
  product: Pick<Product, 'id' | 'category_id' | 'brand_id' | 'sku'>,
  limit: number = RELATED_LIMIT
): Promise<CatalogCardProduct[]> {
  return fetchRelatedProductsStore(
    // Key-shaping: only the fields that determine the result go into the
    // unstable_cache invocation key (JSON.stringify(args)) — a full Product
    // (with description HTML) would bloat every key. sku decides the related
    // domain (wc-* vs the rest) — see fetchRelatedStage.
    {
      id: product.id,
      category_id: product.category_id,
      brand_id: product.brand_id,
      sku: product.sku,
    },
    limit
  );
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by the product identity
 * triple + limit; one entry per product (bounded by the catalog size).
 */
const fetchRelatedProductsStore = cachePublicRead(
  'catalog:related',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (
    identity: Pick<Product, 'id' | 'category_id' | 'brand_id' | 'sku'>,
    limit: number
  ): Promise<CatalogCardProduct[]> => {
    // Wallpapers relate to wallpapers, linoleum to linoleum, the rest to
    // the rest (owner task 2026-09-10; linoleum — owner plan 2026-09-17):
    // one sku-domain guard shared by all three stages.
    const sku = (identity.sku ?? '').toLowerCase();
    const skuDomain: RelatedSkuDomain = sku.startsWith(WALLPAPER_SKU_PREFIX)
      ? 'wallpaper'
      : sku.startsWith(LINOLEUM_SKU_PREFIX)
        ? 'linoleum'
        : 'general';
    const sameCategoryStage = identity.category_id
      ? fetchActiveCategories().then((activeCategories) =>
          fetchRelatedStage(
            {
              kind: 'category',
              subtreeIds: Array.from(collectSubtreeIds(activeCategories, identity.category_id!)),
            },
            identity.id,
            limit,
            skuDomain
          )
        )
      : Promise.resolve<CatalogCardProduct[]>([]);
    const [sameCategory, sameBrand, newest] = await Promise.all([
      sameCategoryStage,
      identity.brand_id
        ? fetchRelatedStage({ kind: 'brand', id: identity.brand_id }, identity.id, limit, skuDomain)
        : Promise.resolve<CatalogCardProduct[]>([]),
      fetchRelatedStage(null, identity.id, limit, skuDomain),
    ]);
    return collectRelated([sameCategory, sameBrand, newest], identity.id, limit);
  }
);
