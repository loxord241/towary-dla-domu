/**
 * Catalog URL path forms (owner task 2026-09-13). Pure and
 * runtime-dependency-free so node:test loads it without next/server —
 * the same pattern as du-redirects.ts.
 *
 * The single policy consumer is proxy.ts: it turns legacy query-form
 * category URLs into the human-readable path form. The canonical side of
 * the same decision lives in lib/seo.ts (decideCatalogIndexing), and the
 * sitemap (app/sitemap.ts) lists the path shape — all three must agree.
 *
 * ISR split (perf/SEO audit 2026-09-14): /catalog/<slug> and /oboi render
 * WITHOUT searchParams and are ISR-cached (revalidate 60). A query string
 * on those paths must never reach the cached page — the ISR cache key is
 * the pathname alone, so ?sort/?page/?base views would silently get the
 * pure view's HTML (wrong order AND wrong robots). proxy.ts therefore
 * rewrites every query-carrying request to the internal «/filtered» twin
 * routes, which keep today's per-request rendering and full noindex
 * metadata. The decisions below are the pure, tested side of that split;
 * the rewrites are internal (browser URL unchanged).
 */

/**
 * Redirect target for a legacy query-form catalog URL, or null when the
 * request must fall through to /catalog unchanged.
 *
 * Redirects ONLY: exact path /catalog, method GET, a ?category= value that
 * is non-empty after trimming, and NO ?brand= param (category+brand is a
 * combined filter view, not a category page). Every other query param
 * (sort, page, min, max, q, stock…) is preserved on the target. The slug is
 * percent-encoded for the path; the target is an absolute path (+ query),
 * never an absolute URL — the caller anchors it to the request origin.
 */
export function catalogCategoryRedirect(
  pathname: string,
  searchParams: URLSearchParams,
  method: string
): string | null {
  if (pathname !== '/catalog') return null;
  if (method.toUpperCase() !== 'GET') return null;
  const rawCategory = searchParams.get('category');
  if (rawCategory === null) return null;
  const slug = rawCategory.trim();
  if (slug === '') return null;
  if (searchParams.get('brand') !== null) return null;
  const params = new URLSearchParams(searchParams);
  params.delete('category');
  const qs = params.toString();
  return `/catalog/${encodeURIComponent(slug)}${qs ? `?${qs}` : ''}`;
}

/**
 * Internal rewrite target for a query-carrying /catalog/<slug> request, or
 * null when the request must fall through to the ISR-cached category page.
 *
 * Rewrites ONLY: exactly one path segment after /catalog (deeper shapes are
 * today's 404s and stay that way), a NON-EMPTY query string (the bare path
 * is the ISR view) and a decodable segment (garbage percent-encoding keeps
 * flowing to the route, whose decode guard 404s it — same as before the
 * split). The returned path re-encodes the segment so the twin route sees
 * the same params.category value the [category] route would have; the
 * caller must preserve the original query string verbatim (the rewrite
 * never changes it).
 */
export function catalogCategoryFilteredRewrite(
  pathname: string,
  search: string
): string | null {
  if (search === '') return null;
  const match = /^\/catalog\/([^/]+)$/.exec(pathname);
  const rawSegment = match?.[1];
  if (!rawSegment) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  return `/catalog/${encodeURIComponent(decoded)}/filtered`;
}

/**
 * Internal rewrite target for a query-carrying /oboi request, or null when
 * the request must fall through to the ISR-cached storefront. Mirror of
 * catalogCategoryFilteredRewrite for the static /oboi path (?page/?base/
 * ?sort are all query-only there — see app/oboi/page.tsx).
 */
export function oboiFilteredRewrite(
  pathname: string,
  search: string
): string | null {
  if (pathname !== '/oboi' || search === '') return null;
  return '/oboi/filtered';
}

/**
 * Internal rewrite target for a query-carrying /linoleum request, or null
 * when the request must fall through to the ISR-cached storefront. Mirror
 * of oboiFilteredRewrite for the static /linoleum path (?page/?width/?sort
 * are all query-only there — see app/linoleum/page.tsx).
 */
export function linoleumFilteredRewrite(
  pathname: string,
  search: string
): string | null {
  if (pathname !== '/linoleum' || search === '') return null;
  return '/linoleum/filtered';
}
