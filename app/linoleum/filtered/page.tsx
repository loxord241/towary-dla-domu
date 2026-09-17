import type { Metadata } from 'next'
import {
  fetchLinoleumProducts,
  fetchActiveCategories,
  CATALOG_PAGE_SIZE,
  type CatalogSort,
} from '@/app/lib/catalog'
import { buildLinoleumMetadata } from '@/app/lib/seo'
import { LINOLEUM_WIDTHS_M } from '@/app/lib/linoleum/parse'
import LinoleumStorefront from '../Storefront'

/**
 * Dynamic twin of /linoleum (mirror of the /oboi split, linoleum vertical
 * batch 2, task L4, 2026-09-17).
 *
 * This route is NEVER linked and NEVER cached: proxy.ts rewrites every
 * query-carrying /linoleum?… request here (the browser URL is unchanged),
 * because the ISR cache key of /linoleum is the pathname alone — ?page/
 * ?width/?sort views must render per request to keep their content AND
 * their noindex,follow robots metadata (buildLinoleumMetadata). Direct
 * visits without a query render the pure view dynamically;
 * buildLinoleumMetadata still emits canonical /linoleum, so such a URL
 * canonicalizes away.
 *
 * ?width= whitelist (linoleum-vertical KEY contract): the query may carry
 * ONLY a LINOLEUM_WIDTHS_M value — the jsonb contains literal is built
 * through formatWidthM (import-plan canon) from a RESOLVED number, so junk
 * can never fabricate a filter that would silently miss every row. Junk
 * still noindexes the view via the RAW param (a filter VALUE on an
 * existing resource, same policy as /oboi ?base=), it just filters nothing.
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

/** ANY present ?width= value (junk/empty included) must noindex — filter
    values on an existing resource, same policy as the catalog slugs and
    /oboi ?base=. */
function rawWidthParamOf(rawParams: {
  width?: string | string[];
}): string | undefined {
  return rawParams.width !== undefined ? firstParam(rawParams.width) : undefined;
}

/** Whitelist = the importer's width grid: only a resolved LINOLEUM_WIDTHS_M
    value may reach the query (the contains literal is formatWidthM-built);
    unknown values resolve to «no filter», not to an honest-zero query. */
const WIDTH_SET: ReadonlySet<number> = new Set<number>(LINOLEUM_WIDTHS_M);

function widthValueOf(rawWidth: string | undefined): string | undefined {
  if (rawWidth === undefined) return undefined;
  const n = Number(rawWidth);
  return WIDTH_SET.has(n) ? String(n) : undefined;
}

/** ?sort= whitelist; ABSENT → 'name_asc' — the DEFAULT linoleum order is
    alphabetical (the /oboi contract), so the bare canonical /linoleum is
    the sorted view. 'newest' = the in-stock-first contract, same as
    catalog. */
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

/** Indexable with canonical /linoleum on page 1; deeper pages and
    width-filtered/sorted views are noindex,follow duplicates (same policy
    as catalog and /oboi — seo.ts). */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const rawParams = await searchParams;
  return buildLinoleumMetadata(
    parsePageParam(rawParams.page),
    rawWidthParamOf(rawParams),
    sortParamOf(rawParams)
  );
}

export default async function LinoleumFilteredPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const rawParams = await searchParams;
  const page = parsePageParam(rawParams.page);
  const rawWidth = rawWidthParamOf(rawParams);
  const width = widthValueOf(rawWidth);
  const sortParam = sortParamOf(rawParams);

  const [catalog, categories] = await Promise.all([
    fetchLinoleumProducts({
      page,
      size: CATALOG_PAGE_SIZE,
      // The whitelist resolved a number (or undefined) — the listing builds
      // the formatWidthM contains literal from it.
      width: width === undefined ? undefined : (Number(width) as (typeof LINOLEUM_WIDTHS_M)[number]),
      // Default (absent ?sort=) IS the alphabetical order.
      sort: (sortParam === '' ? 'name_asc' : sortParam) as CatalogSort,
    }),
    fetchActiveCategories(),
  ]);
  const maxPage = Math.max(1, Math.ceil(catalog.total / catalog.size));

  return (
    <LinoleumStorefront
      products={catalog.products}
      total={catalog.total}
      // Server returns the CLAMPED page — out-of-range requests render the
      // last real page instead of an empty grid (same contract as /catalog).
      currentPage={catalog.page}
      maxPage={maxPage}
      width={width}
      sortParam={sortParam}
      categories={categories}
    />
  )
}
