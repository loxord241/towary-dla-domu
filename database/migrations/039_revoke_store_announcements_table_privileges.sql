-- Migration 039: revoke dangerous table-level privileges on store_announcements
--
-- WHY:
--   store_announcements (031) was created BEFORE the 032 security_remediation
--   hardening and kept the Supabase-default grant set for anon/authenticated:
--   TRUNCATE, TRIGGER and REFERENCES alongside SELECT. RLS does NOT protect
--   against TRUNCATE — it is a table-level operation, not row-level (same
--   rationale as 024). Any authenticated session could wipe the site-wide
--   announcement banner. Discovered live 2026-09-08 during the MCP-based
--   application of 037/038 (role_table_grants audit).
--
-- SCOPE:
--   * REVOKE TRUNCATE, TRIGGER, REFERENCES from anon, authenticated.
--   * SELECT stays: the storefront banner reads via anon + RLS (1 policy).
--   * postgres / service_role keep full DML (announcement admin API path).
--
-- VERIFY (after):
--   SELECT grantee, privilege_type
--     FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND table_name = 'store_announcements'
--      AND grantee IN ('anon', 'authenticated');
--   -- expected: exactly one row per role, privilege_type = SELECT
--
-- ROLLBACK:
--   grant truncate, trigger, references
--     on public.store_announcements to anon, authenticated;

revoke truncate, trigger, references
    on public.store_announcements
    from anon, authenticated;
