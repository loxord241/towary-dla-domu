import { createClient } from '@supabase/supabase-js';
import { enforceRateLimit } from '@/app/lib/rate-limit';
import { assertSameOrigin } from '@/app/lib/request-origin';
import {
  validateReviewInput,
  REVIEW_DAILY_CAP,
} from '@/app/lib/reviews';
import { isUuid } from '@/app/lib/admin-api';
import { fetchPublishedReviews } from '@/app/lib/catalog';

/**
 * Public product-review submission endpoint.
 *
 * Anti-spam layers (mirroring /api/feedback):
 *   1. per-IP sliding window — transient in-process memory, nothing persisted;
 *   2. honeypot field `website` — bots that fill it are dropped;
 *   3. shared daily cap counted over product_reviews.created_at in the DB
 *      (identifier-free, multi-instance safe).
 *
 * Every accepted review lands as status='pending': NOTHING becomes public
 * before an admin publishes it via /api/admin/reviews. Storage errors answer
 * 503 honestly (e.g. migration not applied yet) — success is never faked.
 */

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const limited = await enforceRateLimit(request, 'reviews');
  if (limited) return limited;

  // Same-origin gate (audit P1): a cross-site browser POST always carries
  // an Origin that cannot match the deployment host — reject before any
  // parse/DB work (see app/lib/request-origin.ts).
  if (!assertSameOrigin(request)) {
    return Response.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { productId, rating, text, displayName, website } = (body ?? {}) as {
    productId?: unknown;
    rating?: unknown;
    text?: unknown;
    displayName?: unknown;
    website?: unknown;
  };

  // Honeypot: the hidden field must stay empty.
  if (typeof website === 'string' && website.length > 0) {
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }

  const validated = validateReviewInput({ rating, text, displayName });
  if (!validated.ok) {
    return Response.json({ error: 'invalid_data' }, { status: 400 });
  }

  if (typeof productId !== 'string' || !isUuid(productId)) {
    return Response.json({ error: 'invalid_product' }, { status: 400 });
  }

  const sb = serviceClient();

  // The target product must be live; the FK alone would also accept inactive ones.
  const { count: productCount, error: productError } = await sb
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('id', productId)
    .eq('is_active', true);
  if (productError) {
    console.error('review target lookup failed:', productError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }
  if ((productCount ?? 0) === 0) {
    return Response.json({ error: 'invalid_product' }, { status: 404 });
  }

  // Shared daily cap across ALL products (identifier-free flood ceiling).
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: capError } = await sb
    .from('product_reviews')
    .select('*', { count: 'exact', head: true })
    .gt('created_at', dayAgo);
  if (capError) {
    console.error('review daily-cap lookup failed:', capError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }
  if ((count ?? 0) >= REVIEW_DAILY_CAP) {
    return Response.json({ error: 'review_rate_limited' }, { status: 429 });
  }

  const { error: insertError } = await sb.from('product_reviews').insert({
    product_id: productId,
    rating: validated.rating,
    text: validated.text,
    display_name: validated.displayName,
    status: 'pending',
  });

  if (insertError) {
    // Migration not applied yet (or transient storage failure) — degrade
    // honestly instead of faking success. Raw DB internals stay server-side.
    console.error('review insert failed:', insertError.message);
    return Response.json({ error: 'review_storage_not_configured' }, { status: 503 });
  }

  return Response.json({ ok: true }, { status: 201 });
}

/**
 * Public read endpoint for reviews pagination (Task #5B 2026-08-31): the
 * PDP is on-demand ISR, so pages beyond the SSR-rendered page 1 are fetched
 * client-side from here. Read-only: it goes through fetchPublishedReviews
 * (anon-key client, RLS-published rows only, 60s Data Cache keyed by
 * (productId, page)). The service-role client above is INSERT-ONLY and must
 * never serve reads; page clamping (maxPage) happens inside the read.
 */
export async function GET(request: Request) {
  // The read path is public and used by PDP pagination, so it gets its own
  // (much more generous) ceiling — without it, the endpoint had NO limiter
  // at all and could be hammered independently of the POST budget
  // (security audit 2026-09).
  const limited = await enforceRateLimit(request, 'reviewsGet');
  if (limited) return limited;

  const url = new URL(request.url);
  const productId = url.searchParams.get('product_id') ?? '';
  if (!isUuid(productId)) {
    return Response.json({ error: 'invalid_product' }, { status: 400 });
  }

  const rawPage = Number(url.searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  try {
    const data = await fetchPublishedReviews(productId, page);
    return Response.json(data);
  } catch (error) {
    // Storage hiccup or migration not applied — degrade honestly, same
    // contract as the SSR fallback on the page itself.
    console.error('reviews page read failed:', error);
    return Response.json({ error: 'reviews_unavailable' }, { status: 503 });
  }
}
