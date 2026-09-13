/**
 * Catalog URL path forms (owner task 2026-09-13). Pure and
 * runtime-dependency-free so node:test loads it without next/server —
 * the same pattern as du-redirects.ts.
 *
 * The single policy consumer is proxy.ts: it turns legacy query-form
 * category URLs into the human-readable path form. The canonical side of
 * the same decision lives in lib/seo.ts (decideCatalogIndexing), and the
 * sitemap (app/sitemap.ts) lists the path shape — all three must agree.
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
