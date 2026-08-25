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
