/**
 * Pure URL building for the catalog filter apply/reset actions.
 *
 * Contract (2026-08 UX stage): applying filters must preserve the active
 * search term (`q`) and sort order — the previous inline implementation
 * rebuilt the query from the draft alone and silently dropped both.
 * Applying always lands on page 1: the result set has changed, so any
 * previous page number is meaningless (and could point past the new last
 * page; the server clamps, but a clean URL is cheaper than a redirect).
 *
 * Only catalog-known keys are carried. Anything else in the current URL
 * (utm tags, stray params) is intentionally not propagated — same
 * semantics as the previous implementation, now explicit and testable.
 */

export interface FilterDraft {
  categorySlug?: string;
  brandSlug?: string;
  /** raw input strings — validated here, garbage omitted */
  minPrice?: string;
  maxPrice?: string;
  inStockOnly?: boolean;
}

/** Keys preserved from the current view when filters are applied. */
const PRESERVED_KEYS = ['q', 'sort'] as const;

function setIfPresent(params: URLSearchParams, key: string, value?: string): void {
  const trimmed = value?.trim() ?? '';
  if (trimmed !== '') params.set(key, trimmed);
}

export function buildFilterSearchParams(
  currentParams: URLSearchParams,
  draft: FilterDraft
): string {
  const params = new URLSearchParams();

  for (const key of PRESERVED_KEYS) {
    // An explicitly provided draft wins over the current URL; when a filter
    // group still holds its value it keeps the preserved param meaningful.
    const value = currentParams.get(key);
    if (value) params.set(key, value);
  }

  setIfPresent(params, 'category', draft.categorySlug);
  setIfPresent(params, 'brand', draft.brandSlug);

  const min = draft.minPrice?.trim() ?? '';
  if (min !== '' && Number.isFinite(Number(min))) params.set('min', min);
  const max = draft.maxPrice?.trim() ?? '';
  if (max !== '' && Number.isFinite(Number(max))) params.set('max', max);

  if (draft.inStockOnly) params.set('stock', '1');

  return params.toString();
}

export function buildFilterUrl(
  currentParams: URLSearchParams,
  draft: FilterDraft
): string {
  const qs = buildFilterSearchParams(currentParams, draft);
  return qs ? `/catalog?${qs}` : '/catalog';
}

/**
 * Pure URL building for the catalog sort control.
 *
 * Contract (2026-08-27 stage): changing sort on a paginated view resets
 * the result to page 1 (explicitly emitted as page=1) — previously
 * ?page=2&sort=newest turned into ?page=2&sort=price_asc and showed an
 * arbitrary slice of the new ordering. Unlike filter apply, ALL current
 * params are carried through untouched (including non-catalog tags):
 * this mirrors the previous SortSelect behavior of round-tripping the
 * full querystring, changing only sort/page semantics.
 *
 * `value === 'newest'` removes the explicit sort param; any other value
 * is stored verbatim (validated against SORT_VALUES by the caller).
 */
export function buildSortSearchParams(
  currentParams: URLSearchParams,
  value: string
): string {
  const params = new URLSearchParams(currentParams.toString());
  if (value === 'newest') {
    params.delete('sort');
  } else {
    params.set('sort', value);
  }
  params.set('page', '1');
  return params.toString();
}

/**
 * Which KIND of navigation a sort change must use for the given base path.
 *
 * Owner bug 2026-09-15 («сортировка через раз работает»): since the ISR
 * split (b3afd68) /catalog/<slug> is a fully STATIC route whose query views
 * are rendered by a hidden force-dynamic twin that only proxy.ts rewrites
 * to. Next 16's client segment cache prefetches static routes IN FULL and
 * stores their page segments reusable «across all possible search param
 * values», and its optimistic route prediction (default-on in 16.3.5)
 * matches a router.push target BY PATHNAME ONLY — so a soft navigation to
 * /catalog/<slug>?sort=… can render the cached pure page (default order)
 * without any server request, and the sorting twin never runs. Whether that
 * prediction fires depends on the ~60s prefetch freshness — hence the
 * intermittent behavior. A DOCUMENT navigation (window.location.assign)
 * always reaches the server: proxy rewrites to the twin, which sorts.
 *
 * The legacy bare /catalog is a DYNAMIC route (it awaits searchParams), its
 * prefetch never contains page data for a query-carrying URL, so the router
 * fetches per request and the cheaper router.push stays correct there.
 */
export function isSortDocumentNavigation(basePath: string): boolean {
  return basePath !== '/catalog';
}
