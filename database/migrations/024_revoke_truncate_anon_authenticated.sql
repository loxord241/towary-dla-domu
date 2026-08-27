-- 024: security hardening — revoke TRUNCATE from anon/authenticated on all
-- public tables (2026-08-27 security hardening stage).
--
-- WHY:
--   Live audit (information_schema.role_table_grants, 2026-08-27) showed
--   anon AND authenticated hold TRUNCATE on every public table created
--   through the Supabase platform (orders, admin_users, feedback, products,
--   categories, customers, order_items, product_images, yc_* staging, ...).
--   TRUNCATE is NOT a row-level operation: RLS does not apply to it, so
--   "RLS enabled + no policies" — the defense that currently blocks
--   anon/authenticated writes — does NOT protect against a TRUNCATE.
--   Any future code path executing SQL as anon/authenticated (or an RLS
--   disable mistake) could wipe entire tables, including PII and orders.
--
-- SOURCE OF THE GRANTS:
--   Not present in this repo's migrations (final_001 grants only
--   "SELECT ... TO public" default privileges). The TRUNCATE (and other
--   ALL-privilege) grants come from Supabase platform default privileges
--   applied at table creation. New tables created by postgres may
--   therefore re-acquire TRUNCATE for anon/authenticated — prefer creating
--   tables via tracked migrations with explicit grants.
--
-- SAFETY:
--   * service_role and postgres keep ALL their privileges (backend write
--     paths, SECURITY DEFINER functions, admin APIs are unaffected);
--   * no application code path issues TRUNCATE as anon/authenticated
--     (verified by grep over app/ + scripts/): all writes go through the
--     service-role server client or SECURITY DEFINER RPCs;
--   * TRUNCATE revoke cannot break SELECT/INSERT/UPDATE/DELETE flows.
--
-- SCOPE:
--   ALL TABLES IN SCHEMA public — anon/authenticated never legitimately
--   need TRUNCATE anywhere, and the live audit proved the grant exists on
--   far more tables than the three named in the audit report. Idempotent:
--   REVOKE is safe to re-run.

begin;

revoke truncate on all tables in schema public from anon, authenticated;

commit;
