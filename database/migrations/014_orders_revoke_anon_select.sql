-- 014: orders P2 hardening — revoke direct SELECT from anon/authenticated
-- on the order-domain tables (2026-08 security audit follow-up).
--
-- WHY (see PROJECT_CONTEXT.md, orders RLS audit):
--   anon reads on orders/order_items/customers were denied ONLY by
--   "RLS enabled + no SELECT policy" (invisible-table semantics), while the
--   SELECT privilege itself stayed granted (Supabase defaults plus the
--   blanket "GRANT SELECT ON TABLES TO public" default privileges from
--   final_001). A future accidental `ALTER TABLE ... DISABLE ROW LEVEL
--   SECURITY` or a broad policy would therefore silently expose all PII
--   (emails, phones, addresses, order contents). product_stock_history
--   already has the stronger defense: its grants were explicitly revoked
--   in 006. This migration gives the three customer-facing order tables
--   the same belt-and-suspenders.
--
-- SAFETY:
--   * place_order() is SECURITY DEFINER (runs as its owner) and keeps its
--     EXECUTE grant to anon — guest checkout is unaffected;
--   * /api/orders/lookup, /orders/[orderNumber], /checkout/success read via
--     the service role server-side — unaffected;
--   * admin API reads via requireAdminApi() service client — unaffected;
--   * no authenticated storefront flow touches these tables today.
--
-- OBSERVABLE EFFECT (verification, scripts/tmp-verify-orders-revoke.mts):
--   anon SELECT on the three tables changes from "success + empty set"
--   to 42501 permission denied — matching product_stock_history.
--
-- Idempotent: REVOKE statements are safe to re-run.

begin;

revoke select on table public.orders from anon, authenticated;
revoke select on table public.order_items from anon, authenticated;
revoke select on table public.customers from anon, authenticated;

commit;

-- NOTE (out of scope here): final_001 also contains
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO public;
-- which auto-grants SELECT on FUTURE tables created by the postgres role.
-- Harmless while every sensitive table enables RLS by convention, but any
-- new PII-bearing table must either enable RLS immediately or be granted
-- explicitly instead of relying on this default.
