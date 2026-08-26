-- Migration 017: LiqPay payment integration
--
-- 1) Adds the minimal LiqPay bookkeeping columns to orders:
--      liqpay_payment_id bigint   — LiqPay transaction_id (numeric provider id)
--      liqpay_order_id    text    — per-attempt checkout order_id
--                                   (ORD-…, ORD-…:2, ORD-…:3 …), unique
--      paid_at            timestamptz — when the order became `paid`
--      payment_method     text        — e.g. "card:privat24"
--      payment_error      text        — err_code/err_description on failures
--    Deliberately NOT stored: raw callback payloads, result/payment URLs,
--    or a redundant second transaction id.
--
-- 2) REGRESSION FIX (planned alongside this integration): the pre-existing
--    expire_pending_orders() selected candidates by status='pending' ONLY,
--    so an order that was already PAID but not yet moved to a fulfilment
--    status would be auto-cancelled and its stock double-restored once
--    payment callbacks started landing in production. The function is
--    re-created here with `payment_status is distinct from 'paid'` added to
--    the candidate filter. Logic is otherwise byte-for-byte identical to
--    migration 008 (admin_cancel_order reuse, SKIP LOCKED, same grants).
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, guarded indexes, CREATE OR REPLACE.

begin;

-- ============================ COLUMNS ============================

alter table orders add column if not exists liqpay_payment_id bigint;
alter table orders add column if not exists liqpay_order_id text;
alter table orders add column if not exists paid_at timestamptz;
alter table orders add column if not exists payment_method text;
alter table orders add column if not exists payment_error text;

-- One attempt id must map to at most one order — callbacks are keyed on it.
create unique index if not exists idx_orders_liqpay_order_id
  on orders(liqpay_order_id)
  where liqpay_order_id is not null;

create index if not exists idx_orders_liqpay_payment_id
  on orders(liqpay_payment_id)
  where liqpay_payment_id is not null;

-- ==================== EXPIRE_PENDING_ORDERS FIX ====================
-- Only change vs migration 008: exclude already-paid orders from expiry.
-- Rationale: expire_pending_orders cancels via admin_cancel_order() when a
-- pending order passes expires_at; with LiqPay the payment may arrive AFTER
-- expires_at was written (payment completes inside the session lifetime),
-- and cancelling a paid order must be impossible.

create or replace function public.expire_pending_orders(p_batch_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids        uuid[];
  v_id         uuid;
  v_result     jsonb;
  v_expired    int := 0;
  v_numbers    text[] := '{}';
  v_effective_limit int;
begin
  v_effective_limit := least(greatest(coalesce(p_batch_limit, 200), 1), 1000);

  select coalesce(array_agg(id), '{}') into v_ids
    from (
      select id
        from orders
        where status = 'pending'
          and payment_status is distinct from 'paid'
          and expires_at is not null
          and expires_at < now()
        order by expires_at asc
        limit v_effective_limit
        for update skip locked
    ) candidates;

  foreach v_id in array v_ids loop
    v_result := public.admin_cancel_order(v_id);
    v_expired := v_expired + 1;
    v_numbers := v_numbers || (v_result->>'order_number');
  end loop;

  return jsonb_build_object(
    'expired', v_expired,
    'orders', to_jsonb(v_numbers)
  );
end;
$$;

-- Fast candidate scan at scale (already created by migration 008; kept here
-- so replaying this file alone yields a working setup).
create index if not exists idx_orders_pending_expires
  on orders(expires_at)
  where status = 'pending' and expires_at is not null;

revoke all on function public.expire_pending_orders(int) from public;
revoke execute on function public.expire_pending_orders(int) from anon, authenticated;
grant execute on function public.expire_pending_orders(int) to service_role;

commit;
