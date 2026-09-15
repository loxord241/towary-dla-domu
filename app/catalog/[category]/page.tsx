import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchActiveCategories, fetchCategoryBySlug } from '@/app/lib/catalog'
import CatalogView, { catalogViewMetadata } from '../CatalogView'

type Params = Promise<{ category: string }>

/**
 * /catalog/<slug> — human-readable category path (owner task 2026-09-13),
 * ISR since the 2026-09-14 perf/SEO audit.
 *
 * CACHING CONTRACT: this route renders ONLY the pure category view —
 * it never touches searchParams, so `revalidate = 60` keeps the whole
 * HTML (metadata included) in the ISR cache keyed by the slug. Every
 * query-carrying request (?sort/?page/?min/?max/?q/?stock/…) is rewritten
 * by proxy.ts (catalogCategoryFilteredRewrite) to the dynamic twin route
 * app/catalog/[category]/filtered/page.tsx BEFORE routing, so filtered or
 * paginated views can never be served the cached pure-view HTML and keep
 * their noindex,follow metadata (lib/seo.ts decision unchanged there).
 * An ISR cache key is the pathname alone — without the rewrite the query
 * would be silently ignored and the pure view served for ?page=2.
 *
 * An unknown or inactive slug resolves to notFound(). OWNER DECISION
 * 2026-09-15 (audit R13): the catalog loading skeleton stays, so the
 * notFound lands mid-stream — the response is a 200 whose streamed
 * not-found tree carries <meta name="robots" content="noindex"> (Next
 * injects it in the HTTPAccessFallback boundary); a crawlable path shape
 * never renders an empty catalog. The earlier «real HTTP 404» comment no
 * longer describes runtime behavior.
 * This differs from the legacy query form, where an unknown slug stays a
 * 200 empty state because it is a filter VALUE on the existing /catalog
 * resource (spec decision A). The legacy /catalog?category=<slug> form
 * itself 308-redirects here (proxy.ts), and the canonical of a valid
 * category is this path form (lib/seo.ts, 2026-09-13).
 */

/** decodeURIComponent with a guard: garbage percent-encoding (e.g.
 * /catalog/%E0%A4%A4) must 404, not throw a 500. */
function decodeCategorySegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// On-demand ISR, same shape as the PDP (app/product/[slug]/page.tsx):
// active categories prerender at build; slugs added later render on the
// first visit (dynamicParams stays true) and every entry revalidates
// every 60s. The robots/canonical metadata below is part of the cached
// HTML — the Task #14 «empty category → noindex» fact is therefore
// bounded-stale by the same 60s window as the product grid.
export const revalidate = 60;

export async function generateStaticParams() {
  try {
    const categories = await fetchActiveCategories();
    return categories.map((category) => ({ category: category.slug }));
  } catch {
    // A dictionary read failure must not fail the build: with an empty
    // list every slug simply renders on demand (same on-demand ISR).
    return [];
  }
}

// Metadata reads ONLY the path slug: this route IS the pure view, so the
// metadata chain runs with empty query params (index,follow + the
// path-form canonical for a non-empty active category — lib/seo.ts).
// Awaiting searchParams here would opt the whole route into dynamic
// rendering and disable the ISR cache entirely.
export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  // A slug that fails to decode has no metadata of its own: fall back to
  // the bare-catalog chain (noindex path is irrelevant — the page 404s).
  const slug = decodeCategorySegment((await params).category);
  return catalogViewMetadata({
    categorySlug: slug ?? undefined,
    rawParams: {},
  });
}

export default async function CategoryCatalogPage({
  params,
}: {
  params: Params
}) {
  const slug = decodeCategorySegment((await params).category);
  if (!slug) {
    notFound();
  }
  // Same loader the /catalog route uses for its ?category= query value
  // (active-only lookup): unknown/inactive slug → 404.
  const category = await fetchCategoryBySlug(slug);
  if (!category) {
    notFound();
  }
  // No query params exist on this route (proxy rewrites them away), so the
  // view always renders the pure page-1 default-sort catalog.
  return <CatalogView categorySlug={slug} rawParams={{}} />
}
