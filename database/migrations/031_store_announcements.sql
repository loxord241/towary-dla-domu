-- Store announcements (2026-09-02, supplier supply-disruption warnings).
--
-- A small admin-managed notice system for the storefront: the admin creates
-- and toggles announcements in /admin/announcements, the storefront renders
-- the ACTIVE ones (home, catalog, PDP, cart) ordered by sort_order.
--
-- Security model (mirrors feedback 013 / product_reviews 015):
--   - RLS is enabled; the ONLY public policy is SELECT of active rows for
--     anon/authenticated — the storefront can never see drafts;
--   - no INSERT/UPDATE/DELETE policy exists: writes happen exclusively
--     through the guarded /api/admin/announcements route, whose
--     service-role client operates only after requireAdminApi() verified
--     the caller against admin_users.
--
-- Publishing contract (owner decision 2026-09-02): the seeded templates
-- below are ALL is_active = false. The migration itself never publishes
-- anything; the «Неповні поставки» warning is enabled via the admin UI
-- after the migration is applied.

CREATE TABLE IF NOT EXISTS public.store_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  type text NOT NULL DEFAULT 'info'
    CHECK (type IN ('info', 'warning', 'important', 'success')),
  is_active boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.store_announcements ENABLE ROW LEVEL SECURITY;

-- Storefront visibility: active rows only, for both anon (public pages)
-- and authenticated (cart) visitors. Draft rows stay invisible.
CREATE POLICY store_announcements_public_select
  ON public.store_announcements
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);

-- Covering index for the single storefront lookup:
-- WHERE is_active ORDER BY sort_order.
CREATE INDEX IF NOT EXISTS idx_store_announcements_active_order
  ON public.store_announcements (is_active, sort_order);

-- Seed templates (ALL inactive — see the publishing contract above).
INSERT INTO public.store_announcements (title, message, type, is_active, sort_order)
VALUES
  (
    'Неповні поставки',
    'Через тимчасові перебої на складах постачальника деякі товари можуть бути доступні не в повному обсязі.',
    'warning',
    false,
    0
  ),
  (
    'Затримка обробки замовлень',
    'Обробка замовлень може тривати трохи довше, ніж зазвичай.',
    'info',
    false,
    10
  ),
  (
    'Затримка доставки',
    'Термін доставки окремих замовлень може бути збільшений.',
    'info',
    false,
    20
  ),
  (
    'Тимчасова недоступність',
    'Деякі товари можуть бути тимчасово недоступні для замовлення.',
    'info',
    false,
    30
  ),
  (
    'Технічні роботи',
    'Окремі функції магазину можуть бути тимчасово недоступні.',
    'info',
    false,
    40
  );
