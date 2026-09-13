import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchCategoryBySlug } from '@/app/lib/catalog'
import CatalogView, { catalogViewMetadata } from '../CatalogView'

type Params = Promise<{ category: string }>
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

/**
 * /catalog/<slug> — human-readable category path (owner task 2026-09-13).
 * Renders the SAME CatalogView as /catalog: the slug comes from the path
 * segment, and searchParams keep working on top (sort/page/min/max/q/stock
 * produce the usual noindex,follow duplicate views — lib/seo.ts).
 *
 * An unknown or inactive slug is a real HTTP 404 (notFound) — never an
 * empty catalog rendered on a crawlable path shape. This differs from the
 * legacy query form, where an unknown slug stays a 200 empty state because
 * it is a filter VALUE on the existing /catalog resource (spec decision A).
 * The legacy /catalog?category=<slug> form itself 308-redirects here
 * (proxy.ts), and the canonical of a valid category is this path form
 * (lib/seo.ts, 2026-09-13).
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

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}): Promise<Metadata> {
  // A slug that fails to decode has no metadata of its own: fall back to
  // the bare-catalog chain (noindex path is irrelevant — the page 404s).
  const slug = decodeCategorySegment((await params).category);
  return catalogViewMetadata({
    categorySlug: slug ?? undefined,
    rawParams: await searchParams,
  });
}

export default async function CategoryCatalogPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
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
  return <CatalogView categorySlug={slug} rawParams={await searchParams} />
}
