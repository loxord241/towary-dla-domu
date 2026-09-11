/**
 * Shared contract for header search autocomplete (owner task 2026-09-11):
 * the GET /api/search/suggest endpoint (server side) and the SearchSuggest
 * client component share this module.
 *
 * Deliberately ISOMORPHIC: no 'server-only' marker, no Supabase client
 * creation, no next/server import — the client bundle may pull the whole
 * module through SearchSuggest.tsx without dragging server code in. The
 * DB client is injected into fetchSuggestItems by the route; the browser
 * only ever uses fetchSearchSuggest.
 *
 * Eligibility contract (mirrors PRODUCT_SELECT / CATALOG_CARD_SELECT in
 * catalog.ts): a suggestion is a storefront-visible product —
 * is_active = true AND at least one photo via `product_images!inner`.
 * The wallpaper domain (sku prefix `wc-`) IS included (owner bug report
 * 2026-09-11: «шпалери» searches found nothing): wallpapers are a live
 * storefront domain on /oboi, so the dropdown must surface them like any
 * other product. WALLPAPER_SKU_LIKE stays exported only for the test that
 * pins the prefix in sync with catalog.ts's WALLPAPER_SKU_PREFIX.
 *
 * Failure contract: suggestions must never break typing. Every consumer
 * path (route catch, fetchSearchSuggest) degrades to an empty item list.
 */

import { getPublicImageUrl } from './supabase-storage.ts';
// Type-only: erased at runtime, so the client bundle never pulls supabase-js
// through SearchSuggest.tsx.
import type { SupabaseClient } from '@supabase/supabase-js';
// Wallpaper sku marker. This module is client-reachable (SearchSuggest
// imports the fetcher), so it must NOT import catalog.ts (server-only:
// next/cache cannot enter the client bundle). The literal is kept in sync
// with the single source of truth WALLPAPER_SKU_PREFIX ('wc-') by the
// tests/search-suggest.test.ts synchronization assertion.
export const WALLPAPER_SKU_LIKE = 'wc-%';
/** Max suggestions returned per request (dropdown size). */
export const SUGGEST_LIMIT = 8;

/**
 * Minimum usable query length AFTER sanitization: below this the ILIKE
 * `%ab%` prefix scan fans out over too much of the catalog to be useful
 * and the dropdown would flicker on 1-char input.
 */
export const SUGGEST_MIN_QUERY_LENGTH = 2;

/** Client debounce before a keystroke becomes a request (ms). */
export const SUGGEST_DEBOUNCE_MS = 250;

/** Hard upper bound for one suggest request (never-stuck contract). */
export const SUGGEST_TIMEOUT_MS = 5000;

/**
 * Suggest projection — a strict subset of the card projection
 * (CATALOG_CARD_SELECT, catalog.ts): only what a dropdown row renders.
 * `product_images!inner` is the eligibility join (products without photos
 * are hidden, same as every storefront surface); image fields mirror the
 * card projection's image list so main-photo picking is identical.
 */
export const SUGGEST_SELECT =
  'slug, name, price, currency, availability_status, images:product_images!inner(image_url, is_main, sort_order)';

/** Raw products row as PostgREST returns it for SUGGEST_SELECT. */
export interface SuggestQueryRow {
  slug: string;
  name: string;
  price: number;
  currency: string;
  availability_status: string;
  images:
    | { image_url: string; is_main: boolean | null; sort_order: number | null }[]
    | null;
}

/** One dropdown suggestion (JSON shape of /api/search/suggest items). */
export interface SuggestItem {
  slug: string;
  name: string;
  price: number;
  currency: string;
  availability_status: string;
  imageUrl: string | null;
}

/** PURE: a sanitized term is long enough to search. */
export function isValidSuggestTerm(sanitizedTerm: string): boolean {
  return sanitizedTerm.trim().length >= SUGGEST_MIN_QUERY_LENGTH;
}

/**
 * PURE: the PostgREST `or` value for one sanitized term — the term must
 * match the product name OR the sku (`YC-<id>` format, same recall the
 * catalog search gives sku tokens). sanitizeSearchTerm (route side) has
 * already removed every or=/ILIKE grammar character, so the term embeds
 * into the pattern as a safe literal.
 */
export function suggestOrCondition(sanitizedTerm: string): string {
  const pattern = `%${sanitizedTerm}%`;
  return `name.ilike.${pattern},sku.ilike.${pattern}`;
}

/**
 * PURE: main-photo picking for one raw row — same precedence as the card
 * normalization in catalog.ts (is_main first, then sort_order). External
 * Yugcontract hotlinks pass through getPublicImageUrl untouched.
 */
export function pickSuggestImageUrl(
  images: SuggestQueryRow['images']
): string | null {
  const sorted = [...(images ?? [])].sort(
    (a, b) =>
      Number(b.is_main ?? false) - Number(a.is_main ?? false) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  return getPublicImageUrl(sorted[0]?.image_url ?? '');
}

/**
 * PURE: map raw DB rows into dropdown items. Malformed rows (missing
 * slug/name/price — defensive against schema drift) are skipped, the
 * result is capped at SUGGEST_LIMIT. Ordering is the caller's (SQL);
 * this function preserves input order.
 */
export function buildSuggestResponse(rows: SuggestQueryRow[]): SuggestItem[] {
  const items: SuggestItem[] = [];
  for (const row of rows) {
    if (items.length >= SUGGEST_LIMIT) break;
    if (
      typeof row?.slug !== 'string' ||
      row.slug === '' ||
      typeof row?.name !== 'string' ||
      row.name === '' ||
      typeof row?.price !== 'number'
    ) {
      continue;
    }
    items.push({
      slug: row.slug,
      name: row.name,
      price: row.price,
      currency: row.currency,
      availability_status: row.availability_status,
      imageUrl: pickSuggestImageUrl(row.images),
    });
  }
  return items;
}

/**
 * SERVER (client injected): run the suggest query. Filters:
 * is_active + images!inner (eligibility) + name/sku ILIKE; wallpapers are
 * INCLUDED since 2026-09-11 (owner bug report — «шпалери» found nothing);
 * ordering in-stock first (`in_stock` < `out_of_stock` lexicographically —
 * the catalog default-sort contract), then name, with `id` as the
 * deterministic tiebreaker; window = SUGGEST_LIMIT.
 * Throws on DB errors — the route catch degrades to { items: [] }.
 */
export async function fetchSuggestItems(
  client: SupabaseClient,
  sanitizedTerm: string
): Promise<SuggestItem[]> {
  const { data, error } = await client
    .from('products')
    .select(SUGGEST_SELECT)
    .eq('is_active', true)
    .or(suggestOrCondition(sanitizedTerm))
    .order('availability_status', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true })
    .range(0, SUGGEST_LIMIT - 1);

  if (error) {
    throw new Error(`Failed to load search suggestions: ${error.message}`);
  }
  return buildSuggestResponse((data ?? []) as SuggestQueryRow[]);
}

/**
 * CLIENT: fetch suggestions for a raw (unsanitized) input value.
 * Never-stuck: the request is aborted after SUGGEST_TIMEOUT_MS and every
 * failure (network, HTTP error, malformed body) resolves to [] — the
 * dropdown simply stays closed and typing continues uninterrupted.
 * No external AbortController plumbing: superseded keystrokes are
 * resolved by the caller's sequence guard (SearchSuggest), each request
 * is bounded and harmless.
 */
export async function fetchSearchSuggest(
  query: string,
  options: { timeoutMs?: number; url?: string } = {}
): Promise<SuggestItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? SUGGEST_TIMEOUT_MS
  );
  try {
    const res = await fetch(
      `${options.url ?? '/api/search/suggest'}?q=${encodeURIComponent(query)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as {
      items?: SuggestItem[];
    } | null;
    if (!data || !Array.isArray(data.items)) return [];
    return data.items.filter(
      (item) =>
        typeof item?.slug === 'string' &&
        item.slug !== '' &&
        typeof item?.name === 'string' &&
        item.name !== ''
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
