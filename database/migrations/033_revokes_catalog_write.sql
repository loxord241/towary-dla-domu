-- 033: security hardening — revoke INSERT/UPDATE/DELETE on catalog tables
-- from anon/authenticated (2026-09 security hardening stage).
--
-- WHY:
--   The live audit (information_schema.role_table_grants) still shows
--   anon/authenticated holding INSERT/UPDATE/DELETE on every public
--   catalog table created through the Supabase platform (Supabase default
--   privileges grant ALL to anon/authenticated at table creation). Today
--   these writes are blocked only by RLS-with-no-policy ("invisible
--   table" semantics): a future RLS disable or an overly broad policy
--   would silently expose catalog writes to anyone with a JWT.
--   Migration 014 did this for orders/order_items/customers; migration
--   024 revoked TRUNCATE schema-wide. This migration closes the remaining
--   write-grant gap on the catalog surface.
--
-- SOURCE OF THE GRANTS:
--   Not present in this repo's migrations (final_001 grants only
--   "SELECT ... TO public" default privileges). The ALL-privilege grants
--   come from Supabase platform defaults applied at table creation. New
--   tables created by postgres may therefore re-acquire write grants for
--   anon/authenticated — prefer creating tables via tracked migrations
--   with explicit grants.
--
-- SAFETY:
--   * service_role and postgres keep ALL their privileges (all catalog
--     write paths go through the service-role server client, admin APIs
--     or SECURITY DEFINER RPCs — verified by grep over app/ + scripts/);
--   * public reads are unaffected: SELECT stays granted, RLS governs it;
--   * REVOKE is idempotent: safe to re-run.

revoke insert, update, delete on table public.products from anon, authenticated;
revoke insert, update, delete on table public.product_variants from anon, authenticated;
revoke insert, update, delete on table public.product_images from anon, authenticated;
revoke insert, update, delete on table public.categories from anon, authenticated;
revoke insert, update, delete on table public.brands from anon, authenticated;
revoke insert, update, delete on table public.attributes from anon, authenticated;
revoke insert, update, delete on table public.attribute_values from anon, authenticated;
revoke insert, update, delete on table public.attribute_values_translations from anon, authenticated;
revoke insert, update, delete on table public.products_translations from anon, authenticated;
revoke insert, update, delete on table public.categories_translations from anon, authenticated;
revoke insert, update, delete on table public.brands_translations from anon, authenticated;
revoke insert, update, delete on table public.attributes_translations from anon, authenticated;
revoke insert, update, delete on table public.product_categories from anon, authenticated;
revoke insert, update, delete on table public.product_reviews from anon, authenticated;
revoke insert, update, delete on table public.store_announcements from anon, authenticated;
