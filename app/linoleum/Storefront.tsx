import Link from 'next/link'
import type { CatalogCardProduct, Category } from '@/app/lib/catalog'
import { LINOLEUM_WIDTHS_M } from '@/app/lib/linoleum/parse'
import { formatWidthM } from '@/app/lib/linoleum/import-plan'
import { buildPageWindow } from '@/app/lib/pagination'
import { getMainPublicImageUrl } from '@/app/lib/supabase-storage'
import SiteHeader from '@/app/components/SiteHeader'
import SiteFooter from '@/app/components/SiteFooter'
import Announcements from '@/app/components/Announcements'
import ProductCard from '@/app/components/ProductCard'
import EmptyState from '@/app/components/EmptyState'
import { SearchIcon } from '@/app/components/icons'
import LinoleumSortSelect from './SortSelect'

/**
 * Shared server renderer for BOTH /linoleum routes (mirror of /oboi,
 * linoleum vertical batch 2, task L4, 2026-09-17):
 *  - /linoleum — the ISR-cached pure view (page 1, no ?width=, default
 *    alphabetical sort); revalidate 60, no searchParams anywhere;
 *  - /linoleum/filtered — the dynamic twin proxy.ts rewrites every
 *    query-carrying /linoleum?… request to (?page/?width/?sort), so
 *    filtered or paginated views render per request and keep their
 *    noindex,follow metadata (lib/seo.ts buildLinoleumMetadata).
 *
 * Markup and data flow are IDENTICAL to the /oboi storefront (OboiStorefront)
 * with one v1 difference: no wallpaper-FAQ copy exists for linoleum (the
 * showFaq gate has no counterpart yet). The BreadcrumbList JSON-LD is
 * emitted by the ISR page (app/linoleum/page.tsx) through ProductJsonLd —
 * owner review fix 2026-09-17, /brands pattern; the visible trail below
 * already mirrors the /oboi levels.
 */

/** Shared geometry with the /catalog pagination (P3-R2 pattern). */
const paginationControlClass =
  'px-4 py-2 rounded-md border border-gray-300 text-sm text-gray-700 transition-colors aria-disabled:border-gray-200 aria-disabled:text-gray-500 aria-disabled:cursor-not-allowed';

const pageNumberLinkClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-gray-300 px-2 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50';

const pageNumberCurrentClass =
  'inline-flex min-w-[44px] items-center justify-center rounded-md border border-blue-600 bg-blue-600 px-2 py-2 text-sm font-semibold text-white';

/** Filter chips reuse the oboi filter-chip look + an active state and the
    motion-reduce opt-out. */
const filterChipClass =
  'inline-flex items-center rounded-full border px-3 py-2 text-sm transition-colors motion-reduce:transition-none';
const filterChipActiveClass = 'border-blue-600 bg-blue-600 text-white';
const filterChipIdleClass =
  'border-gray-200 bg-gray-50 text-blue-700 hover:bg-blue-50';

/** Filter links reset to page 1 (a new filter = a new result set). The
    active sort is preserved — a filter narrows the SAME ordering. The chip
    value is the machine-readable dot form ('1.5'/'2'/'2.5'/'3'/'3.5'/'4');
    the LABEL is the importer's uk comma canon (formatWidthM). */
function linoleumFilterUrl(
  width: string | undefined,
  sort: string
): string {
  const params = new URLSearchParams();
  if (width !== undefined) params.set('width', width);
  if (sort !== '') params.set('sort', sort);
  const qs = params.toString();
  return qs !== '' ? `/linoleum?${qs}` : '/linoleum';
}

function linoleumPageUrl(
  targetPage: number,
  width: string | undefined,
  sort: string
): string {
  const params = new URLSearchParams();
  if (width !== undefined) params.set('width', width);
  if (sort !== '') params.set('sort', sort);
  if (targetPage > 1) params.set('page', String(targetPage));
  const qs = params.toString();
  return qs !== '' ? `/linoleum?${qs}` : '/linoleum';
}

export interface LinoleumStorefrontProps {
  products: CatalogCardProduct[];
  total: number;
  /** CLAMPED page the server actually rendered (same contract as /catalog). */
  currentPage: number;
  maxPage: number;
  /** Resolved width filter in the machine-readable dot form
      ('1.5'/'2'/'2.5'/'3'/'3.5'/'4'; undefined = all). */
  width: string | undefined;
  /** Resolved ?sort= value ('' = default alphabetical). */
  sortParam: string;
  categories: Category[];
}

export default function LinoleumStorefront({
  products,
  total,
  currentPage,
  maxPage,
  width,
  sortParam,
  categories,
}: LinoleumStorefrontProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <SiteHeader />
      <Announcements />

      <main className="container mx-auto px-4 py-8">
        {/* Visible trail, PDP style: Головна → Лінолеум (current page, not a
            link — mirrors the /oboi visible trail levels). */}
        <nav aria-label="Навігація" className="mb-5 text-sm text-gray-500">
          <Link href="/" className="hover:text-blue-600 hover:underline">
            Головна
          </Link>
          <span className="mx-1.5 text-gray-300">/</span>
          <span className="text-gray-900">Лінолеум</span>
        </nav>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="mb-2 flex items-baseline justify-between gap-4 flex-wrap">
            <h1 className="text-2xl font-bold">Лінолеум</h1>
            <span className="text-sm text-gray-500">Знайдено: {total}</span>
          </div>

          {/* Sort — default «Назва А–Я» (absent ?sort= IS alphabetical). */}
          <div className="mb-4 flex items-center gap-2 justify-end">
            <span className="text-sm text-gray-500">Сортування:</span>
            <LinoleumSortSelect />
          </div>

          {/* Width filter chips — server-filtered via a jsonb contains on
              products.specifications (the importer writes
              {name:'Ширина', value: formatWidthM(w)}; the QUERY literal is
              built through the same formatWidthM canon in
              app/lib/catalog/linoleum-listing.ts). Chip hrefs carry the
              machine-readable dot form; the labels render the uk comma
              format. */}
          <div className="mb-6">
            <p className="mb-2 text-sm font-medium text-gray-700">Ширина:</p>
            <ul className="flex flex-wrap gap-2">
              <li>
                <Link
                  href={linoleumFilterUrl(undefined, sortParam)}
                  aria-current={width === undefined ? 'true' : undefined}
                  className={`${filterChipClass} ${
                    width === undefined
                      ? filterChipActiveClass
                      : filterChipIdleClass
                  }`}
                >
                  Усі
                </Link>
              </li>
              {LINOLEUM_WIDTHS_M.map((value) => {
                const chipValue = String(value);
                return (
                  <li key={chipValue}>
                    <Link
                      href={linoleumFilterUrl(chipValue, sortParam)}
                      aria-current={width === chipValue ? 'true' : undefined}
                      className={`${filterChipClass} ${
                        width === chipValue
                          ? filterChipActiveClass
                          : filterChipIdleClass
                      }`}
                    >
                      {formatWidthM(value)} м
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>

          {products.length === 0 ? (
            <EmptyState
              icon={<SearchIcon className="h-10 w-10" />}
              title={
                width
                  ? 'За фільтром нічого не знайдено'
                  : 'Лінолеум з’явиться тут незабаром'
              }
              description={
                width
                  ? 'Спробуйте інше значення фільтра або натисніть «Усі», щоб скинути його.'
                  : 'Каталог лінолеуму поповнюється — загляньте трохи пізніше.'
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
                <Link href={linoleumPageUrl(currentPage - 1, width, sortParam)} className={paginationControlClass}>
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
                    className="px-1 text-sm text-gray-500"
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
                    href={linoleumPageUrl(item, width, sortParam)}
                    aria-label={`Сторінка ${item}`}
                    className={pageNumberLinkClass}
                  >
                    {item}
                  </Link>
                )
              )}
              <span className="hidden text-sm text-gray-600 sm:inline">
                Сторінка {currentPage} із {maxPage}
                <span className="text-gray-500"> · знайдено {total}</span>
              </span>
              {currentPage < maxPage ? (
                <Link href={linoleumPageUrl(currentPage + 1, width, sortParam)} className={paginationControlClass}>
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
