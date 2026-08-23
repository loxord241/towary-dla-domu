import Link from 'next/link'
import { Suspense } from 'react'
import {
  fetchCatalogProducts,
  fetchActiveCategories,
  fetchActiveBrands,
  type CatalogFilters as CatalogFilterOptions,
  type CatalogSort,
} from '@/app/lib/catalog'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import CatalogFilters from './CatalogFilters'
import SortSelect from './SortSelect'
import { CATALOG_PAGE_SIZE } from '@/app/lib/catalog'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

const SORT_VALUES: CatalogSort[] = ['newest', 'price_asc', 'price_desc', 'name_asc'];

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function parsePageParam(raw: string | string[] | undefined): number {
  const n = Number(firstParam(raw));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

interface ActiveChip {
  label: string;
  removeKey: string;
}

function buildActiveChips(
  filters: CatalogFilterOptions
): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filters.search) chips.push({ label: `«${filters.search}»`, removeKey: 'q' });
  if (filters.categorySlug) chips.push({ label: `Категорія: ${filters.categorySlug}`, removeKey: 'category' });
  if (filters.brandSlug) chips.push({ label: `Бренд: ${filters.brandSlug}`, removeKey: 'brand' });
  if (filters.minPrice !== undefined) chips.push({ label: `від ${filters.minPrice} ₴`, removeKey: 'min' });
  if (filters.maxPrice !== undefined) chips.push({ label: `до ${filters.maxPrice} ₴`, removeKey: 'max' });
  if (filters.inStockOnly) chips.push({ label: 'Тільки в наявності', removeKey: 'stock' });
  return chips;
}

function removeParamUrl(
  rawParams: Record<string, string | string[] | undefined>,
  key: string
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(rawParams)) {
    if (k === key || k === 'page') continue;
    const val = Array.isArray(v) ? v[0] : v;
    if (val) sp.set(k, val);
  }
  const qs = sp.toString();
  return qs ? `/catalog?${qs}` : '/catalog';
}

/** Builds a /catalog URL for a target page preserving all other params. */
function catalogPageUrl(
  rawParams: Record<string, string | string[] | undefined>,
  targetPage: number
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === 'page') continue;
    const val = Array.isArray(value) ? value[0] : value;
    if (val) sp.set(key, val);
  }
  if (targetPage > 1) sp.set('page', String(targetPage));
  const qs = sp.toString();
  return qs ? `/catalog?${qs}` : '/catalog';
}

interface ParsedCatalog {
  filters: CatalogFilterOptions;
  hasActiveFilters: boolean;
}

function parseCatalogSearchParams(
  raw: Record<string, string | string[] | undefined>
): ParsedCatalog {
  const categorySlug = firstParam(raw.category).trim();
  const brandSlug = firstParam(raw.brand).trim();
  const search = firstParam(raw.q).trim();
  const stock = firstParam(raw.stock) === '1';

  const minRaw = Number(firstParam(raw.min));
  const maxRaw = Number(firstParam(raw.max));
  const minPrice =
    firstParam(raw.min).trim() !== '' && Number.isFinite(minRaw) && minRaw >= 0
      ? minRaw
      : undefined;
  const maxPrice =
    firstParam(raw.max).trim() !== '' && Number.isFinite(maxRaw) && maxRaw >= 0
      ? maxRaw
      : undefined;

  const sortRaw = firstParam(raw.sort);
  const sort: CatalogSort = SORT_VALUES.includes(sortRaw as CatalogSort)
    ? (sortRaw as CatalogSort)
    : 'newest';

  const filters: CatalogFilterOptions = {
    categorySlug: categorySlug || undefined,
    brandSlug: brandSlug || undefined,
    search: search || undefined,
    minPrice,
    maxPrice,
    inStockOnly: stock,
    sort,
    page: parsePageParam(raw.page),
    size: CATALOG_PAGE_SIZE,
  };

  const hasActiveFilters = Boolean(
    filters.categorySlug ||
      filters.brandSlug ||
      filters.search ||
      filters.minPrice !== undefined ||
      filters.maxPrice !== undefined ||
      filters.inStockOnly
  );

  return { filters, hasActiveFilters };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const rawParams = await searchParams;
  const { filters, hasActiveFilters } = parseCatalogSearchParams(rawParams);

  const [catalog, categories, brands] = await Promise.all([
    fetchCatalogProducts(filters),
    fetchActiveCategories(),
    fetchActiveBrands(),
  ])
  const products = catalog.products
  const total = catalog.total
  // Server returns the CLAMPED page — out-of-range requests render the last
  // real page instead of an empty grid.
  const page = catalog.page
  const maxPage = Math.max(1, Math.ceil(total / catalog.size))

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Filters Sidebar */}
          <aside className="md:w-1/4 lg:sticky lg:top-24 lg:self-start">
            <details open className="group md:open">
              <summary className="card mb-4 flex cursor-pointer select-none items-center justify-between px-5 py-4 font-semibold text-gray-900 md:hidden">
                Фільтри
                <span className="text-blue-600 transition-transform group-open:rotate-180">▾</span>
              </summary>
              <div className="hidden md:block mb-4" aria-hidden="true"></div>
            <CatalogFilters
              categories={categories}
              brands={brands}
              initial={{
                categorySlug: filters.categorySlug,
                brandSlug: filters.brandSlug,
                minPrice: filters.minPrice,
                maxPrice: filters.maxPrice,
                inStockOnly: filters.inStockOnly,
              }}
            />
            </details>
          </aside>

          {/* Products Grid */}
          <main className="md:w-3/4">
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
                <h2 className="text-xl font-bold">Каталог товарів</h2>
                <span className="text-sm text-gray-500">
                  Знайдено: {total}
                </span>
              </div>
              <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
                {hasActiveFilters && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-gray-400">
                      Фільтри:
                    </span>
                    {buildActiveChips(filters).map((chip) => (
                      <Link
                        key={chip.removeKey}
                        href={removeParamUrl(rawParams, chip.removeKey)}
                        className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                        aria-label={`Прибрати фільтр ${chip.label}`}
                      >
                        {chip.label}
                        <span aria-hidden className="ml-0.5">×</span>
                      </Link>
                    ))}
                    <Link
                      href="/catalog"
                      className="text-xs text-gray-500 underline hover:text-red-600"
                    >
                      Скинути всі
                    </Link>
                  </div>
                )}
                <Suspense fallback={null}>
                  <SortSelect />
                </Suspense>
              </div>

              {products.length === 0 ? (
                <EmptyState
                  icon="🔍"
                  title={
                    hasActiveFilters
                      ? 'Нічого не знайдено'
                      : 'Каталог поки що порожній'
                  }
                  description={
                    hasActiveFilters
                      ? 'Спробуйте змінити або скинути фільтри.'
                      : 'Товари з’являться тут незабаром.'
                  }
                  ctaHref={hasActiveFilters ? '/catalog' : undefined}
                  ctaLabel={hasActiveFilters ? 'Скинути фільтри' : undefined}
                />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                  {products.map((product) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      imageUrl={getMainPublicImageUrl(product.images)}
                    />
                  ))}
                </div>
              )}

              {/* Pagination */}
              {maxPage > 1 && (
                <nav className="mt-6 flex items-center justify-center gap-3">
                  {page > 1 ? (
                    <Link
                      href={catalogPageUrl(rawParams, page - 1)}
                      className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
                    >
                      ← Назад
                    </Link>
                  ) : (
                    <span className="px-4 py-2 border border-gray-200 rounded-md text-sm text-gray-300 cursor-not-allowed">
                      ← Назад
                    </span>
                  )}
                  <span className="text-sm text-gray-600">
                    Страница {page} из {maxPage}
                    <span className="text-gray-400"> · найдено {total}</span>
                  </span>
                  {page < maxPage ? (
                    <Link
                      href={catalogPageUrl(rawParams, page + 1)}
                      className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Далі →
                    </Link>
                  ) : (
                    <span className="px-4 py-2 border border-gray-200 rounded-md text-sm text-gray-300 cursor-not-allowed">
                      Далі →
                    </span>
                  )}
                </nav>
              )}
            </div>
          </main>
        </div>
      </div>

      <SiteFooter categories={categories} />
    </div>
  )
}
