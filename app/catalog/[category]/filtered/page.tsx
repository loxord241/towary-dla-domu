import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchCategoryBySlug } from '@/app/lib/catalog'
import CatalogView, { catalogViewMetadata } from '../../CatalogView'

type Params = Promise<{ category: string }>
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

/**
 * Dynamic twin of /catalog/<slug> (ISR split, perf/SEO audit 2026-09-14).
 *
 * This route is NEVER linked and NEVER cached: proxy.ts rewrites every
 * query-carrying /catalog/<slug>?… request here (the URL in the browser is
 * unchanged), because the ISR cache key is the pathname alone — sort/page/
 * price/search views must render per request to keep their content AND
 * their noindex,follow robots metadata (lib/seo.ts). Direct visits without
 * a query render the pure category view dynamically; the canonical chain
 * still emits /catalog/<slug>, so such a URL canonicalizes away.
 *
 * The rendering and metadata logic is byte-for-byte the pre-ISR [category]
 * route: same decode guard, same active-only slug lookup with a real 404,
 * same shared CatalogView.
 */
export const dynamic = 'force-dynamic';

/** decodeURIComponent with a guard: garbage percent-encoding must 404,
 * not throw a 500 (same contract as the ISR route). */
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
  const slug = decodeCategorySegment((await params).category);
  return catalogViewMetadata({
    categorySlug: slug ?? undefined,
    rawParams: await searchParams,
  });
}

export default async function CategoryFilteredCatalogPage({
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
  const category = await fetchCategoryBySlug(slug);
  if (!category) {
    notFound();
  }
  return <CatalogView categorySlug={slug} rawParams={await searchParams} />
}
