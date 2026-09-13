-- Migration 048: Nova Poshta tracking status cache (owner task 2026-09-13,
-- key provided by owner).
--
-- order_shipments gets denormalized live-status columns refreshed from the
-- NP internet API (getStatusDocuments) by the server, only when stale —
-- page renders read the cache; the provider is never hit per pageload.
--
-- np_status keeps the provider's raw Ukrainian text («В дорозі», …) — the
-- mapping table is NP's own; we never invent statuses.
--
-- Re-run safety: add column if not exists.

begin;

alter table order_shipments add column if not exists np_status text;
alter table order_shipments add column if not exists np_status_checked_at timestamptz;

commit;

-- VERIFY-PRE:
--   select column_name from information_schema.columns
--    where table_name='order_shipments' and column_name like 'np_%'; -- 0 rows
-- VERIFY-POST:
--   select column_name from information_schema.columns
--    where table_name='order_shipments' and column_name like 'np_%';
--   -- np_status, np_status_checked_at
