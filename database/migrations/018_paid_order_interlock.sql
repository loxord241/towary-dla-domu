-- Migration 018: paid-order cancellation interlock (B2)
--
-- Guarantees:
--   * admin_cancel_order refuses to cancel an order whose payment has been
--     captured (payment_status = 'paid') — previously it checked only the
--     fulfilment status ('pending'/'confirmed'), so an operator (or the
--     expiry RPC) could restore stock for an order while the customer's
--     card remained charged, with no refund flow to reconcile it.
--   * Cancellation of unpaid/pending/failed-payment orders is unchanged.
--   * Cancellation after a refund (payment_status = 'refunded') remains
--     legitimate: the money has already been returned to the payer.
--
-- Defense-in-depth context:
--   1. PATCH /api/admin/orders/[id] reads payment_status BEFORE calling this
--      RPC and maps a paid order to HTTP 409 (works even without migration).
--   2. This DB-level guard is authoritative once applied.
--   3. The payment side is covered separately by applyPaid's
--      .neq('status','cancelled') conditional qualifier (B1 interlock).
--
-- Scope guard: expire_pending_orders() is NOT touched here (its candidate
-- filter already excludes paid orders since migration 017; within one
-- transaction its row locks also prevent a callback from interleaving).
-- LiqPay bookkeeping columns are NOT touched.
--
-- Application note: DDL is not available from application code in this
-- project — apply manually via the Supabase SQL Editor ONLY on a separate
-- explicit GO. Re-runnable (CREATE OR REPLACE + idempotent statements).

begin;

create or replace function public.admin_cancel_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        text;
  v_number     text;
  v_payment    text;
  v_updated    int;
  v_new_stock  int;
  v_line       record;
begin
  select status, order_number, payment_status into v_old, v_number, v_payment
    from orders
    where id = p_order_id
    for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0404';
  end if;
  if v_old = 'cancelled' then
    raise exception 'ALREADY_CANCELLED' using errcode = 'P0409';
  end if;
  -- B2 interlock: captured money must go through a refund flow, never
  -- through plain cancellation. Must fire BEFORE any stock movement.
  if v_payment = 'paid' then
    raise exception 'PAID_ORDER_NOT_CANCELLABLE' using errcode = 'P0409';
  end if;
  if v_old not in ('pending', 'confirmed') then
    raise exception 'INVALID_TRANSITION' using errcode = 'P0409';
  end if;

  -- The conditional UPDATE is the idempotency gate: stock is restored only
  -- when the row is still in a cancellable state within this transaction.
  update orders
    set status = 'cancelled'
    where id = p_order_id and status in ('pending', 'confirmed');
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'ALREADY_CANCELLED' using errcode = 'P0409';
  end if;

  -- Restore stock for every line and write audit history rows.
  for v_line in
    select product_id, variant_id, quantity
      from order_items
      where order_id = p_order_id
  loop
    if v_line.variant_id is null then
      update products
        set stock_quantity = stock_quantity + v_line.quantity
        where id = v_line.product_id
        returning stock_quantity into v_new_stock;
      insert into product_stock_history
        (product_id, old_quantity, new_quantity, reason, source)
      values
        (v_line.product_id, v_new_stock - v_line.quantity, v_new_stock, 'return', 'web');
    else
      update product_variants
        set stock_quantity = stock_quantity + v_line.quantity
        where id = v_line.variant_id
        returning stock_quantity into v_new_stock;
      insert into product_stock_history
        (product_id, variant_id, old_quantity, new_quantity, reason, source)
      select
        product_id, v_line.variant_id,
        v_new_stock - v_line.quantity, v_new_stock, 'return', 'web'
      from product_variants
      where id = v_line.variant_id;
    end if;
  end loop;

  return jsonb_build_object(
    'order_id',     p_order_id,
    'order_number', v_number,
    'old_status',   v_old,
    'new_status',   'cancelled',
    'restocked_lines', (
      select count(*) from order_items where order_id = p_order_id
    )
  );
end;
$$;

revoke all on function public.admin_cancel_order(uuid) from public;
-- Supabase default privileges explicitly grant EXECUTE on new functions to
-- anon/authenticated; a PUBLIC-only revoke does not remove those. These
-- admin RPCs must be callable by service_role exclusively.
revoke execute on function public.admin_cancel_order(uuid) from anon, authenticated;
grant execute on function public.admin_cancel_order(uuid) to service_role;

commit;
