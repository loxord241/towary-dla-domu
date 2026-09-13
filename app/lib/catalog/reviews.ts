//
// Product reviews (Відгуки) — public READS (list + aggregated summary).
//

import { cachePublicRead, CATALOG_PUBLIC_READ_TTL_SECONDS, supabase } from './shared.ts';

// ---------------------------------------------------------------------------
// Product reviews (Відгуки) — public READS only.
//
// Writes never go through this file: submissions land as status='pending'
// via app/api/reviews/route.ts (service role) and are published/rejected in
// the admin API. The queries below run on the ANONYMOUS client, so RLS
// already restricts rows to status='published'; the .eq('status') filters
// stay as defense-in-depth so the contract survives even a future policy
// regression.
// ---------------------------------------------------------------------------

export interface ProductReview {
  id: string;
  product_id: string;
  rating: number;
  text: string;
  display_name: string | null;
  created_at: string;
}

export interface ReviewsPageData {
  reviews: ProductReview[];
  total: number;
  page: number;
  pageSize: number;
}

/** Hard cap for one rendered page of reviews — bounded by design. */
export const REVIEWS_PAGE_SIZE = 10;

/** Column whitelist — never select('*') on user-generated content. */
const REVIEW_COLUMNS =
  'id, product_id, rating, text, display_name, created_at';

export async function fetchPublishedReviews(
  productId: string,
  page = 1
): Promise<ReviewsPageData> {
  return fetchPublishedReviewsStore(productId, page ?? 1);
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by (productId, page).
 * Published reviews are public, moderated, user-independent content.
 */
const fetchPublishedReviewsStore = cachePublicRead(
  'catalog:reviews',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (productId: string, page: number): Promise<ReviewsPageData> => {
    const { count, error: countError } = await supabase
      .from('product_reviews')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', productId)
      .eq('status', 'published');
    if (countError) {
      throw new Error(`Failed to count reviews: ${countError.message}`);
    }

    const total = count ?? 0;
    const maxPage = Math.max(1, Math.ceil(total / REVIEWS_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 1), maxPage);

    const { data, error } = await supabase
      .from('product_reviews')
      .select(REVIEW_COLUMNS)
      .eq('product_id', productId)
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range((safePage - 1) * REVIEWS_PAGE_SIZE, safePage * REVIEWS_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load reviews: ${error.message}`);
    }

    return {
      reviews: data ?? [],
      total,
      page: safePage,
      pageSize: REVIEWS_PAGE_SIZE,
    };
  }
);

export interface ReviewSummary {
  total: number;
  /** Arithmetic mean rounded to 1 decimal; null when no published reviews. */
  average: number | null;
  /** Index 0 = ★1 … index 4 = ★5. */
  distribution: [number, number, number, number, number];
}

/**
 * Average + star distribution via ONE read-only RPC (migration 029,
 * perf audit Step 2 2026-08-28): replaces the previous five separate
 * head-count requests (one per rating) with a single group-by call.
 * The RPC is SECURITY INVOKER, so the anonymous role's RLS policy
 * (product_reviews_public_read_published) still governs visibility —
 * no rows can cross the wire, only ≤5 aggregated counts.
 */
export async function fetchReviewSummary(
  productId: string
): Promise<ReviewSummary> {
  return fetchReviewSummaryStore(productId);
}

/**
 * Caching step 2 (2026-08-31): 60s Data Cache keyed by productId. The RPC
 * is SECURITY INVOKER and public (aggregated counts only) — identical for
 * every visitor.
 */
const fetchReviewSummaryStore = cachePublicRead(
  'catalog:review-summary',
  CATALOG_PUBLIC_READ_TTL_SECONDS,
  async (productId: string): Promise<ReviewSummary> => {
    const { data, error } = await supabase.rpc('product_review_summary', {
      p_product_id: productId,
    });
    if (error) {
      throw new Error(`Failed to summarize ratings: ${error.message}`);
    }

    type SummaryRow = { rating: number | string; review_count: number | string };
    const rows = (data ?? []) as SummaryRow[];
    const countFor = (rating: number): number => {
      const row = rows.find((entry) => Number(entry.rating) === rating);
      return row ? Number(row.review_count) : 0;
    };

    const distribution: ReviewSummary['distribution'] = [
      countFor(1),
      countFor(2),
      countFor(3),
      countFor(4),
      countFor(5),
    ];
    const total = distribution.reduce((sum, n) => sum + n, 0);
    const weighted =
      distribution[0] * 1 +
      distribution[1] * 2 +
      distribution[2] * 3 +
      distribution[3] * 4 +
      distribution[4] * 5;

    return {
      total,
      average: total > 0 ? Math.round((weighted / total) * 10) / 10 : null,
      distribution,
    };
  }
);
