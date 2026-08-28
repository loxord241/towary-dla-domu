-- Migration 029: single-request review summary (perf audit 2026-08-28, Step 2).
--
-- The product page previously computed the star distribution with FIVE
-- separate PostgREST head-count requests (one per rating value,
-- app/lib/catalog.ts fetchReviewSummary). This replaces them with ONE
-- read-only group-by RPC.
--
-- RLS safety: the function is SECURITY INVOKER, so it runs as the calling
-- role (anon on the storefront). The existing policy
-- product_reviews_public_read_published (SELECT, status = 'published')
-- still decides which rows the aggregate can see — no data path changes.
-- The function only aggregates; it can never mutate or bypass the policy.
--
-- Hardened session scope (search_path = '') prevents search_path injection;
-- all object references are schema-qualified.

create or replace function public.product_review_summary(p_product_id uuid)
returns table (rating smallint, review_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.rating, count(*)::bigint as review_count
  from public.product_reviews r
  where r.product_id = p_product_id
    and r.status = 'published'
  group by r.rating
$$;

revoke all on function public.product_review_summary(uuid) from public, anon, authenticated;
grant execute on function public.product_review_summary(uuid) to anon, service_role;
