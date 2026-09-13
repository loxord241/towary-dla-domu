import { createClient } from '@supabase/supabase-js';
import { cache } from 'react';
import { cachePublicRead } from './catalog/shared.ts';

/**
 * Data Cache TTL for category descriptions (perf package 2026-09-13).
 * Deliberately NOT CATALOG_PUBLIC_READ_TTL_SECONDS: descriptions are
 * admin-authored copy edited in the admin UI (not importer data), so the
 * task spec bounds staleness at 300-600s — 600s keeps an admin edit
 * storefront-visible within ten minutes while still deduplicating the
 * per-render slug lookup across requests. The `catalog-public-reads` tag
 * (applied by cachePublicRead) still allows targeted invalidation.
 */
const CATEGORY_DESCRIPTION_TTL_SECONDS = 600;

/**
 * Storefront reader for `categories.description` (plain admin-authored
 * text, seeded by data/category-seo-texts.sql, editable in the admin UI).
 *
 * WHY A SEPARATE MODULE (not lib/catalog.ts): the storefront category
 * reads there deliberately EXCLUDE `description` — the 205-row dictionary
 * is fetched on every catalog/PDP render and carrying free-text payloads
 * in it was rejected by the egress audit (catalog.ts, 2026-09-08). This
 * reader fetches exactly ONE row by slug and is only called on category
 * page-1 views. catalog.ts is concurrently owned by a parallel
 * workstream, so the reader lives here until the owner folds it in.
 *
 * Rendering contract: the value is PLAIN TEXT. It is split into
 * paragraphs (pure helper below, unit-tested) and rendered as React text
 * children — no HTML parsing of any admin-entered string.
 */

function anonClient(): ReturnType<typeof createClient> {
  // Storefront reads use the publishable key (anonymous role); visibility
  // is decided by the existing RLS policies. Same posture as catalog.ts.
  // Created lazily so node:test can import the pure helpers without env.
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } }
  );
}

/**
 * Blank-line separated plain text → paragraph list. Runs of internal
 * whitespace collapse (admin text is prose, not preformatted); empty
 * result for null/blank input → the caller renders nothing.
 */
export function splitDescriptionParagraphs(
  text: string | null | undefined
): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

async function fetchCategoryDescriptionUncached(
  slug: string
): Promise<string | null> {
  const { data, error } = await anonClient()
    .from('categories')
    .select('description')
    .eq('slug', slug)
    .eq('is_active', true)
    .returns<{ description: string | null }[]>()
    .maybeSingle();
  // A transient read failure degrades to «no description» — the category
  // page itself must never break because of this optional copy block. The
  // degradation THROWS here instead of returning null: unstable_cache
  // persists only resolved values, so a failed read is never cached and
  // the next request retries (same contract as the other catalog reads).
  if (error) {
    throw new Error(`Failed to load category description "${slug}": ${error.message}`);
  }
  return data?.description ?? null;
}

/**
 * Caching layers (perf package 2026-09-13), outermost first:
 *  1. React `cache()` — one execution per request/render (unchanged);
 *  2. unstable_cache via cachePublicRead — one Data Cache entry shared
 *     across requests for CATEGORY_DESCRIPTION_TTL_SECONDS, tag
 *     `catalog-public-reads`.
 * The Data Cache entry for a slug without a description is a legit null
 * (admin simply hasn't authored copy) and is cached like any other value;
 * DB ERRORS throw past unstable_cache and are converted to null by the
 * try/catch below, so a transient failure never poisons the cache.
 */
const fetchCategoryDescriptionStore = cachePublicRead(
  'category-description:by-slug',
  CATEGORY_DESCRIPTION_TTL_SECONDS,
  fetchCategoryDescriptionUncached
);

/** Per-request memo — the slug lookup runs at most once per render. */
const fetchCategoryDescriptionCached = cache(async (slug: string) => {
  try {
    return await fetchCategoryDescriptionStore(slug);
  } catch {
    return null;
  }
});

export const fetchCategoryDescription = fetchCategoryDescriptionCached;
