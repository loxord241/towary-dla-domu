/**
 * Store announcements — server-side storefront read (migration 031).
 *
 * WHY A SEPARATE MODULE (perf package 2026-09-13): the domain's pure part
 * (types, validation, visibility selector) lives in app/lib/announcements.ts
 * and is imported by the 'use client' admin dashboard, so it must stay free
 * of server-only wiring. This module carries the Supabase anon client and
 * the cached read; only server components import it.
 *
 * Caching: the read is wrapped in the shared cachePublicRead Data Cache
 * (TTL CATALOG_PUBLIC_READ_TTL_SECONDS, tag `catalog-public-reads` —
 * precedent: categories.ts). Announcements change only via the admin UI,
 * and an admin save (or a targeted revalidateTag) drops the whole tag, so
 * the TTL only bounds the worst-case staleness. The cached layer THROWS on
 * deadline/DB failure — unstable_cache persists only resolved values, so a
 * failed read is never cached and the fail-open [] stays a per-request
 * decision instead of a TTL-long ban on announcements.
 *
 * Failure policy: fetchActiveAnnouncements never throws — an empty table,
 * a network error or a misconfigured env must render an empty banner, not
 * break home/catalog/PDP/cart.
 */

import { createClient } from '@supabase/supabase-js';
import { cachePublicRead, CATALOG_PUBLIC_READ_TTL_SECONDS } from './catalog/shared.ts';
import { selectActiveAnnouncements } from './announcements.ts';
import type { Announcement } from './announcements.ts';

// Storefront reads run with the publishable key as the anonymous role —
// visibility is decided entirely by the RLS policy on the table.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

/**
 * Deadline: supabase-js does not accept an AbortSignal on a query builder,
 * so the SELECT is raced against an 8 s timer — a hung upstream must not
 * stall the awaited SSR render of home/catalog/PDP/cart. The timer losing
 * the race logs server-side and THROWS (never cached — see module doc).
 */
const ANNOUNCEMENTS_DEADLINE_MS = 8_000;

async function fetchActiveAnnouncementsUncached(): Promise<Announcement[]> {
  const query = supabase
    .from('store_announcements')
    .select(
      'id, title, message, type, is_active, sort_order, created_at, updated_at'
    )
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(10);

  const deadline = new Promise<'__timeout__'>((resolve) => {
    setTimeout(() => resolve('__timeout__'), ANNOUNCEMENTS_DEADLINE_MS);
  });
  const raced = await Promise.race([query, deadline]);
  if (raced === '__timeout__') {
    console.error('store announcements: deadline exceeded — rendering without them');
    throw new Error('store announcements: deadline exceeded');
  }

  const { data, error } = raced;
  if (error || !data) {
    throw new Error(`store announcements read failed: ${error?.message ?? 'no data'}`);
  }
  return selectActiveAnnouncements(data as Announcement[]);
}

const fetchActiveAnnouncementsStore = cachePublicRead(
  'announcements:active',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  fetchActiveAnnouncementsUncached
);

export async function fetchActiveAnnouncements(): Promise<Announcement[]> {
  try {
    return await fetchActiveAnnouncementsStore();
  } catch {
    return [];
  }
}
