//
// Shared substrate: unstable_cache wiring, the anonymous Supabase client,
// PostgREST select constants, the wc-* domain constants, entity/row types
// and the row normalizers used across the catalog modules.
//

import { createClient } from '@supabase/supabase-js';
import { WALLPAPER_CATEGORY_MAP, WALLPAPER_ROOT } from '../wallpapers/categories.ts';
import type { SearchRankable } from './search.ts';

// unstable_cache is resolved dynamically: the bare 'next/cache' specifier
// does not resolve under plain-node ESM (no ./cache subpath in next's
// exports), and the node --test suite imports this module. Next's bundler
// resolves the primary specifier; the fallback (the implementation file,
// resolved WITH its .js extension for ESM) is only hit outside Next — i.e.
// by the cache-wiring tests. Creation of wrappers needs no request context;
// only CALLING a wrapped function does (inside a render it always exists).
type UnstableCacheFn = <TArgs extends unknown[], TResult>(
  cb: (...args: TArgs) => Promise<TResult>,
  keyParts: string[],
  options: { revalidate: number; tags: string[] }
) => (...args: TArgs) => Promise<TResult>;

const { unstable_cache } = (await import('next/cache').then(
  (m) => m as { unstable_cache: UnstableCacheFn },
  () =>
    import(
      'next/dist/server/web/spec-extension/unstable-cache.js'
    ) as Promise<{ unstable_cache: UnstableCacheFn }>
)) as { unstable_cache: UnstableCacheFn };

// ---------------------------------------------------------------------------
// Storefront public-read caching (caching step 2, audit 2026-08-31).
//
// The functions wrapped below are PUBLIC and USER-INDEPENDENT: their inputs
// are explicit arguments (no cookies/headers/searchParams), they run under
// the anonymous role, so RLS already decided their content, and their
// results are identical for every visitor. unstable_cache therefore shares
// one Data Cache entry across users safely.
//
// TTL policy: dictionaries change only via the admin UI (120s); products /
// reviews change via the 6-hour Yugcontract importer or moderation (60s).
// Post-import staleness is bounded by the TTL — invisible against the
// 6-hour import cycle. DB errors are never cached: unstable_cache writes
// the entry only after the callback resolves, so a failed read re-executes
// on the next request (degradation contracts of the product page stay).
//
// NOT cached (deliberately):
//  - fetchCatalogProducts: filter keys include user-controlled q/min/max —
//    unbounded cache cardinality (pollution/DoS vector);
//  - fetchProducts / fetchPopularProducts: the home page already bounds
//    them behind ISR (revalidate 60);
//  - everything in app/api/*, admin, checkout, orders, payments: private,
//    personalized or rate-limited surfaces.
// ---------------------------------------------------------------------------

/**
 * Dictionaries (categories/brands) change only via manual supplier syncs,
 * never organically — a 1h Data Cache TTL is safe and cuts the #2 egress
 * stream ~50x vs the original 120s (egress audit №2, 2026-09-08, owner GO).
 * Staleness contract: a category/brand created or renamed by a sync (or in
 * the admin) appears in storefront filters within at most one hour;
 * deployments reset the data cache, so a sync followed by a deploy is
 * always immediate.
 */
export const CATALOG_DICTIONARY_TTL_SECONDS = 3600;
export const CATALOG_PUBLIC_READ_TTL_SECONDS = 60;

/** Shared tag so a future importer hook can revalidateTag() targeted. */
const CATALOG_PUBLIC_CACHE_TAG = 'catalog-public-reads';

/**
 * Wrap a public, user-independent read in unstable_cache. The wrapper is
 * created lazily on first call (no request context needed for creation,
 * only for invocation). Exported for the cache-wiring tests; do not use
 * for anything user-specific.
 */
export function cachePublicRead<TArgs extends unknown[], TResult>(
  keyPrefix: string,
  revalidateSeconds: number,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  let wrapped: ((...args: TArgs) => Promise<TResult>) | null = null;
  return async (...args: TArgs): Promise<TResult> => {
    if (wrapped === null) {
      wrapped = unstable_cache(fn, [keyPrefix], {
        revalidate: revalidateSeconds,
        tags: [CATALOG_PUBLIC_CACHE_TAG],
      });
    }
    return wrapped(...args);
  };
}

export interface ProductImage {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
  created_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string;
  sku?: string | null;
  price: number;
  old_price?: number | null;
  stock_quantity: number;
  availability_status: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  category_id?: string | null;
  brand_id?: string | null;
  sku: string;
  name: string;
  slug: string;
  short_description?: string | null;
  description?: string | null;
  /** Supplier characteristics as [{name,value}] pairs (JSONB array, order preserved). */
  specifications?: { name: string; value: string }[] | null;
  price: number;
  old_price?: number | null;
  currency: string;
  stock_quantity: number;
  availability_status: string;
  is_active: boolean;
  is_featured: boolean;
  /** Admin-curated «Обрані товари» home section — independent of is_featured. */
  is_selected: boolean;
  created_at: string;
  updated_at: string;
  images: ProductImage[];
  category?: Category | null;
  brand?: Brand | null;
  variants: ProductVariant[];
}

export interface Category {
  id: string;
  parent_id?: string | null;
  name: string;
  slug: string;
  description?: string | null;
  image?: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Brand {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  logo?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Storefront reads run with the publishable key as the anonymous role,
// so visibility is decided entirely by the existing RLS policies.
// The service role key must never be used here.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

/**
 * Storefront eligibility policy (F2 UX): a product is shown only when it
 * has at least one photo. Supplier imports that lack content arrive with
 * zero product_images rows — exactly the cards that rendered
 * «Фото відсутнє» / «Опис відсутній». Absence of images is the precise,
 * durable proxy for "no imported content": it hides the 192 placeholder
 * products without hiding the ~700 normal products whose supplier simply
 * shipped no description text. When the importer later fills them, they
 * reappear automatically.
 *
 * `!inner` turns the images embed into an inner join, excluding imageless
 * products from every storefront read built on this constant (catalog,
 * search, category/brand filters, featured, direct slug → 404).
 * Verified live: PostgREST does NOT inflate count=exact for this join
 * (4131 == distinct products-with-images), and pagination stays per
 * top-level entity. Admin API keeps its own plain SELECT on purpose.
 */
// Since migration 016 there are TWO products→categories relationships
// (legacy FK + junction), so PostgREST needs a disambiguation hint. The
// hint uses the constraint name discovered live via PGRST201 (2026-08-26).
export const PRODUCT_SELECT =
  '*, category:categories!products_category_id_fkey(id, name, slug), brand:brands(*), images:product_images!inner(*), variants:product_variants(*)';

/**
 * Slim card projection for /catalog (Task #4, 2026-08-31): ONLY the fields
 * ProductCard and the catalog page actually read. description/specifications/
 * variants and the category embed are dropped — category names come from
 * fetchActiveCategories and body fields are never rendered in the grid.
 * `product_images!inner` is REQUIRED: it is the eligibility join that hides
 * imageless products (same semantics as PRODUCT_SELECT); `sort_order` drives
 * image normalization; `product_id` is required by getMainPublicImageUrl's
 * parameter type. Live-measured ~2.3 KB/product vs ~9.8 KB for PRODUCT_SELECT.
 */
export const CATALOG_CARD_SELECT =
  'id, name, slug, price, old_price, currency, availability_status, brand:brands(name), images:product_images!inner(id, product_id, image_url, is_main, sort_order)';

/** Same eligibility join for head-count queries (no row multiplication). */
// NOTE: the junction count embed selects product_id (a real column), NOT id:
// PostgREST resolves `pc.id` against the EMBEDDED table, and selecting
// `, pc:product_categories!inner(id)` made the head-count fail live with
// 42703 "column product_categories_1.id does not exist" (verified 2026-08-26).
export const ELIGIBLE_COUNT_SELECT = 'id, images:product_images!inner(id)';
export const JUNCTION_COUNT_SELECT = 'id, images:product_images!inner(id), pc:product_categories!inner(product_id)';

/**
 * Wallpaper domain separation (owner task 2026-09-10): the daily 1C wallpaper
 * feed imports products whose `sku` carries the `wc-` prefix, and the owner
 * wants wallpapers OFF the general storefront surfaces (bare /catalog, search,
 * home shelves, related of non-wallpaper products) — they live on /oboi.
 *
 * EXCEPTION (documented owner-task reading): /oboi's subcategory chips link
 * to `/catalog?category=shpaleri-*`, so a category view scoped to the
 * wallpaper subtree must KEEP rendering its products — otherwise every chip
 * would land on an empty, noindex page. Assignment domains are disjoint
 * (wallpapers are assigned only to shpaleri-* categories), so "no exclusion"
 * on those views ≡ "wallpapers only". The non-empty category counts mirror
 * this decision (countCategoryProductsUncached), which keeps the
 * «indexable set = sitemap set» invariant intact: the sitemap derives
 * shpaleri-* non-emptiness from the SAME wc-* assignments.
 *
 * Single source of truth for the slug list is the importer's category map —
 * no duplicated literals here.
 */
export const WALLPAPER_SKU_PREFIX = 'wc-';
export const WALLPAPER_SKU_LIKE = `${WALLPAPER_SKU_PREFIX}%`;

/** «Шпалери» root + every imported subgroup slug (canonical importer list). */
export const WALLPAPER_CATEGORY_SLUGS: ReadonlySet<string> = new Set([
  WALLPAPER_ROOT.slug,
  ...Object.values(WALLPAPER_CATEGORY_MAP).map((target) => target.slug),
]);

// PostgREST embeds a many-to-one relation as an object (or null when the
// FK is unset) and one-to-many relations as arrays — verified against the
// live database. This row type mirrors that raw shape exactly.
export type ProductJoinedRow = Omit<
  Product,
  'category' | 'brand' | 'images' | 'variants' | 'pc'
> & {
  category: Category | null;
  brand: Brand | null;
  images: ProductImage[] | null;
  variants: ProductVariant[] | null;
  // Junction rows joined via `pc:product_categories!inner(...)` when the
  // caller filters by category (direct assignments; parents are resolved
  // through collectSubtreeIds in memory). Stripped by normalizeProduct.
  pc?: { category_id: string }[] | null;
};

/**
 * Minimal card row returned by the /catalog projection (Task #4). NOT a
 * full Product: sku, body fields, flags and timestamps are absent at
 * runtime and must not be typed as present.
 */
export interface CatalogCardProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  old_price?: number | null;
  currency: string;
  availability_status: string;
  brand: { name: string } | null;
  images: CatalogCardImage[];
}

/** Card image row — mirrors getMainPublicImageUrl's parameter shape. */
export interface CatalogCardImage {
  id: string;
  product_id: string;
  image_url: string;
  alt?: string | null;
  sort_order?: number;
  is_main?: boolean;
}

export type CatalogCardRow = Omit<CatalogCardProduct, 'images'> & {
  images: CatalogCardImage[] | null;
  // Junction rows joined via `pc:product_categories!inner(...)` when the
  // caller filters by category. Stripped by normalizeCatalogCard.
  pc?: { category_id: string }[] | null;
};

/**
 * Row shape of the relevance-ranked data query: the card projection plus the
 * scoring fields (searchRelevanceScore reads name/short_description/sku/
 * yugcontract_id; rankSearchResults ties on created_at/id). Only fetched on
 * the ranked search path — the plain path selects CATALOG_CARD_SELECT, whose
 * rows still satisfy this type (the scoring fields are optional).
 */
export type SearchCardRow = CatalogCardRow & SearchRankable;

/** Card variant of normalizeProduct: sorts images, strips the junction embed. */
export function normalizeCatalogCard(row: CatalogCardRow): CatalogCardProduct {
  const { pc: _pc, ...rest } = row;
  return {
    ...rest,
    brand: row.brand ?? null,
    images: [...(rest.images ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    ),
  };
}

export function normalizeProduct(row: ProductJoinedRow): Product {
  const { pc: _pc, ...rest } = row;
  const images = [...(rest.images ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );

  return {
    ...rest,
    category: row.category ?? null,
    brand: row.brand ?? null,
    images,
    variants: row.variants ?? [],
  };
}
