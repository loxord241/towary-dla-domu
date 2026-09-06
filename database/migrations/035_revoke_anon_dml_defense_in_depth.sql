-- 035: security hardening — revoke leftover DML grants on the import-staging
-- and feedback tables from anon/authenticated (2026-09 security audit).
--
-- WHY:
--   The live audit (information_schema.role_table_grants) still shows
--   anon/authenticated holding INSERT/UPDATE/DELETE on yc_import_batches
--   (010), yc_content_goods and yc_content_batches (011) and feedback (013).
--   As with the catalog tables (033), the ALL-privilege grants come from
--   Supabase platform default privileges applied at table creation — they
--   are not present in this repo's migrations. Today every write to these
--   tables goes through the service-role key (yugcontract import scripts,
--   /api/feedback) and RLS deny-all blocks anon/authenticated writes, so
--   there is NO current exploitation path. This migration is defense in
--   depth: a future accidental `ALTER TABLE ... DISABLE ROW LEVEL
--   SECURITY` or an overly broad policy would otherwise silently expose
--   these tables to writes by anyone with a publishable key. TRIGGER and
--   REFERENCES are revoked as well (a granted DML set plus default
--   privileges can otherwise leave trigger-creation / FK-attachment paths
--   open).
--
--   !!! NOT APPLIED AUTOMATICALLY !!!
--   This migration must be applied MANUALLY by the owner via the Supabase
--   SQL Editor (or psql with the service credentials): the application has
--   no DATABASE_URL / DDL access by design, and no deploy step runs
--   database/migrations/*.sql. Until it is applied, the live database keeps
--   the grants described above (harmless while RLS deny-all holds).
--
-- SAFETY:
--   * SELECT is intentionally NOT revoked: feedback rows may be read by
--     RLS policies / admin tooling, and reads remain governed by RLS;
--   * service_role and postgres keep ALL their privileges — all write
--     paths (yugcontract import batches/content staging, /api/feedback)
--     use the service-role server client (verified by grep over app/ +
--     scripts/);
--   * REVOKE is idempotent: safe to re-run.

revoke insert, update, delete, trigger, references on table public.yc_import_batches from anon, authenticated;
revoke insert, update, delete, trigger, references on table public.yc_content_goods from anon, authenticated;
revoke insert, update, delete, trigger, references on table public.yc_content_batches from anon, authenticated;
revoke insert, update, delete, trigger, references on table public.feedback from anon, authenticated;
