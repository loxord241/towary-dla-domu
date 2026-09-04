-- Migration 034: unique partial index on orders.liqpay_payment_id.
--
-- WHY:
--   liqpay_payment_id (LiqPay transaction_id, migration 017) is currently
--   covered only by a NON-unique partial index idx_orders_liqpay_payment_id.
--   Nothing at the DB level stops the same provider transaction id from
--   being attached to two orders (a mis-ordered callback, a manual fix, a
--   replayed status write) — the uniqueness of the mapping
--   "one payment = one order" is enforced only by application code.
--
-- AUDIT:
--   SELECT liqpay_payment_id, count(*) FROM orders
--   WHERE liqpay_payment_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   executed against the live DB (2026-09-04): 0 rows — safe to enforce.
--
-- SAFETY / IDEMPOTENCE:
--   * CREATE INDEX CONCURRENTLY: no write-blocking lock on orders while
--     building (concurrent DDL cannot run inside a transaction block, so
--     this file deliberately has NO begin/commit wrapper);
--   * the old non-unique index (017) is dropped — keeping both would
--     double the write amplification for zero benefit. The old NAME is
--     NOT reused for the unique index: a half-applied old deploy (old
--     index still present, new one absent) must never be mistaken for
--     the enforced state;
--   * partial WHERE ... IS NOT NULL kept: NULLs (unpaid orders) are
--     exempt, matching the 017 semantics;
--   * both statements are IF [NOT] EXISTS — safe to re-run.
--
-- NOTE: CONCURRENTLY retries on failure, but a failed first attempt can
-- leave an INVALID index behind; if this migration ever reports an error,
-- drop idx_orders_liqpay_payment_id_unique and re-run.

create unique index concurrently if not exists idx_orders_liqpay_payment_id_unique
  on public.orders(liqpay_payment_id)
  where liqpay_payment_id is not null;

drop index concurrently if exists public.idx_orders_liqpay_payment_id;
