-- Product reviews with mandatory moderation (feature: Відгуки про товари).
--
-- WRITE PATH: inserts happen ONLY through app/api/reviews/route.ts using the
-- service-role key; status transitions happen ONLY through
-- app/api/admin/reviews/* behind requireAdminApi(). RLS is enabled and the
-- SINGLE policy grants SELECT of published rows to anon/authenticated —
-- there are intentionally NO INSERT/UPDATE/DELETE policies.
--
-- PRIVACY CONTRACT (mirrors feedback/013): the table stores a user-supplied
-- display name, rating, review text and timestamps ONLY. There are no
-- email/phone/ip/user-agent columns and no order/customer linkage by design,
-- so nothing customer-identifying can leak through the public read policy.
--
-- FOOTGUN NOTE (see 014 + PROJECT_CONTEXT): final_001 sets ALTER DEFAULT
-- PRIVILEGES GRANT SELECT ON TABLES TO public, so this new table inherits a
-- blanket SELECT grant. That grant is safe here because RLS reduces what
-- anon/authenticated can see to published rows only, and there is no write
-- grant at the privilege level.
--
-- Apply manually via Supabase SQL Editor (NOT applied by code).
-- Rollback: DROP TABLE IF EXISTS public.product_reviews;

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  text text NOT NULL CHECK (char_length(text) BETWEEN 10 AND 1000),
  display_name text CHECK (char_length(display_name) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','published','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_reviews_public_read_published
  ON public.product_reviews
  FOR SELECT
  TO anon, authenticated
  USING (status = 'published');

-- Storefront shelf: published reviews of one product, newest first.
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_published
  ON public.product_reviews (product_id, status, created_at DESC, id DESC);

-- Admin moderation queue: per status, newest first.
CREATE INDEX IF NOT EXISTS idx_product_reviews_moderation
  ON public.product_reviews (status, created_at DESC, id DESC);

-- Shared daily anti-flood cap counts rows by created_at (identifier-free).
CREATE INDEX IF NOT EXISTS idx_product_reviews_created_at
  ON public.product_reviews (created_at);
