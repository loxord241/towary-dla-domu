import { createClient } from '@supabase/supabase-js';
// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { collectSubtreeIds } from './category-tree.ts';

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
const supabase = createClient(
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
const PRODUCT_SELECT =
  '*, category:categories!products_category_id_fkey(id, name, slug), brand:brands(*), images:product_images!inner(*), variants:product_variants(*)';

/** Same eligibility join for head-count queries (no row multiplication). */
// NOTE: the junction count embed selects product_id (a real column), NOT id:
// PostgREST resolves `pc.id` against the EMBEDDED table, and selecting
// `, pc:product_categories!inner(id)` made the head-count fail live with
// 42703 "column product_categories_1.id does not exist" (verified 2026-08-26).
const ELIGIBLE_COUNT_SELECT = 'id, images:product_images!inner(id)';
const JUNCTION_COUNT_SELECT = 'id, images:product_images!inner(id), pc:product_categories!inner(product_id)';

// PostgREST embeds a many-to-one relation as an object (or null when the
// FK is unset) and one-to-many relations as arrays — verified against the
// live database. This row type mirrors that raw shape exactly.
type ProductJoinedRow = Omit<
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

function normalizeProduct(row: ProductJoinedRow): Product {
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

async function fetchProducts(options: {
  featuredOnly?: boolean;
}): Promise<Product[]> {
  // Full read via paged windows: PostgREST caps ANY single response at
  // 1000 rows, so the previous unbounded select would silently truncate
  // the set once featured/active products exceed that cap. The home page
  // renders the WHOLE returned array — the contract is "all of them".
  // The query chain is rebuilt INSIDE the loop: supabase-js builders
  // accumulate repeated .order() calls (url searchParams append), so a
  // shared builder corrupts ordering on page 2+. `id desc` is a
  // deterministic tiebreaker for bulk-imported rows sharing created_at.
  const products: Product[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000; // PostgREST max_rows cap per response
    let query = supabase
      .from('products')
      .select(PRODUCT_SELECT)
      .eq('is_active', true);
    if (options.featuredOnly) {
      query = query.eq('is_featured', true);
    }
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
      .returns<ProductJoinedRow[]>();

    if (error) {
      // Never serve a partial set as if it were complete — and never serve
      // an empty set as if the catalog were empty: a data error must reach
      // app/error.tsx (honest failure), not masquerade as "no products".
      throw new Error(`Failed to load products: ${error.message}`);
    }

    const rows = data ?? [];
    products.push(...rows.map(normalizeProduct));
    if (rows.length < PAGE) return products;
    from += PAGE;
  }
}

/**
 * Sanitize a user-supplied search term for use inside a PostgREST `or`
 * expression (`name.ilike.%term%,short_description.ilike.%term%`).
 *
 * Specials are REPLACED with a space (not removed) so word tokens stay
 * separated: "foo,bar" stays searchable as two words. Reserved chars,
 * verified against the LIVE PostgREST (2026-08):
 *   ','  hard parse failure (PGRST100);
 *   '"'  silently swallowed as value-quoting syntax and CORRUPTS the
 *        ilike pattern — a product named `…поварський6" (24010/106)`
 *        was unfindable by its own name;
 *   '(' ')' same silent corruption class;
 *   '%'  ILIKE wildcard — silently broadens matches (searching "100%"
 *        matched everything containing "100").
 * Dots, hyphens, apostrophes, colons and any letters/digits are proven
 * safe literals and deliberately preserved. Interior whitespace runs are
 * collapsed so adjacent specials don't leave unmatched gaps.
 */
export function sanitizeSearchTerm(term: string): string {
  return term
    .replace(/[%,()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the search filter for /catalog from a raw user query.
 *
 * UX contract (2026-08 audit fix): word ORDER must not matter. Every
 * non-empty sanitized token becomes its own PostgREST `or` expression —
 * `name.ilike.%tok%,short_description.ilike.%tok%` — and the caller ANDs
 * the expressions by chaining `.or()` once per token (supabase-js appends
 * a separate `or` query param per call; separate filters intersect).
 *
 * «мультипіч TEFAL» and «TEFAL мультипіч» therefore yield the same
 * condition SET. A single token keeps the legacy single-`or` shape, and an
 * empty/specials-only query yields null (no search filter at all).
 *
 * Injection safety is inherited from sanitizeSearchTerm: no reserved
 * or= grammar character (`,` `"` `(` `)` `%`) can survive inside a
 * pattern value, verified by tests/catalog-search.test.ts.
 */
export function buildSearchConditions(search: string): string[] | null {
  const sanitized = sanitizeSearchTerm(search);
  if (!sanitized) return null;
  // Cap the fan-out: each token becomes an `or` expression on the count AND
  // the data query, so an absurdly long `q=` must not multiply ILIKE cost
  // without bound. Ten tokens is far beyond any meaningful storefront query.
  const tokens = [...new Set(sanitized.split(' ').filter(Boolean))].slice(0, 10);
  return tokens.map(
    (token) => `name.ilike.%${token}%,short_description.ilike.%${token}%`
  );
}

export type CatalogSort = 'newest' | 'price_asc' | 'price_desc' | 'name_asc';

export interface CatalogFilters {
  categorySlug?: string;
  brandSlug?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  sort?: CatalogSort;
  page?: number;
  /** page size for the catalog grid (server-enforced cap) */
  size?: number;
}

export const CATALOG_PAGE_SIZE = 12;
const CATALOG_MAX_PAGE_SIZE = 50;

/**
 * Resolve a category/brand slug to its UUID. Catalog filters target plain
 * FK columns (category_id/brand_id) instead of PostgREST embedded-resource
 * filters: embed filters require the embed in `select`, and without
 * `!inner` they degrade to left-join semantics that keep non-matching
 * rows (verified against the live database 2026-08). Returns null when
 * the slug does not exist.
 */
async function findCategoryIdBySlug(slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data?.id ?? null;
}

async function findBrandIdBySlug(slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('brands')
    .select('id')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Light slug → display-name lookups for UI chrome (filter chips, H1,
 * generateMetadata). Single indexed selects; return null for unknown or
 * inactive slugs.
 */
export async function fetchCategoryBySlug(
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

export async function fetchBrandBySlug(
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
export interface CatalogPage {
  products: Product[];
  total: number;
  page: number;
  size: number;
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
  const searchConditions = buildSearchConditions(filters.search ?? '');

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
  if (categoryId) {
    const activeCategories = await fetchActiveCategories();
    subtreeIds = Array.from(collectSubtreeIds(activeCategories, categoryId));
  }

  // ---- total count with identical filters (no pagination) ----
  // The eligibility join MUST mirror PRODUCT_SELECT, otherwise totals
  // would count imageless products that the data query can never return.
  let countQuery = supabase
    .from('products')
    .select(categoryId ? JUNCTION_COUNT_SELECT : ELIGIBLE_COUNT_SELECT, {
      count: 'exact',
      head: true,
    })
    .eq('is_active', true);

  if (categoryId) {
    countQuery = countQuery.in('pc.category_id', subtreeIds);
  }
  if (brandId) {
    countQuery = countQuery.eq('brand_id', brandId);
  }

  if (searchConditions) {
    for (const condition of searchConditions) {
      countQuery = countQuery.or(condition);
    }
  }

  if (filters.minPrice !== undefined) {
    countQuery = countQuery.gte('price', filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    countQuery = countQuery.lte('price', filters.maxPrice);
  }
  if (filters.inStockOnly) {
    countQuery = countQuery.eq('availability_status', 'in_stock');
  }

  const { count, error: countError } = await countQuery;
  if (countError) {
    console.error('Failed to count catalog products:', countError.message);
    return { products: [], total: 0, page: 1, size };
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(filters.page ?? 1, 1), maxPage);

  // ---- paged data query ----
  let query = supabase
    .from('products')
    .select(
      categoryId
        ? PRODUCT_SELECT + ', pc:product_categories!inner(category_id)'
        : PRODUCT_SELECT
    )
    .eq('is_active', true);

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
  // pagination overlap.
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
      query = query.order('created_at', { ascending: false }).order('id', { ascending: false });
  }

  query = query.range((page - 1) * size, page * size - 1);

  const { data, error } = await query.returns<ProductJoinedRow[]>();

  if (error) {
    // A data error must reach app/error.tsx (honest failure) — an empty
    // catalog page would read as "the shop has no products".
    throw new Error(`Failed to load catalog products: ${error.message}`);
  }

  const products = (data ?? []).map(normalizeProduct);

  return {
    products,
    total,
    page,
    size,
  };
}

// ---------------------------------------------------------------------------
// Product reviews (Відгуки) — public READS only.
//
// Writes never go through this file: submissions land as status='pending'
// via app/api/reviews/route.ts (service role) and are published/rejected in
// the admin API. The queries below run on the ANONYMOUS client, so RLS
// already restricts rows to status='published'; the .eq('status') filters
// stay as defense-in-depth so the contract survives even a future policy
// regression.
// ---------------------------------------------------------------------------

export interface ProductReview {
  id: string;
  product_id: string;
  rating: number;
  text: string;
  display_name: string | null;
  created_at: string;
}

export interface ReviewsPageData {
  reviews: ProductReview[];
  total: number;
  page: number;
  pageSize: number;
}

/** Hard cap for one rendered page of reviews — bounded by design. */
export const REVIEWS_PAGE_SIZE = 10;

/** Column whitelist — never select('*') on user-generated content. */
const REVIEW_COLUMNS =
  'id, product_id, rating, text, display_name, created_at';

export async function fetchPublishedReviews(
  productId: string,
  page = 1
): Promise<ReviewsPageData> {
  const { count, error: countError } = await supabase
    .from('product_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
    .eq('status', 'published');
  if (countError) {
    throw new Error(`Failed to count reviews: ${countError.message}`);
  }

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), maxPage);

  const { data, error } = await supabase
    .from('product_reviews')
    .select(REVIEW_COLUMNS)
    .eq('product_id', productId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range((safePage - 1) * REVIEWS_PAGE_SIZE, safePage * REVIEWS_PAGE_SIZE - 1);

  if (error) {
    throw new Error(`Failed to load reviews: ${error.message}`);
  }

  return {
    reviews: data ?? [],
    total,
    page: safePage,
    pageSize: REVIEWS_PAGE_SIZE,
  };
}

export interface ReviewSummary {
  total: number;
  /** Arithmetic mean rounded to 1 decimal; null when no published reviews. */
  average: number | null;
  /** Index 0 = ★1 … index 4 = ★5. */
  distribution: [number, number, number, number, number];
}

/**
 * Average + star distribution via five indexed head-counts (no review rows
 * cross the wire regardless of how many exist).
 */
export async function fetchReviewSummary(
  productId: string
): Promise<ReviewSummary> {
  const results = await Promise.all(
    ([1, 2, 3, 4, 5] as const).map(async (rating) => {
      const { count, error } = await supabase
        .from('product_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('product_id', productId)
        .eq('status', 'published')
        .eq('rating', rating);
      if (error) {
        throw new Error(`Failed to summarize rating ${rating}: ${error.message}`);
      }
      return count ?? 0;
    })
  );

  const distribution: ReviewSummary['distribution'] = [
    results[0],
    results[1],
    results[2],
    results[3],
    results[4],
  ];
  const total = distribution.reduce((sum, n) => sum + n, 0);
  const weighted =
    distribution[0] * 1 +
    distribution[1] * 2 +
    distribution[2] * 3 +
    distribution[3] * 4 +
    distribution[4] * 5;

  return {
    total,
    average: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
    distribution,
  };
}

/**
 * Active products marked as featured for the home page.
 */
export async function fetchFeaturedProducts(): Promise<Product[]> {
  return fetchProducts({ featuredOnly: true });
}

/** Hard cap for the home «Популярні товари» shelf — bounded by design. */
const POPULAR_LIMIT = 8;

/**
 * Products for the home «Популярні товари» section — PURELY admin-curated.
 *
 * DECISION 2026-08-26 (supersedes the Stage-11 newest-arrivals fallback):
 * popularity has no real sales signal yet, and padding the shelf with
 * newest arrivals blurred who controls the block. It now shows EXACTLY the
 * active products flagged is_featured — newest first with an id tiebreaker,
 * hard-capped at 8. If an admin flags more than 8, the first 8 in this
 * deterministic order win and DATA IS NEVER CHANGED AUTOMATICALLY (the
 * max-8 business rule lives in the admin API/UI, see featured-limit.ts).
 * Zero featured ⇒ the home page skips the section entirely.
 */
export async function fetchPopularProducts(
  limit: number = POPULAR_LIMIT
): Promise<Product[]> {
  const take = Math.min(Math.max(limit, 1), POPULAR_LIMIT);

  // Single bounded window (rows 0..take-1, at most 8) — never a paged scan.
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .eq('is_featured', true)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, take - 1)
    .returns<ProductJoinedRow[]>();

  if (error) {
    throw new Error(`Failed to load popular products: ${error.message}`);
  }

  return (data ?? []).map(normalizeProduct);
}

export async function fetchActiveCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
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

/**
 * Active brands.
 */
export async function fetchActiveBrands(): Promise<Brand[]> {
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

/**
 * Find an active product by slug with category, brand, images and variants.
 * Main image is derived from product_images.is_main (there is no
 * products.main_image column in the schema).
 * Returns null when no active product matches the slug.
 */
export async function fetchProductBySlug(slug: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('slug', slug)
    .eq('is_active', true)
    .returns<ProductJoinedRow[]>()
    .maybeSingle();

  if (error) {
    // A data error is not a missing product: rethrow so the route renders
    // the error boundary instead of a misleading 404.
    throw new Error(`Failed to load product by slug "${slug}": ${error.message}`);
  }

  if (!data) return null;

  return normalizeProduct(data);
}
// ---------------------------------------------------------------------------
// «Схожі товари» (related products) — read-only discovery shelf for the
// product page. Up to THREE bounded reads (one window ≤limit each), merged
// by the PURE collectRelated: same category first, then same brand, then
// newest. Eligibility mirrors the storefront exactly (PRODUCT_SELECT ⇒
// is_active + ≥1 photo); the current product is excluded in SQL. No RPC,
// no new tables (spec A 2026-08-26).
// ---------------------------------------------------------------------------

/** Hard cap for «Схожі товари» — bounded by design. */
export const RELATED_LIMIT = 8;

/**
 * PURE merge of pre-fetched candidate groups into the final related list.
 * Group order IS the priority; within a group the DB already returned
 * created_at desc → id desc. Dedupes by id, skips currentId, caps at `cap`.
 */
export function collectRelated(
  groups: Product[][],
  currentId: string,
  cap: number = RELATED_LIMIT
): Product[] {
  const seen = new Set<string>([currentId]);
  const collected: Product[] = [];
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

async function fetchRelatedStage(
  filter: RelatedStageFilter,
  currentId: string,
  limit: number
): Promise<Product[]> {
  let query = supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .neq('id', currentId);
  if (filter?.kind === 'category') {
    // Same junction + subtree semantics as fetchCatalogProducts. The count
    // embed uses product_id (see JUNCTION_COUNT_SELECT note).
    query = query
      .select(PRODUCT_SELECT + ', pc:product_categories!inner(category_id)')
      .in('pc.category_id', filter.subtreeIds);
  } else if (filter?.kind === 'brand') {
    query = query.eq('brand_id', filter.id);
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, limit - 1)
    .returns<ProductJoinedRow[]>();
  if (error) {
    throw new Error(`Failed to load related products: ${error.message}`);
  }
  return (data ?? []).map(normalizeProduct);
}

export async function fetchRelatedProducts(
  product: Pick<Product, 'id' | 'category_id' | 'brand_id'>,
  limit: number = RELATED_LIMIT
): Promise<Product[]> {
  const sameCategoryStage = product.category_id
    ? fetchActiveCategories().then((activeCategories) =>
        fetchRelatedStage(
          {
            kind: 'category',
            subtreeIds: Array.from(collectSubtreeIds(activeCategories, product.category_id!)),
          },
          product.id,
          limit
        )
      )
    : Promise.resolve<Product[]>([]);
  const [sameCategory, sameBrand, newest] = await Promise.all([
    sameCategoryStage,
    product.brand_id
      ? fetchRelatedStage({ kind: 'brand', id: product.brand_id }, product.id, limit)
      : Promise.resolve<Product[]>([]),
    fetchRelatedStage(null, product.id, limit),
  ]);
  return collectRelated([sameCategory, sameBrand, newest], product.id, limit);
}

