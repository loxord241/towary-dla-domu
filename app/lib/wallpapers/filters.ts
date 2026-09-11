/**
 * /oboi spec-filters (owner task 2026-09-11).
 *
 * Filters read `products.specifications` — the JSONB array of
 * `{name, value}` pairs scraped from the slav product pages (commit 813e18d).
 *
 * The value DICTIONARY below is hardcoded from the only verified live
 * fragment (tests/wallpaper-photo-sources.test.ts: «Основа» = «Паперова»).
 * Прямой SELECT из БД агенту недоступен, поэтому СЛОВАРЬ МОЖЕТ РАСШИРЯТЬСЯ:
 * новые значения добавляются сюда по мере подтверждения на реальных
 * страницах поставщика (флізелінова/вінілова основа тощо). Chips render
 * exactly this list; an unknown ?base= value still reaches the query as an
 * exact-match contains (0 rows) — the whitelist exists for the UI, not as a
 * query firewall (PostgREST contains is parameterized).
 *
 * Why only «Основа» is server-filterable in v1: «Приміщення» is stored as
 * ONE comma-joined string per product («Вітальня, Спальня»); jsonb @>
 * (PostgREST contains) matches whole values only, so a substring match
 * (room=Кухня inside «Вітальня, Кухня») is impossible without a
 * text-extracted computed column (DDL is manual-only here). Room filtering
 * is therefore DEFERRED, not dropped — JS-filtering a single page would lie
 * about the pagination totals.
 */

/** specifications[].name of the base-material characteristic. */
export const WALLPAPER_BASE_SPEC_NAME = 'Основа';

/**
 * Known «Основа» values for the filter chips (see the module docblock —
 * словарь может расширяться).
 */
export const WALLPAPER_BASE_VALUES: readonly string[] = ['Паперова'];
