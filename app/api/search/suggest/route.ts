import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sanitizeSearchTerm } from '@/app/lib/catalog';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import {
  fetchSuggestItems,
  isValidSuggestTerm,
} from '@/app/lib/search-suggest';

/**
 * GET /api/search/suggest?q=... — header search autocomplete (owner task
 * 2026-09-11).
 *
 * Read-only, anonymous (publishable key + RLS — inactive products are
 * hidden by RLS itself; the query additionally enforces the storefront
 * eligibility contract: is_active + ≥1 фото через images!inner — and the
 * wallpaper exclusion, see app/lib/search-suggest.ts).
 *
 * Failure contract: suggestions must never break typing. Every error path
 * — rate limit (429 handled client-side), validation, DB failure —
 * degrades to an empty item list (or a plain 429), never to a thrown
 * error reaching the header input.
 */

// Same pattern as app/lib/catalog.ts: server-side, anonymous, no session.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  { auth: { persistSession: false } }
);

export async function GET(request: Request) {
  const limited = await enforceRateLimit(request, 'searchSuggest');
  if (limited) return limited;

  const rawQuery = new URL(request.url).searchParams.get('q') ?? '';
  // Reuse the catalog sanitizer: strips the PostgREServed or=/ILIKE grammar
  // characters (, " ( ) % * _) and collapses whitespace, so the term is a
  // safe literal inside the or= expression built in fetchSuggestItems.
  const term = sanitizeSearchTerm(rawQuery);
  if (!isValidSuggestTerm(term)) {
    return NextResponse.json({ items: [] });
  }

  try {
    const items = await fetchSuggestItems(supabase, term);
    return NextResponse.json({ items });
  } catch (error) {
    console.error(
      'search-suggest query failed:',
      error instanceof Error ? error.message : error
    );
    return NextResponse.json({ items: [] });
  }
}
