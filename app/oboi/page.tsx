import type { Metadata } from 'next'
import {
  fetchWallpaperProducts,
  fetchActiveCategories,
  CATALOG_PAGE_SIZE,
  type CatalogSort,
} from '@/app/lib/catalog'
import { buildWallpapersMetadata } from '@/app/lib/seo'
import OboiStorefront from './OboiStorefront'

// Wallpapers storefront (owner task 2026-09-10): /oboi renders ONLY the
// wc-* domain (fetchWallpaperProducts).
//
// ISR (perf/SEO audit 2026-09-14): this route IS the indexable pure view —
// page 1, no ?base=, default alphabetical sort — and reads NO searchParams,
// so `revalidate = 60` keeps the whole HTML (metadata, JSON-LD and the FAQ
// block included) in the ISR cache. Every query-carrying request
// (?page/?base/?sort) is rewritten by proxy.ts (oboiFilteredRewrite) to the
// dynamic twin app/oboi/filtered/page.tsx BEFORE routing: an ISR cache key
// is the pathname alone, so without the rewrite a ?page=2 request would be
// served this cached page-1 HTML with the wrong robots. The twin keeps
// today's per-request rendering and the noindex,follow contract.

// On-demand ISR, same shape as the home page and /product/[slug]: the bare
// path prerenders at build and revalidates every 60s.
export const revalidate = 60;

// The pure view IS the indexable view: index,follow + canonical /oboi with
// the same copy (lib/seo.ts). Reading searchParams here (even just for the
// noindex branch) would opt the whole route into dynamic rendering and
// disable the cache — the proxy rewrite guarantees no query ever arrives.
export async function generateMetadata(): Promise<Metadata> {
  return buildWallpapersMetadata();
}

export default async function OboiPage() {
  // Pure-view defaults: page 1, no «Основа» filter, alphabetical order
  // (absent ?sort= IS name_asc — owner 2026-09-12).
  const [catalog, categories] = await Promise.all([
    fetchWallpaperProducts({
      page: 1,
      size: CATALOG_PAGE_SIZE,
      base: undefined,
      sort: 'name_asc' as CatalogSort,
    }),
    fetchActiveCategories(),
  ]);
  const maxPage = Math.max(1, Math.ceil(catalog.total / catalog.size));

  return (
    <OboiStorefront
      products={catalog.products}
      total={catalog.total}
      // The server-clamped page for a page-1 request is always 1.
      currentPage={catalog.page}
      maxPage={maxPage}
      base={undefined}
      sortParam=""
      // The indexable view carries the FAQ (visible block + FaqJsonLd).
      showFaq={true}
      categories={categories}
    />
  )
}
