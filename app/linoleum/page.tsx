import type { Metadata } from 'next'
import {
  fetchLinoleumProducts,
  fetchActiveCategories,
  CATALOG_PAGE_SIZE,
  type CatalogSort,
} from '@/app/lib/catalog'
import { buildLinoleumMetadata } from '@/app/lib/seo'
import LinoleumStorefront from './Storefront'

// Linoleum storefront (linoleum vertical, batch 2, task L4, 2026-09-17):
// /linoleum renders ONLY the ln-* domain (fetchLinoleumProducts) — the
// mirror of the /oboi ISR split.
//
// ISR (perf/SEO audit 2026-09-14 pattern): this route IS the indexable pure
// view — page 1, no ?width=, default alphabetical sort — and reads NO
// searchParams, so `revalidate = 60` keeps the whole HTML (metadata
// included) in the ISR cache. Every query-carrying request
// (?page/?width/?sort) is rewritten by proxy.ts (linoleumFilteredRewrite)
// to the dynamic twin app/linoleum/filtered/page.tsx BEFORE routing: an ISR
// cache key is the pathname alone, so without the rewrite a ?page=2 request
// would be served this cached page-1 HTML with the wrong robots. The twin
// keeps per-request rendering and the noindex,follow contract.

// On-demand ISR, same shape as /oboi: the bare path prerenders at build and
// revalidates every 60s.
export const revalidate = 60;

// The pure view IS the indexable view: index,follow + canonical /linoleum
// with the same copy (lib/seo.ts). Reading searchParams here (even just for
// the noindex branch) would opt the whole route into dynamic rendering and
// disable the cache — the proxy rewrite guarantees no query ever arrives.
export async function generateMetadata(): Promise<Metadata> {
  return buildLinoleumMetadata();
}

export default async function LinoleumPage() {
  // Pure-view defaults: page 1, no width filter, alphabetical order
  // (absent ?sort= IS name_asc — the /oboi contract).
  const [catalog, categories] = await Promise.all([
    fetchLinoleumProducts({
      page: 1,
      size: CATALOG_PAGE_SIZE,
      width: undefined,
      sort: 'name_asc' as CatalogSort,
    }),
    fetchActiveCategories(),
  ]);
  const maxPage = Math.max(1, Math.ceil(catalog.total / catalog.size));

  return (
    <LinoleumStorefront
      products={catalog.products}
      total={catalog.total}
      // The server-clamped page for a page-1 request is always 1.
      currentPage={catalog.page}
      maxPage={maxPage}
      width={undefined}
      sortParam=""
      categories={categories}
    />
  )
}
