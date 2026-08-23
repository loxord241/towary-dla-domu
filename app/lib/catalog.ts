import { createClient } from '@supabase/supabase-js';

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

const UK_LANGUAGE_CODE = 'uk';

const PRODUCT_SELECT =
  '*, category:categories(*), brand:brands(*), images:product_images(*), variants:product_variants(*)';

// PostgREST embeds a many-to-one relation as an object (or null when the
// FK is unset) and one-to-many relations as arrays — verified against the
// live database. This row type mirrors that raw shape exactly.
type ProductJoinedRow = Omit<
  Product,
  'category' | 'brand' | 'images' | 'variants'
> & {
  category: Category | null;
  brand: Brand | null;
  images: ProductImage[] | null;
  variants: ProductVariant[] | null;
};

interface ProductsTranslationRow {
  product_id: string;
  name: string | null;
  short_description: string | null;
  description: string | null;
}

interface CategoriesTranslationRow {
  category_id: string;
  name: string | null;
  description: string | null;
}

interface BrandsTranslationRow {
  brand_id: string;
  name: string | null;
  description: string | null;
}

function normalizeProduct(row: ProductJoinedRow): Product {
  const images = [...(row.images ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );

  return {
    ...row,
    category: row.category ?? null,
    brand: row.brand ?? null,
    images,
    variants: row.variants ?? [],
  };
}

async function getProductTranslationMap(
  ids: string[]
): Promise<Map<string, ProductsTranslationRow>> {
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('products_translations')
    .select('product_id, name, short_description, description')
    .in('product_id', ids)
    .eq('language_code', UK_LANGUAGE_CODE)
    .returns<ProductsTranslationRow[]>();

  if (error) {
    console.error('Failed to load products_translations:', error.message);
    return new Map();
  }

  return new Map((data ?? []).map((row) => [row.product_id, row]));
}

async function getCategoryTranslationMap(
  ids: string[]
): Promise<Map<string, CategoriesTranslationRow>> {
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('categories_translations')
    .select('category_id, name, description')
    .in('category_id', ids)
    .eq('language_code', UK_LANGUAGE_CODE)
    .returns<CategoriesTranslationRow[]>();

  if (error) {
    console.error('Failed to load categories_translations:', error.message);
    return new Map();
  }

  return new Map((data ?? []).map((row) => [row.category_id, row]));
}

async function getBrandTranslationMap(
  ids: string[]
): Promise<Map<string, BrandsTranslationRow>> {
  if (ids.length === 0) return new Map();

  const { data, error } = await supabase
    .from('brands_translations')
    .select('brand_id, name, description')
    .in('brand_id', ids)
    .eq('language_code', UK_LANGUAGE_CODE)
    .returns<BrandsTranslationRow[]>();

  if (error) {
    console.error('Failed to load brands_translations:', error.message);
    return new Map();
  }

  return new Map((data ?? []).map((row) => [row.brand_id, row]));
}

/** Overlay uk translations onto products; base columns stay as fallback. */
function overlayProductTranslations(
  products: Product[],
  translations: Map<string, ProductsTranslationRow>
): Product[] {
  return products.map((product) => {
    const t = translations.get(product.id);
    if (!t) return product;
    return {
      ...product,
      name: t.name ?? product.name,
      short_description: t.short_description ?? product.short_description,
      description: t.description ?? product.description,
    };
  });
}

/** Overlay uk translations onto embedded category/brand objects. */
async function overlayRelationTranslations(products: Product[]): Promise<Product[]> {
  const categoryIds = [
    ...new Set(
      products
        .map((p) => p.category?.id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const brandIds = [
    ...new Set(
      products.map((p) => p.brand?.id).filter((id): id is string => Boolean(id))
    ),
  ];

  const [catMap, brandMap] = await Promise.all([
    getCategoryTranslationMap(categoryIds),
    getBrandTranslationMap(brandIds),
  ]);

  return products.map((product) => ({
    ...product,
    category:
      product.category && catMap.has(product.category.id)
        ? {
            ...product.category,
            name: catMap.get(product.category.id)?.name ?? product.category.name,
            description:
              catMap.get(product.category.id)?.description ??
              product.category.description,
          }
        : (product.category ?? null),
    brand:
      product.brand && brandMap.has(product.brand.id)
        ? {
            ...product.brand,
            name: brandMap.get(product.brand.id)?.name ?? product.brand.name,
            description:
              brandMap.get(product.brand.id)?.description ??
              product.brand.description,
          }
        : (product.brand ?? null),
  }));
}

async function fetchProducts(options: {
  featuredOnly?: boolean;
}): Promise<Product[]> {
  let query = supabase
    .from('products')
    .select(PRODUCT_SELECT)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (options.featuredOnly) {
    query = query.eq('is_featured', true);
  }

  const { data, error } = await query.returns<ProductJoinedRow[]>();

  if (error) {
    console.error('Failed to load products:', error.message);
    return [];
  }

  const products = (data ?? []).map(normalizeProduct);

  const translationMap = await getProductTranslationMap(
    products.map((p) => p.id)
  );
  const withTranslations = overlayProductTranslations(
    products,
    translationMap
  );

  return overlayRelationTranslations(withTranslations);
}

/** Sanitize a user-supplied search term for use inside a PostgREST `or` expression. */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[%,()]/g, ' ').trim();
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
 * Find product ids whose uk translation matches the search term. Used to
 * widen catalog search beyond the base columns: the storefront displays
 * translated names, so users search in uk as well.
 */
async function getUkTranslatedProductIds(search: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('products_translations')
      .select('product_id')
      .eq('language_code', UK_LANGUAGE_CODE)
      .or(
        `name.ilike.%${search}%,short_description.ilike.%${search}%,description.ilike.%${search}%`
      );

    if (error) throw error;
    return (data ?? []).map((row) => row.product_id);
  } catch {
    // On failure fall back to base-column search only.
    return [];
  }
}

/**
 * All active storefront products with category, brand, images and variants,
 * filtered/sorted for the catalog page. uk translations are applied when
 * available; base columns act as fallback.
 *
 * Category/brand filters use PostgREST embedded-resource filters
 * (`category.slug=eq...`), which act as inner joins — products with a
 * NULL category are naturally excluded when the filter is applied.
 * Search covers the base name/short description plus any uk translation
 * field (union), since visitors search using the displayed uk names.
 */
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
  const search = sanitizeSearchTerm(filters.search ?? '');
  let translatedIds: string[] = [];
  if (search) {
    translatedIds = await getUkTranslatedProductIds(search);
  }
  const searchConditions = search
    ? [
        `name.ilike.%${search}%`,
        `short_description.ilike.%${search}%`,
        ...(translatedIds.length > 0
          ? [`id.in.(${translatedIds.join(',')})`]
          : []),
      ]
    : null;

  // ---- total count with identical filters (no pagination) ----
  let countQuery = supabase
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);

  if (filters.categorySlug) {
    countQuery = countQuery.eq('category.slug', filters.categorySlug);
  }
  if (filters.brandSlug) {
    countQuery = countQuery.eq('brand.slug', filters.brandSlug);
  }

  if (searchConditions) {
    countQuery = countQuery.or(searchConditions.join(','));
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
    .select(PRODUCT_SELECT)
    .eq('is_active', true);

  if (filters.categorySlug) {
    query = query.eq('category.slug', filters.categorySlug);
  }
  if (filters.brandSlug) {
    query = query.eq('brand.slug', filters.brandSlug);
  }

  if (searchConditions) {
    query = query.or(searchConditions.join(','));
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

  switch (filters.sort) {
    case 'price_asc':
      query = query.order('price', { ascending: true });
      break;
    case 'price_desc':
      query = query.order('price', { ascending: false });
      break;
    case 'name_asc':
      query = query.order('name', { ascending: true });
      break;
    default:
      query = query.order('created_at', { ascending: false });
  }

  query = query.range((page - 1) * size, page * size - 1);

  const { data, error } = await query.returns<ProductJoinedRow[]>();

  if (error) {
    console.error('Failed to load catalog products:', error.message);
    return { products: [], total, page: 1, size };
  }

  const products = (data ?? []).map(normalizeProduct);

  const translationMap = await getProductTranslationMap(
    products.map((p) => p.id)
  );
  const withTranslations = overlayProductTranslations(
    products,
    translationMap
  );

  return {
    products: await overlayRelationTranslations(withTranslations),
    total,
    page,
    size,
  };
}

/**
 * Active products marked as featured for the home page.
 */
export async function fetchFeaturedProducts(): Promise<Product[]> {
  return fetchProducts({ featuredOnly: true });
}

/**
 * Active categories ordered for navigation. uk translations are applied
 * when available; base columns act as fallback.
 */
export async function fetchActiveCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .returns<Category[]>();

  if (error) {
    console.error('Failed to load categories:', error.message);
    return [];
  }

  const categories = data ?? [];
  const translationMap = await getCategoryTranslationMap(
    categories.map((c) => c.id)
  );

  return categories.map((category) => {
    const t = translationMap.get(category.id);
    if (!t) return category;
    return {
      ...category,
      name: t.name ?? category.name,
      description: t.description ?? category.description,
    };
  });
}

/**
 * Active brands. uk translations are applied when available; base columns
 * act as fallback.
 */
export async function fetchActiveBrands(): Promise<Brand[]> {
  const { data, error } = await supabase
    .from('brands')
    .select('*')
    .eq('is_active', true)
    .order('name', { ascending: true })
    .returns<Brand[]>();

  if (error) {
    console.error('Failed to load brands:', error.message);
    return [];
  }

  const brands = data ?? [];
  const translationMap = await getBrandTranslationMap(brands.map((b) => b.id));

  return brands.map((brand) => {
    const t = translationMap.get(brand.id);
    if (!t) return brand;
    return {
      ...brand,
      name: t.name ?? brand.name,
      description: t.description ?? brand.description,
    };
  });
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
    console.error(`Failed to load product by slug "${slug}":`, error.message);
    return null;
  }

  if (!data) return null;

  let product = normalizeProduct(data);

  // Apply uk translation to the product and its embedded relations.
  const productTranslations = await getProductTranslationMap([product.id]);
  product = overlayProductTranslations([product], productTranslations)[0]!;

  if (product.category) {
    const catMap = await getCategoryTranslationMap([product.category.id]);
    const t = catMap.get(product.category.id);
    if (t) {
      product = {
        ...product,
        category: {
          ...product.category,
          name: t.name ?? product.category.name,
          description: t.description ?? product.category.description,
        },
      };
    }
  }

  if (product.brand) {
    const brandMap = await getBrandTranslationMap([product.brand.id]);
    const t = brandMap.get(product.brand.id);
    if (t) {
      product = {
        ...product,
        brand: {
          ...product.brand,
          name: t.name ?? product.brand.name,
          description: t.description ?? product.brand.description,
        },
      };
    }
  }

  return product;
}
