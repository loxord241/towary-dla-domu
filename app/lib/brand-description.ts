import { createClient } from '@supabase/supabase-js';
import { cache } from 'react';
import { cachePublicRead } from './catalog/shared.ts';
import { splitDescriptionParagraphs } from './category-description.ts';

/**
 * Storefront reader for `brands.description` (audit R8 2026-09-15) — the
 * exact mirror of app/lib/category-description.ts, with one difference: the
 * source table is `brands`. Plain admin-authored text; the same rendering
 * contract (splitDescriptionParagraphs → React text children, no HTML
 * parsing) and the same caching posture (React cache() + unstable_cache
 * 600s via cachePublicRead, transient errors never poison the cache).
 *
 * Reader is only called on brand page-1 views (CatalogView), so it fetches
 * exactly ONE row by slug — no egress impact on the brand dictionary.
 */

const BRAND_DESCRIPTION_TTL_SECONDS = 600;

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

async function fetchBrandDescriptionUncached(
  slug: string
): Promise<string | null> {
  const { data, error } = await anonClient()
    .from('brands')
    .select('description')
    .eq('slug', slug)
    .eq('is_active', true)
    .returns<{ description: string | null }[]>()
    .maybeSingle();
  // Same contract as the category reader: DB errors THROW past
  // unstable_cache (never cached) and the caller's try/catch degrades to
  // null — a transient failure never breaks the brand view.
  if (error) {
    throw new Error(`Failed to load brand description "${slug}": ${error.message}`);
  }
  return data?.description ?? null;
}

const fetchBrandDescriptionStore = cachePublicRead(
  'brand-description:by-slug',
  BRAND_DESCRIPTION_TTL_SECONDS,
  fetchBrandDescriptionUncached
);

/** Per-request memo — the slug lookup runs at most once per render. */
const fetchBrandDescriptionCached = cache(async (slug: string) => {
  try {
    return await fetchBrandDescriptionStore(slug);
  } catch {
    return null;
  }
});

export const fetchBrandDescription = fetchBrandDescriptionCached;
