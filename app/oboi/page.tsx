import Link from 'next/link'
import type { Metadata } from 'next'
import {
  fetchWallpaperProducts,
  fetchActiveCategories,
  CATALOG_PAGE_SIZE,
} from '@/app/lib/catalog'
import { buildWallpapersMetadata } from '@/app/lib/seo'
import { WALLPAPER_CATEGORY_MAP } from '@/app/lib/wallpapers/categories'
import { WALLPAPER_BASE_VALUES } from '@/app/lib/wallpapers/filters'
import { buildPageWindow } from '@/app/lib/pagination'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import Announcements from '@/app/components/Announcements'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'
import { SearchIcon } from '@/app/components/icons'

// Wallpapers storefront (owner task 2026-09-10): /oboi renders ONLY the
// wc-* domain (fetchWallpaperProducts) — the general /catalog excludes it.
// Like /catalog the route reads searchParams (?page=N), so it renders
// dynamically per request; there is deliberately NO search UI in v1 and the
// subcategory chips deep-link into /catalog?category=shpaleri-* views
// (fetchCatalogProducts keeps the wallpaper domain for exactly those views).

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function parsePageParam(raw: string | string[] | undefined): number {
  const n = Number(firstParam(raw));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

/** Subcategory chips are the canonical importer list — one source of truth
    with the /catalog wallpaper-scoped views (shpaleri-*). */
const WALLPAPER_SUBCATEGORIES = Object.values(WALLPAPER_CATEGORY_MAP);

/** Shared geometry with the /catalog pagination (P3-R2 pattern). */
const paginationControlClass =
  'px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 transition-colors aria-disabled:border-gray-200 aria-disabled:text-gray-400 aria-disabled:cursor-not-allowed';

const pageNumberLinkClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50';

const pageNumberCurrentClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-blue-600 bg-blue-600 px-2 py-2 text-sm font-semibold text-white';

/** Filter chips reuse the subcategory-chip look + an active state and the
    motion-reduce opt-out (owner task 2026-09-11). */
const filterChipClass =
  'inline-flex items-center rounded-full border px-3 py-1 text-sm transition-colors motion-reduce:transition-none';
const filterChipActiveClass = 'border-blue-600 bg-blue-600 text-white';
const filterChipIdleClass =
  'border-gray-200 bg-gray-50 text-blue-700 hover:bg-blue-50';

/** Filter links reset to page 1 (a new filter = a new result set). */
function oboiFilterUrl(base: string | undefined): string {
  return base ? `/oboi?base=${encodeURIComponent(base)}` : '/oboi';
}

function oboiPageUrl(targetPage: number, base: string | undefined): string {
  const params = new URLSearchParams();
  if (base) params.set('base', base);
  if (targetPage > 1) params.set('page', String(targetPage));
  const qs = params.toString();
  return qs !== '' ? `/oboi?${qs}` : '/oboi';
}

/** ANY present ?base= value (junk/empty included) must noindex — filter
    values on an existing resource, same policy as the catalog slugs. */
function baseParamOf(rawParams: {
  base?: string | string[];
}): string | undefined {
  return rawParams.base !== undefined ? firstParam(rawParams.base) : undefined;
}

/** Whitelist is for the CHIPS; the query itself takes the raw exact value
    (PostgREST contains is parameterized, unknown values → honest 0 rows). */
function baseValueOf(rawBase: string | undefined): string | undefined {
  return rawBase && rawBase.trim() !== '' ? rawBase : undefined;
}

/** Indexable with canonical /oboi on page 1; deeper pages and spec-filtered
    views are noindex,follow duplicates (same policy as catalog — seo.ts). */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams
}): Promise<Metadata> {
  const rawParams = await searchParams;
  return buildWallpapersMetadata(
    parsePageParam(rawParams.page),
    baseParamOf(rawParams)
  );
}

export default async function OboiPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const rawParams = await searchParams;
  const page = parsePageParam(rawParams.page);
  const base = baseValueOf(baseParamOf(rawParams));

  const [catalog, categories] = await Promise.all([
    fetchWallpaperProducts({ page, size: CATALOG_PAGE_SIZE, base }),
    fetchActiveCategories(),
  ]);
  const products = catalog.products;
  const total = catalog.total;
  // Server returns the CLAMPED page — out-of-range requests render the last
  // real page instead of an empty grid (same contract as /catalog).
  const currentPage = catalog.page;
  const maxPage = Math.max(1, Math.ceil(total / catalog.size));

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <Announcements />

      <main className="container mx-auto px-4 py-8">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
            <h1 className="text-2xl font-bold">Шпалери</h1>
            <span className="text-sm text-gray-500">Знайдено: {total}</span>
          </div>

          {/* Subcategory chips — deep links into the wallpaper-scoped
              /catalog views (shpaleri-*), which render the same wc-*
              domain. One source of truth: the importer's category map. */}
          <ul className="mb-6 flex flex-wrap gap-2">
            {WALLPAPER_SUBCATEGORIES.map((subcategory) => (
              <li key={subcategory.slug}>
                <Link
                  href={`/catalog?category=${encodeURIComponent(subcategory.slug)}`}
                  className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-sm text-blue-700 transition hover:bg-blue-50"
                >
                  {subcategory.name}
                </Link>
              </li>
            ))}
          </ul>

          {/* Основа filter chips — server-filtered via a jsonb contains on
              products.specifications (exact value, count+data). One filter
              dimension in v1: «Приміщення» stays deferred — its comma-joined
              values cannot substring-match in PostgREST
              (app/lib/wallpapers/filters.ts). */}
          <div className="mb-6">
            <p className="mb-2 text-sm font-medium text-gray-700">Основа:</p>
            <ul className="flex flex-wrap gap-2">
              <li>
                <Link
                  href={oboiFilterUrl(undefined)}
                  aria-current={base === undefined ? 'true' : undefined}
                  className={`${filterChipClass} ${
                    base === undefined
                      ? filterChipActiveClass
                      : filterChipIdleClass
                  }`}
                >
                  Усі
                </Link>
              </li>
              {WALLPAPER_BASE_VALUES.map((value) => (
                <li key={value}>
                  <Link
                    href={oboiFilterUrl(value)}
                    aria-current={base === value ? 'true' : undefined}
                    className={`${filterChipClass} ${
                      base === value ? filterChipActiveClass : filterChipIdleClass
                    }`}
                  >
                    {value}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {products.length === 0 ? (
            <EmptyState
              icon={<SearchIcon className="h-10 w-10" />}
              title={
                base
                  ? 'За фільтром нічого не знайдено'
                  : 'Шпалери з’являться тут незабаром'
              }
              description={
                base
                  ? 'Спробуйте інше значення фільтра або натисніть «Усі», щоб скинути його.'
                  : 'Каталог шпалер поповнюється щодня — загляньте трохи пізніше.'
              }
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

          {/* Pagination — same geometry and aria-disabled contract as the
              /catalog controls (P3-R2). */}
          {maxPage > 1 && (
            <nav className="mt-6 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
              {currentPage > 1 ? (
                <Link href={oboiPageUrl(currentPage - 1, base)} className={paginationControlClass}>
                  ← Назад
                </Link>
              ) : (
                <span aria-disabled="true" className={paginationControlClass}>
                  ← Назад
                </span>
              )}
              {buildPageWindow(currentPage, maxPage).map((item, idx) =>
                item === 'ellipsis' ? (
                  <span
                    key={`gap-${idx}`}
                    aria-hidden="true"
                    className="px-1 text-sm text-gray-400"
                  >
                    …
                  </span>
                ) : item === currentPage ? (
                  <span
                    key={`page-${item}`}
                    aria-current="page"
                    className={pageNumberCurrentClass}
                  >
                    {item}
                  </span>
                ) : (
                  <Link
                    key={`page-${item}`}
                    href={oboiPageUrl(item, base)}
                    aria-label={`Сторінка ${item}`}
                    className={pageNumberLinkClass}
                  >
                    {item}
                  </Link>
                )
              )}
              <span className="text-sm text-gray-600">
                Сторінка {currentPage} із {maxPage}
                <span className="text-gray-400"> · знайдено {total}</span>
              </span>
              {currentPage < maxPage ? (
                <Link href={oboiPageUrl(currentPage + 1, base)} className={paginationControlClass}>
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

      <SiteFooter categories={categories} />
    </div>
  )
}
