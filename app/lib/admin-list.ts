/**
 * Server-side admin list pipeline shared by the products/brands/categories
 * admin pages and their API routes.
 *
 * Contract (fixes the "search only covered the current page" bug):
 *   user search → DB or= filter → COUNT(filtered) → range window → ≤size rows.
 * The count ALWAYS mirrors the filter, pagination is applied by PostgREST,
 * and every request carries a deterministic ORDER BY with a unique-column
 * tiebreaker (F1/F4/F5/F11 invariants).
 *
 * Search grammar is inherited from the live-verified F3 model
 * (sanitizeSearchTerm): reserved PostgREST logic-tree characters can never
 * reach an ilike pattern. Embed columns inside or= DO NOT parse on the live
 * PostgREST ("failed to parse logic tree", probed 2026-08), so brand/category
 * matching resolves UUIDs first and references them through
 * `brand_id.in.(...)` / `category_id.in.(...)` branches — shape verified
 * against the live service including COUNT + range windows.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit .ts extensions: this module is imported directly by
// tests/admin-search-pagination.test.ts under plain node ESM, where
// extensionless relative specifiers do not resolve.
import { sanitizeSearchTerm } from './catalog.ts';
import { collectSubtreeIds } from './category-tree.ts';
import type { Product, Category, Brand, ProductImage, ProductVariant } from './catalog.ts';

export const ADMIN_LIST_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_LIST_MAX_PAGE_SIZE = 100;
const RESOLUTION_PAGE = 1000; // PostgREST max_rows cap per response

export interface AdminListParams {
  page: number;
  size: number;
  /** sanitized user search; '' means no filtering */
  search: string;
  sort: string;
}

export function parseAdminListParams(
  searchParams: URLSearchParams,
  allowedSorts: readonly string[]
): AdminListParams {
  const sizeParam = Number(searchParams.get('size'));
  const pageParam = Number(searchParams.get('page'));
  // Integers only: fractional sizes truncate into broken window math.
  const size =
    Number.isInteger(sizeParam) && sizeParam > 0
      ? Math.min(sizeParam, ADMIN_LIST_MAX_PAGE_SIZE)
      : ADMIN_LIST_DEFAULT_PAGE_SIZE;
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
  const rawSort = searchParams.get('sort') ?? 'default';
  return {
    page,
    size,
    search: sanitizeSearchTerm(searchParams.get('search') ?? ''),
    sort: allowedSorts.includes(rawSort) ? rawSort : 'default',
  };
}

type OrderSpec = [column: string, ascending: boolean][];

const PRODUCT_SORTS: Record<string, OrderSpec> = {
  default: [
    ['created_at', false],
    ['id', false],
  ],
  name_asc: [
    ['name', true],
    ['id', true],
  ],
  name_desc: [
    ['name', false],
    ['id', false],
  ],
  price_asc: [
    ['price', true],
    ['id', true],
  ],
  price_desc: [
    ['price', false],
    ['id', false],
  ],
  stock_desc: [
    ['stock_quantity', false],
    ['id', false],
  ],
};
export const PRODUCT_SORT_KEYS = Object.keys(PRODUCT_SORTS);

const BRAND_SORTS: Record<string, OrderSpec> = {
  default: [
    ['created_at', false],
    ['id', false],
  ],
  name_asc: [
    ['name', true],
    ['id', true],
  ],
  name_desc: [
    ['name', false],
    ['id', false],
  ],
  slug: [
    ['slug', true],
    ['id', true],
  ],
};
export const BRAND_SORT_KEYS = Object.keys(BRAND_SORTS);

const CATEGORY_SORTS: Record<string, OrderSpec> = {
  default: [
    ['sort_order', true],
    ['id', true],
  ],
  name_asc: [
    ['name', true],
    ['id', true],
  ],
  name_desc: [
    ['name', false],
    ['id', false],
  ],
  slug: [
    ['slug', true],
    ['id', true],
  ],
  sort_order: [
    ['sort_order', true],
    ['id', true],
  ],
};
export const CATEGORY_SORT_KEYS = Object.keys(CATEGORY_SORTS);

/**
 * Unique tokens of the sanitized search (AND between tokens, OR across
 * fields — the same UX contract as storefront catalog search). Tokens are
 * grammar-safe by construction: sanitizeSearchTerm strips every character
 * that could corrupt an or= expression.
 */
function searchTokens(search: string): string[] {
  if (!search) return [];
  return [...new Set(search.split(' ').filter(Boolean))].slice(0, 10);
}

/** Paged ≤1000 read of matching brand/category ids (bounded, ordered). */
async function resolveNameOrSlugIds(
  client: SupabaseClient,
  table: 'brands' | 'categories',
  token: string
): Promise<string[]> {
  const expr = `name.ilike.%${token}%,slug.ilike.%${token}%`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    // Builder rebuilt INSIDE the loop (supabase-js accumulates repeated
    // .order calls on a shared builder); .order stays lexically adjacent
    // to .range per the project-wide pagination invariant.
    const { data, error } = await [['id', true] as OrderSpec[number]]
      .reduce(
        (q, [column, ascending]) => q.order(column, { ascending }),
        client.from(table).select('id').or(expr)
      )
      .range(from, from + RESOLUTION_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { id: string }[];
    out.push(...rows.map((r) => r.id));
    if (rows.length < RESOLUTION_PAGE) return out;
    from += RESOLUTION_PAGE;
  }
}

/**
 * One or= expression per token. Products additionally match through their
 * brand/category NAMES: embed paths inside or= fail to parse on the live
 * PostgREST, so matching ids are resolved first and referenced via in().
 * An empty resolution simply omits the branch (scalar branches still apply).
 *
 * Multi-category transition: a token's category branch expands each matched
 * category to its FULL subtree, referenced via the legacy products.category_id
 * column (always ∈ junction by construction of every writer). A product whose
 * NON-default assignment matches but whose default does not is covered by the
 * explicit categoryId dropdown filter below — accepted transition gap.
 */
async function buildProductExpressions(
  client: SupabaseClient,
  search: string
): Promise<string[]> {
  const expressions: string[] = [];
  for (const token of searchTokens(search)) {
    const parts = ['name', 'sku', 'slug', 'yugcontract_id'].map(
      (field) => `${field}.ilike.%${token}%`
    );
    const brandIds = await resolveNameOrSlugIds(client, 'brands', token);
    if (brandIds.length > 0) parts.push(`brand_id.in.(${brandIds.join(',')})`);
    const matchedCategoryIds = await resolveNameOrSlugIds(client, 'categories', token);
    if (matchedCategoryIds.length > 0) {
      const allCategories = await toTreeCategories(fetchAllCategories(client));
      const expanded = new Set<string>();
      for (const id of matchedCategoryIds) {
        for (const sub of collectSubtreeIds(allCategories, id)) expanded.add(sub);
      }
      parts.push(`category_id.in.(${[...expanded].join(',')})`);
    }
    expressions.push(parts.join(','));
  }
  return expressions;
}

/** CategoryRow -> minimal tree-shaped Category for collectSubtreeIds. */
async function toTreeCategories(rowsPromise: Promise<CategoryRow[]>): Promise<Category[]> {
  return (await rowsPromise).map((r) => ({
    id: r.id,
    parent_id: r.parent_id,
    name: r.name,
    slug: r.slug,
    sort_order: r.sort_order,
    is_active: r.is_active,
    created_at: r.created_at ?? '',
    updated_at: r.updated_at ?? '',
  }));
}

function buildPlainExpressions(fields: readonly string[], search: string): string[] {
  return searchTokens(search).map(
    (token) => fields.map((field) => `${field}.ilike.%${token}%`).join(',')
  );
}

interface PagedCoreOptions {
  table: string;
  select: string;
  params: AdminListParams;
  sorts: Record<string, OrderSpec>;
  expressions: string[];
  mapRow?: (row: any) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Builder-level embedded filter (pc.category_id) — never inside or=. */
  extraFilter?: { column: string; ids: string[] };
}

async function pagedAdminRead(
  client: SupabaseClient,
  options: PagedCoreOptions
): Promise<{ items: unknown[]; total: number; page: number; size: number }> {
  const { table, select, params, sorts, expressions, mapRow, extraFilter } = options;
  const orderSpec = sorts[params.sort] ?? sorts.default;

  // COUNT mirrors the data filters exactly (extraFilter included both here
  // and on the data query; the pc embed must join into this select for the
  // filter to have a relationship to constrain).
  const countSelect = extraFilter ? `id${JUNCTION_COUNT_EMBED}` : 'id';
  let countQuery = client.from(table).select(countSelect, { count: 'exact', head: true });
  if (extraFilter) countQuery = countQuery.in(extraFilter.column, extraFilter.ids);
  for (const expr of expressions) countQuery = countQuery.or(expr);
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  const total = count ?? 0;
  const maxPage = Math.max(1, Math.ceil(total / params.size));
  const page = Math.min(params.page, maxPage);

  const dataSelect = extraFilter ? select + JUNCTION_DATA_EMBED : select;
  let dataQuery = client.from(table).select(dataSelect);
  if (extraFilter) dataQuery = dataQuery.in(extraFilter.column, extraFilter.ids);
  for (const expr of expressions) dataQuery = dataQuery.or(expr);
  const from = (page - 1) * params.size;
  const { data, error } = await orderSpec
    .reduce((q, [column, ascending]) => q.order(column, { ascending }), dataQuery)
    .range(from, from + params.size - 1);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown[];
  return {
    items: mapRow ? rows.map(mapRow) : rows,
    total,
    page,
    size: params.size,
  };
}

// ------------------------------------------------------------- products

// The admin list must satisfy the full Product contract that the UI types
// against: relations are embedded and collection fields are always arrays.
export const PRODUCT_SELECT =
  '*, category:categories(*), brand:brands(*), images:product_images(*), variants:product_variants(*)';

// PostgREST embeds many-to-one relations as an object (or null) and
// one-to-many relations as arrays — this row type mirrors the raw shape.
export type ProductJoinedRow = Omit<
  Product,
  'category' | 'brand' | 'images' | 'variants' | 'pc'
> & {
  category: Category | null;
  brand: Brand | null;
  images: ProductImage[] | null;
  variants: ProductVariant[] | null;
  // Junction join attached only while a pc.category_id filter is active.
  pc?: { id: string }[] | null;
};

/** Category-filtered count join — selects product_id: `pc.id` resolves
 * against the EMBEDDED table and fails live (42703, verified 2026-08-26). */
const JUNCTION_COUNT_EMBED = ', pc:product_categories!inner(product_id)';
/** Category-filtered data join — stripped by normalizeProduct. */
const JUNCTION_DATA_EMBED = ', pc:product_categories!inner(product_id)';

export function normalizeProduct(row: ProductJoinedRow): Product {
  const { pc: _pc, ...rest } = row;
  return {
    ...rest,
    category: row.category ?? null,
    brand: row.brand ?? null,
    images: [...(rest.images ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    ),
    variants: rest.variants ?? [],
  };
}

export async function listAdminProducts(
  client: SupabaseClient,
  params: Partial<AdminListParams> & { categoryId?: string }
): Promise<{ products: Product[]; total: number; page: number; size: number }> {
  const resolved: AdminListParams = {
    page: params.page && params.page > 0 ? params.page : 1,
    size:
      params.size && params.size > 0
        ? Math.min(params.size, ADMIN_LIST_MAX_PAGE_SIZE)
        : ADMIN_LIST_DEFAULT_PAGE_SIZE,
    search: sanitizeSearchTerm(params.search ?? ''),
    sort: PRODUCT_SORT_KEYS.includes(params.sort ?? 'default')
      ? (params.sort as string)
      : 'default',
  };

  // Explicit category dropdown filter: subtree-aware and junction-driven.
  let extraFilter: PagedCoreOptions['extraFilter'];
  const rawCategoryId = params.categoryId?.trim() ?? '';
  if (rawCategoryId !== '') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCategoryId)) {
      return { products: [], total: 0, page: 1, size: resolved.size };
    }
    const ids = Array.from(collectSubtreeIds(await toTreeCategories(fetchAllCategories(client)), rawCategoryId));
    extraFilter = { column: 'pc.category_id', ids };
  }

  const expressions = await buildProductExpressions(client, resolved.search);
  const result = await pagedAdminRead(client, {
    table: 'products',
    select: PRODUCT_SELECT,
    params: resolved,
    sorts: PRODUCT_SORTS,
    expressions,
    mapRow: normalizeProduct,
    ...(extraFilter ? { extraFilter } : {}),
  });
  return {
    products: result.items as Product[],
    total: result.total,
    page: result.page,
    size: result.size,
  };
}

// --------------------------------------------------------------- brands

const BRAND_FIELDS =
  'id, name, slug, description, logo, is_active, created_at, updated_at';
export const BRAND_FIELDS_LIST = BRAND_FIELDS;

export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}

export async function listAdminBrands(
  client: SupabaseClient,
  params: Partial<AdminListParams>
): Promise<{ brands: BrandRow[]; total: number; page: number; size: number }> {
  const resolved: AdminListParams = {
    page: params.page && params.page > 0 ? params.page : 1,
    size:
      params.size && params.size > 0
        ? Math.min(params.size, ADMIN_LIST_MAX_PAGE_SIZE)
        : ADMIN_LIST_DEFAULT_PAGE_SIZE,
    search: sanitizeSearchTerm(params.search ?? ''),
    sort: BRAND_SORT_KEYS.includes(params.sort ?? 'default')
      ? (params.sort as string)
      : 'default',
  };
  const result = await pagedAdminRead(client, {
    table: 'brands',
    select: BRAND_FIELDS,
    params: resolved,
    sorts: BRAND_SORTS,
    expressions: buildPlainExpressions(['name', 'slug'], resolved.search),
  });
  return {
    brands: result.items as BrandRow[],
    total: result.total,
    page: result.page,
    size: result.size,
  };
}

// ----------------------------------------------------------- categories

const CATEGORY_FIELDS =
  'id, parent_id, name, slug, description, image, sort_order, is_active, created_at, updated_at';
export const CATEGORY_FIELDS_LIST = CATEGORY_FIELDS;

/**
 * Bounded full-set reads for form dropdowns (product category/brand pickers,
 * category parent picker). Paged ≤1000 windows with an id order — never an
 * unbounded SELECT.
 */
async function fetchAllPlainRows(
  client: SupabaseClient,
  table: string,
  select: string
): Promise<unknown[]> {
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order('id')
      .range(from, from + RESOLUTION_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown[];
    out.push(...rows);
    if (rows.length < RESOLUTION_PAGE) return out;
    from += RESOLUTION_PAGE;
  }
}

export async function fetchAllBrands(client: SupabaseClient): Promise<BrandRow[]> {
  const rows = await fetchAllPlainRows(client, 'brands', BRAND_FIELDS);
  return rows as BrandRow[];
}

export async function fetchAllCategories(client: SupabaseClient): Promise<CategoryRow[]> {
  const rows = await fetchAllPlainRows(client, 'categories', CATEGORY_FIELDS);
  return rows as CategoryRow[];
}

export interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
}

export async function listAdminCategories(
  client: SupabaseClient,
  params: Partial<AdminListParams>
): Promise<{ categories: CategoryRow[]; total: number; page: number; size: number }> {
  const resolved: AdminListParams = {
    page: params.page && params.page > 0 ? params.page : 1,
    size:
      params.size && params.size > 0
        ? Math.min(params.size, ADMIN_LIST_MAX_PAGE_SIZE)
        : ADMIN_LIST_DEFAULT_PAGE_SIZE,
    search: sanitizeSearchTerm(params.search ?? ''),
    sort: CATEGORY_SORT_KEYS.includes(params.sort ?? 'default')
      ? (params.sort as string)
      : 'default',
  };
  const result = await pagedAdminRead(client, {
    table: 'categories',
    select: CATEGORY_FIELDS,
    params: resolved,
    sorts: CATEGORY_SORTS,
    expressions: buildPlainExpressions(['name', 'slug'], resolved.search),
  });
  return {
    categories: result.items as CategoryRow[],
    total: result.total,
    page: result.page,
    size: result.size,
  };
}
