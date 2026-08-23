-- Migration 007: Orders administration
-- Adds atomic, service-role-only RPCs for order status management:
--   admin_set_order_status(uuid, text) — forward transitions (map enforced)
--   admin_cancel_order(uuid)           — atomic cancel with one-shot stock restore
--
-- Security model:
--   * SECURITY DEFINER + SET search_path = public
--   * EXECUTE granted ONLY to service_role (called exclusively from
--     requireAdminApi()-guarded route handlers); PUBLIC revoked.
--   * Clients never pass prices/totals/stock — only ids and target status.
--
-- Double-restock protection:
--   admin_cancel_order flips the status with a conditional UPDATE
--   ... WHERE status IN ('pending','confirmed') in the SAME transaction as
--   the stock restore. A second call finds no matching row -> P0409 and no
--   stock movement.

begin;

create or replace function public.admin_set_order_status(p_order_id uuid, p_new_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old      text;
  v_number   text;
  v_allowed  boolean;
begin
  -- 'cancelled' has a dedicated atomic path (stock restore) and must go
  -- through admin_cancel_order instead.
  if p_new_status not in ('pending', 'confirmed', 'shipped', 'delivered', 'returned') then
    raise exception 'INVALID_STATUS' using errcode = 'P0400';
  end if;

  select status, order_number into v_old, v_number
    from orders
    where id = p_order_id
    for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0404';
  end if;

  -- Forward-only transition map. Cancelled/returned are terminal.
  v_allowed :=
       (v_old = 'pending'   and p_new_status = 'confirmed')
    or (v_old = 'confirmed' and p_new_status = 'shipped')
    or (v_old = 'shipped'   and p_new_status = 'delivered')
    or (v_old = 'shipped'   and p_new_status = 'returned')
    or (v_old = 'delivered' and p_new_status = 'returned');

  if not v_allowed then
    raise exception 'INVALID_TRANSITION' using errcode = 'P0409';
  end if;

  update orders set status = p_new_status where id = p_order_id;

  return jsonb_build_object(
    'order_id',     p_order_id,
    'order_number', v_number,
    'old_status',   v_old,
    'new_status',   p_new_status
  );
end;
$$;

create or replace function public.admin_cancel_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        text;
  v_number     text;
  v_updated    int;
  v_new_stock  int;
  v_line       record;
begin
  select status, order_number into v_old, v_number
    from orders
    where id = p_order_id
    for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0404';
  end if;
  if v_old = 'cancelled' then
    raise exception 'ALREADY_CANCELLED' using errcode = 'P0409';
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

revoke all on function public.admin_set_order_status(uuid, text) from public;
revoke all on function public.admin_cancel_order(uuid) from public;
-- Supabase default privileges explicitly grant EXECUTE on new functions to
-- anon/authenticated; a PUBLIC-only revoke does not remove those. These
-- admin RPCs must be callable by service_role exclusively.
revoke execute on function public.admin_set_order_status(uuid, text) from anon, authenticated;
revoke execute on function public.admin_cancel_order(uuid) from anon, authenticated;
grant execute on function public.admin_set_order_status(uuid, text) to service_role;
grant execute on function public.admin_cancel_order(uuid) to service_role;

commit;
