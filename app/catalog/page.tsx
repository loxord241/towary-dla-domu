import type { Metadata } from 'next'
import CatalogView, { catalogViewMetadata } from './CatalogView'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

/**
 * /catalog route (legacy query-form home of the catalog). Since 2026-09-13
 * the page body lives in the shared CatalogView component — the same
 * renderer also powers /catalog/<slug> (see app/catalog/[category]/page.tsx,
 * owner task «human-readable category paths»). Here the category slug still
 * arrives as the ?category= query value; proxy.ts 308-redirects that form
 * to the path form, and this route remains the fallback for non-redirectable
 * requests (bad/empty slug, brand present, non-GET).
 */

/** Same chain as the [category] route — the single tested policy in
 * lib/seo.ts decides indexability/canonical per view. */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams
}): Promise<Metadata> {
  return catalogViewMetadata({ rawParams: await searchParams });
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  return <CatalogView rawParams={await searchParams} />
}
