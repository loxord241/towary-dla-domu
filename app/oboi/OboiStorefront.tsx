import Link from 'next/link'
import type { CatalogCardProduct, Category } from '@/app/lib/catalog'
import { GLUE_CATEGORY_SLUG } from '@/app/lib/catalog'
import { WALLPAPER_CATEGORY_MAP } from '@/app/lib/wallpapers/categories'
import { WALLPAPER_BASE_VALUES } from '@/app/lib/wallpapers/filters'
import { buildPageWindow } from '@/app/lib/pagination'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import Announcements from '@/app/components/Announcements'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'
import PaginationNav from '@/app/components/PaginationNav'
import { SearchIcon } from '@/app/components/icons'
import ProductJsonLd from '@/app/components/ProductJsonLd'
import FaqJsonLd from '@/app/components/FaqJsonLd'
import FaqSection from '@/app/components/FaqSection'
import { buildOboiBreadcrumbJsonLd } from '@/app/lib/schema-org'
import { WALLPAPER_FAQ } from '@/app/lib/faq-content'
import OboiSortSelect from './SortSelect'

/**
 * Shared server renderer for BOTH /oboi routes (ISR split, perf/SEO audit
 * 2026-09-14):
 *  - /oboi — the ISR-cached pure view (page 1, no ?base=, default
 *    alphabetical sort); revalidate 60, no searchParams anywhere;
 *  - /oboi/filtered — the dynamic twin proxy.ts rewrites every
 *    query-carrying /oboi?… request to (?page/?base/?sort), so filtered or
 *    paginated views render per request and keep their noindex,follow
 *    metadata (lib/seo.ts buildWallpapersMetadata — unchanged there).
 *
 * Markup and data flow are IDENTICAL; only the prop values differ. The
 * structured data lives here too: BreadcrumbList (Головна → Шпалери) on
 * every view — harmless on noindex views, exactly like the catalog's
 * category breadcrumb — and the FAQ block + FAQPage JSON-LD ONLY on the
 * indexable view (showFaq), so noindex duplicates never carry the copy.
 */

/** Subcategory chips are the canonical importer list — one source of truth
    with the /catalog wallpaper-scoped views (shpaleri-*). */
const WALLPAPER_SUBCATEGORIES = Object.values(WALLPAPER_CATEGORY_MAP);

/** Shared geometry with the /catalog pagination (P3-R2 pattern). */
const paginationControlClass =
  'px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 transition-colors aria-disabled:border-gray-200 aria-disabled:text-gray-500 aria-disabled:cursor-not-allowed';

const pageNumberLinkClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50';

const pageNumberCurrentClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-blue-600 bg-blue-600 px-2 py-2 text-sm font-semibold text-white';

/** Filter chips reuse the subcategory-chip look + an active state and the
    motion-reduce opt-out (owner task 2026-09-11). */
const filterChipClass =
  'inline-flex items-center rounded-full border px-3 py-2 text-sm transition-colors motion-reduce:transition-none';
const filterChipActiveClass = 'border-blue-600 bg-blue-600 text-white';
const filterChipIdleClass =
  'border-gray-200 bg-gray-50 text-blue-700 hover:bg-blue-50';

/** Filter links reset to page 1 (a new filter = a new result set). The
    active sort is preserved — a filter narrows the SAME ordering. */
function oboiFilterUrl(base: string | undefined, sort: string): string {
  const params = new URLSearchParams();
  if (base) params.set('base', base);
  if (sort !== '') params.set('sort', sort);
  const qs = params.toString();
  return qs !== '' ? `/oboi?${qs}` : '/oboi';
}

function oboiPageUrl(
  targetPage: number,
  base: string | undefined,
  sort: string
): string {
  const params = new URLSearchParams();
  if (base) params.set('base', base);
  if (sort !== '') params.set('sort', sort);
  if (targetPage > 1) params.set('page', String(targetPage));
  const qs = params.toString();
  return qs !== '' ? `/oboi?${qs}` : '/oboi';
}

export interface OboiStorefrontProps {
  products: CatalogCardProduct[];
  total: number;
  /** CLAMPED page the server actually rendered (same contract as /catalog). */
  currentPage: number;
  maxPage: number;
  /** Resolved «Основа» filter value (undefined = all). */
  base: string | undefined;
  /** Resolved ?sort= value ('' = default alphabetical). */
  sortParam: string;
  /**
   * FAQ gate (SEO package 2026-09-14): the visible «Часті питання» block
   * AND its FaqJsonLd render only on the indexable view — page 1 with no
   * ?base= and no explicit ?sort= (the same conditions
   * buildWallpapersMetadata uses for index,follow + canonical /oboi). The
   * ISR /oboi route IS that view (constant true); the filtered twin passes
   * the mirrored predicate so noindex duplicates never carry the copy.
   */
  showFaq: boolean;
  categories: Category[];
}

export default function OboiStorefront({
  products,
  total,
  currentPage,
  maxPage,
  base,
  sortParam,
  showFaq,
  categories,
}: OboiStorefrontProps) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const breadcrumbJsonLd = buildOboiBreadcrumbJsonLd(siteUrl);

  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <Announcements />
      {/* BreadcrumbList for the storefront — ProductJsonLd is the sanctioned
          JSON-LD script sink (same serializeJsonLd escaping). */}
      <ProductJsonLd data={breadcrumbJsonLd} />
      {/* FAQPage structured data — ONLY on the indexable view, mirroring
          the visible FaqSection inside the card below. */}
      {showFaq && <FaqJsonLd questions={WALLPAPER_FAQ} />}

      <main className="container mx-auto px-4 py-8">
        {/* Visible trail, PDP style: Головна → Шпалери (current page, not a
            link — the BreadcrumbList JSON-LD above mirrors these levels). */}
        <nav aria-label="Навігація" className="mb-5 text-sm text-gray-500">
          <Link href="/" className="hover:text-blue-600 hover:underline">
            Головна
          </Link>
          <span className="mx-1.5 text-gray-300">/</span>
          <span className="text-gray-900">Шпалери</span>
        </nav>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
            <h1 className="text-2xl font-bold">Шпалери</h1>
            <span className="text-sm text-gray-500">Знайдено: {total}</span>
          </div>

          {/* Sort — default «Назва А–Я» (absent ?sort= IS alphabetical). */}
          <div className="mb-4 flex items-center gap-2 justify-end">
            <span className="text-sm text-gray-500">Сортування:</span>
            <OboiSortSelect />
          </div>


          {/* Subcategory chips — deep links into the wallpaper-scoped
              /catalog views (shpaleri-*), which render the same wc-*
              domain. One source of truth: the importer's category map.
              The glue chip (owner 2026-09-13) targets its own category —
              a GENERAL catalog view (wc-* stay excluded there, gl-* shown). */}
          <ul className="mb-6 flex flex-wrap gap-2">
            {WALLPAPER_SUBCATEGORIES.map((subcategory) => (
              <li key={subcategory.slug}>
                <Link
                  // Path form (SEO package 2026-09-13): legacy query-form
                  // category URLs only 308-redirect — link straight to the path.
                  href={`/catalog/${encodeURIComponent(subcategory.slug)}`}
                  className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-blue-700 transition hover:bg-blue-50"
                >
                  {subcategory.name}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href={`/catalog/${encodeURIComponent(GLUE_CATEGORY_SLUG)}`}
                className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-blue-700 transition hover:bg-blue-50"
              >
                Клеї для шпалер
              </Link>
            </li>
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
                  href={oboiFilterUrl(undefined, sortParam)}
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
                    href={oboiFilterUrl(value, sortParam)}
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
            <div
              className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6"
              id="catalog-products"
            >
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

          {/* Pagination — the shared client component (owner P1 fix
              2026-09-18): document navigation (isSortDocumentNavigation
              precedent — soft nav loses to the ISR segment-cache race),
              pre-unload grid dimming for instant click feedback. URL logic
              stays here (P3-R2): oboiPageUrl for prev/next/numbers through
              buildPageWindow. */}
          {maxPage > 1 && (
            <PaginationNav
              prevHref={
                currentPage > 1
                  ? oboiPageUrl(currentPage - 1, base, sortParam)
                  : null
              }
              nextHref={
                currentPage < maxPage
                  ? oboiPageUrl(currentPage + 1, base, sortParam)
                  : null
              }
              items={buildPageWindow(currentPage, maxPage).map((item) =>
                item === 'ellipsis'
                  ? { kind: 'ellipsis' as const }
                  : {
                      kind: 'page' as const,
                      page: item,
                      href: oboiPageUrl(item, base, sortParam),
                    }
              )}
              currentPage={currentPage}
              anchorId="catalog-products"
              controlClassName={paginationControlClass}
              pageLinkClassName={pageNumberLinkClass}
              currentPageClassName={pageNumberCurrentClass}
              ellipsisClassName="px-1 text-sm text-gray-500"
              status={
                <span className="hidden text-sm text-gray-600 sm:inline">
                  Сторінка {currentPage} із {maxPage}
                  <span className="text-gray-500"> · знайдено {total}</span>
                </span>
              }
            />
          )}

          {/* «Часті питання» — ONLY on the indexable view (showFaq gate
              above); mirrors FaqJsonLd at the top of the tree. */}
          {showFaq && <FaqSection />}
        </div>
      </main>

      <SiteFooter categories={categories} />
    </div>
  )
}
