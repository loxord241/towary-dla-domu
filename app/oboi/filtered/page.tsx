import type { Metadata } from 'next'
import {
  fetchWallpaperProducts,
  fetchActiveCategories,
  CATALOG_PAGE_SIZE,
  type CatalogSort,
} from '@/app/lib/catalog'
import { buildWallpapersMetadata } from '@/app/lib/seo'
import OboiStorefront from '../OboiStorefront'

/**
 * Dynamic twin of /oboi (ISR split, perf/SEO audit 2026-09-14).
 *
 * This route is NEVER linked and NEVER cached: proxy.ts rewrites every
 * query-carrying /oboi?… request here (the browser URL is unchanged),
 * because the ISR cache key of /oboi is the pathname alone — ?page/?base/
 * ?sort views must render per request to keep their content AND their
 * noindex,follow robots metadata (buildWallpapersMetadata). Direct visits
 * without a query render the pure view dynamically; buildWallpapersMetadata
 * still emits canonical /oboi, so such a URL canonicalizes away.
 *
 * The rendering and metadata logic is byte-for-byte the pre-ISR /oboi page.
 * The FAQ gate mirrors the metadata indexability conditions exactly:
 * page 1 + no ?base= (any raw value, junk included) + no explicit ?sort=.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function parsePageParam(raw: string | string[] | undefined): number {
  const n = Number(firstParam(raw));
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
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

/** ?sort= whitelist; ABSENT → 'name_asc' — the DEFAULT wallpaper order is
    alphabetical (owner 2026-09-12), so the bare canonical /oboi is the
    sorted view. 'newest' = the in-stock-first contract, same as catalog. */
const SORT_VALUES: readonly CatalogSort[] = [
  'newest',
  'price_asc',
  'price_desc',
  'name_asc',
];

function sortParamOf(rawParams: { sort?: string | string[] }): string {
  const raw = firstParam(rawParams.sort);
  return SORT_VALUES.includes(raw as CatalogSort) ? raw : '';
}

/** Indexable with canonical /oboi on page 1; deeper pages and spec-filtered
    views are noindex,follow duplicates (same policy as catalog — seo.ts). */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const rawParams = await searchParams;
  return buildWallpapersMetadata(
    parsePageParam(rawParams.page),
    baseParamOf(rawParams),
    sortParamOf(rawParams)
  );
}

export default async function OboiFilteredPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const rawParams = await searchParams;
  const page = parsePageParam(rawParams.page);
  const rawBase = baseParamOf(rawParams);
  const base = baseValueOf(rawBase);
  const sortParam = sortParamOf(rawParams);

  const [catalog, categories] = await Promise.all([
    fetchWallpaperProducts({
      page,
      size: CATALOG_PAGE_SIZE,
      base,
      // Default (absent ?sort=) IS the alphabetical order.
      sort: (sortParam === '' ? 'name_asc' : sortParam) as CatalogSort,
    }),
    fetchActiveCategories(),
  ]);
  const maxPage = Math.max(1, Math.ceil(catalog.total / catalog.size));

  return (
    <OboiStorefront
      products={catalog.products}
      total={catalog.total}
      // Server returns the CLAMPED page — out-of-range requests render the
      // last real page instead of an empty grid (same contract as /catalog).
      currentPage={catalog.page}
      maxPage={maxPage}
      base={base}
      sortParam={sortParam}
      // FAQ only on the indexable view — the SAME conditions
      // buildWallpapersMetadata uses for index,follow: page 1, no ?base=
      // at all (junk included), no explicit ?sort=.
      showFaq={page === 1 && rawBase === undefined && sortParam === ''}
      categories={categories}
    />
  )
}
