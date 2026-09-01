import Link from 'next/link'
import { Suspense } from 'react'
import type { Metadata } from 'next'
import {
  fetchCatalogProducts,
  fetchActiveCategories,
  fetchActiveBrands,
  fetchCategoryBySlug,
  fetchBrandBySlug,
  type CatalogFilters as CatalogFilterOptions,
  type CatalogSort,
} from '@/app/lib/catalog'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import { buildCatalogViewMetadata } from '@/app/lib/seo'
import {
  fetchCategoryProductCount,
  fetchBrandProductCount,
} from '@/app/lib/catalog'
import {
  getCategorySeo,
  applyCategorySeoMetadata,
  listDirectChildren,
} from '@/app/lib/category-seo'
import {
  buildCatalogBreadcrumbJsonLd,
} from '@/app/lib/schema-org'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import ProductJsonLd from '@/app/components/ProductJsonLd'
import SearchViewTracker from '@/app/components/SearchViewTracker'
import CatalogFilters from './CatalogFilters'
import SortSelect from './SortSelect'
import { CATALOG_PAGE_SIZE } from '@/app/lib/catalog'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'
import { SearchIcon } from '@/app/components/icons'

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

/** Shared geometry for prev/next; the disabled span only drops hover. */
const paginationControlClass =
  'px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 transition-colors aria-disabled:border-gray-200 aria-disabled:text-gray-400 aria-disabled:cursor-not-allowed';

function buildActiveChips(
  filters: CatalogFilterOptions,
  names: { categoryName?: string; brandName?: string }
): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (filters.search) chips.push({ label: `«${filters.search}»`, removeKey: 'q' });
  if (filters.categorySlug) {
    chips.push({
      label: `Категорія: ${names.categoryName ?? filters.categorySlug}`,
      removeKey: 'category',
    });
  }
  if (filters.brandSlug) {
    chips.push({
      label: `Бренд: ${names.brandName ?? filters.brandSlug}`,
      removeKey: 'brand',
    });
  }
  if (filters.minPrice !== undefined) chips.push({ label: `від ${filters.minPrice} ₴`, removeKey: 'min' });
  if (filters.maxPrice !== undefined) chips.push({ label: `до ${filters.maxPrice} ₴`, removeKey: 'max' });
  if (filters.inStockOnly) chips.push({ label: 'Тільки в наявності', removeKey: 'stock' });
  return chips;
}

/** H1 for the current catalog view (exactly one h1 per page). */
function catalogHeading(
  filters: CatalogFilterOptions,
  names: { categoryName?: string; brandName?: string },
  h1Override?: string
): string {
  if (filters.search) return `Пошук: «${filters.search}»`;
  if (filters.categorySlug && names.categoryName) return h1Override ?? names.categoryName;
  if (filters.brandSlug && names.brandName) return `Бренд ${names.brandName}`;
  return 'Каталог товарів';
}

/** Unique per-view metadata built from real page data (no invented SEO copy).
 *  Canonical/noindex decisions live in lib/seo.ts (single tested policy). */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams
}): Promise<Metadata> {
  const rawParams = await searchParams;
  const { filters } = parseCatalogSearchParams(rawParams);

  const [category, brand] = await Promise.all([
    filters.categorySlug ? fetchCategoryBySlug(filters.categorySlug) : null,
    filters.brandSlug ? fetchBrandBySlug(filters.brandSlug) : null,
  ]);

  // Task #14 (2026-09): an EMPTY view (0 eligible products) is noindex'd.
  // The fact comes from the SAME count shapes the grid uses
  // (fetchCategoryProductCount/fetchBrandProductCount); a read failure
  // degrades to «has products» so a transient error can never noindex a
  // full page (the decision itself stays in lib/seo.ts).
  const [categoryCount, brandCount] = await Promise.all([
    category && filters.categorySlug
      ? fetchCategoryProductCount(filters.categorySlug).catch(() => null)
      : Promise.resolve(null),
    brand && filters.brandSlug
      ? fetchBrandProductCount(filters.brandSlug).catch(() => null)
      : Promise.resolve(null),
  ]);

  // SEO copy override (category-seo.ts) touches ONLY title/description —
  // the indexability/canonical decision from buildCatalogViewMetadata stays.
  return applyCategorySeoMetadata(
    buildCatalogViewMetadata({
      input: {
        search: filters.search,
        categorySlug: filters.categorySlug,
        brandSlug: filters.brandSlug,
        categoryFound: category !== null,
        brandFound: brand !== null,
        categoryHasProducts: category && categoryCount === 0 ? false : undefined,
        brandHasProducts: brand && brandCount === 0 ? false : undefined,
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
        inStockOnly: filters.inStockOnly,
        sort: filters.sort,
        page: filters.page,
      },
      categoryName: category?.name,
      brandName: brand?.name,
    }),
    filters.categorySlug
  );
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

  // Display names resolved from the same dictionaries that feed the filter
  // dropdowns — chips and H1 must show «Склокерамічні», not a raw slug.
  const categoryName = filters.categorySlug
    ? categories.find((c) => c.slug === filters.categorySlug)?.name
    : undefined;
  const brandName = filters.brandSlug
    ? brands.find((b) => b.slug === filters.brandSlug)?.name
    : undefined;
  const names = { categoryName, brandName };
  const chips = buildActiveChips(filters, names);

  // Category-level SEO (category-seo.ts): intent copy + subcategory links
  // only for a pure category view (no search). Children are sliced from the
  // already-fetched active list — no extra DB reads.
  const seo =
    !filters.search && filters.categorySlug
      ? getCategorySeo(filters.categorySlug)
      : null;
  const activeCategory = filters.categorySlug
    ? categories.find((c) => c.slug === filters.categorySlug)
    : undefined;
  const childCategories =
    seo && activeCategory ? listDirectChildren(categories, activeCategory.id) : [];
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const breadcrumbJsonLd = activeCategory
    ? buildCatalogBreadcrumbJsonLd(
        { name: activeCategory.name, slug: activeCategory.slug },
        siteUrl
      )
    : null;
  const heading = catalogHeading(filters, names, seo?.h1);

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      {/* BreadcrumbList for category views — ProductJsonLd is the sanctioned
          JSON-LD script sink (same serializeJsonLd escaping). */}
      <ProductJsonLd data={breadcrumbJsonLd} />
      {/* Anonymous search analytics: rendered only when a search term is
          applied; the tracker sanitizes the term (PII guard) before firing. */}
      <SearchViewTracker query={filters.search} />

      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Filters Sidebar — mobile opens it as a sheet behind a
              «Фільтри» button; desktop (md+) keeps it always open */}
          <aside className="md:w-1/4 lg:sticky lg:top-24 lg:self-start">
            <Suspense fallback={<div className="card mb-4 h-14 md:h-40" aria-hidden />}>
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
                activeCount={chips.length}
              />
            </Suspense>
          </aside>

          {/* Products Grid */}
          <main className="md:w-3/4">
            <div className="bg-white rounded-lg shadow p-6 mb-6">
              <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
                <h1 className="text-xl font-bold">{heading}</h1>
                <span className="text-sm text-gray-500">
                  Знайдено: {total}
                </span>
              </div>

              {/* Unique category intro + crawlable subcategory links
                  (pinned category only — see app/lib/category-seo.ts). */}
              {seo && (
                <div className="mb-6 text-sm leading-relaxed text-gray-600">
                  {seo.intro.map((paragraph) => (
                    <p key={paragraph.slice(0, 24)} className="mb-2">
                      {paragraph}
                    </p>
                  ))}
                  {childCategories.length > 0 && (
                    <>
                      <h2 className="mb-2 mt-4 text-lg font-bold text-gray-900">
                        {seo.introHeading}
                      </h2>
                      <ul className="flex flex-wrap gap-2">
                        {childCategories.map((child) => (
                          <li key={child.id}>
                            <Link
                              href={`/catalog?category=${encodeURIComponent(child.slug)}`}
                              className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-sm text-blue-700 transition hover:bg-blue-50"
                            >
                              {child.name}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
                {hasActiveFilters && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs uppercase tracking-wide text-gray-400">
                      Фільтри:
                    </span>
                    {chips.map((chip) => (
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
                  icon={<SearchIcon className="h-10 w-10" />}
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
                  {products.map((product, idx) => (
                    <ProductCard
                      key={product.id}
                      product={product}
                      imageUrl={getMainPublicImageUrl(product.images)}
                      eager={idx < 6}
                    />
                  ))}
                </div>
              )}

              {/* Pagination — both controls share one geometry; the inactive
                  side is a span with aria-disabled (not focusable, announced
                  as unavailable) so keyboard order and semantics stay correct
                  without touching URL/clamp logic (P3-R2). */}
              {maxPage > 1 && (
                <nav className="mt-6 flex items-center justify-center gap-3">
                  {page > 1 ? (
                    <Link
                      href={catalogPageUrl(rawParams, page - 1)}
                      className={paginationControlClass}
                    >
                      ← Назад
                    </Link>
                  ) : (
                    <span aria-disabled="true" className={paginationControlClass}>
                      ← Назад
                    </span>
                  )}
                  <span className="text-sm text-gray-600">
                    Сторінка {page} із {maxPage}
                    <span className="text-gray-400"> · знайдено {total}</span>
                  </span>
                  {page < maxPage ? (
                    <Link
                      href={catalogPageUrl(rawParams, page + 1)}
                      className={paginationControlClass}
                    >
                      Далі →
                    </Link>
                  ) : (
                    <span aria-disabled="true" className={paginationControlClass}>
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
