-- Migration 008: Pending order expiration
--
-- expire_pending_orders() cancels pending orders whose expires_at has
-- passed, reusing admin_cancel_order() so the guarantees stay identical:
--   * atomic per-order cancel (status flip + stock restore + history)
--   * double-restock impossible (same conditional-UPDATE gate)
--   * SKIP LOCKED so concurrent runs / admins never deadlock or double-fire
--
-- Re-run safety: candidates are selected WHERE status='pending'; after a
-- successful cancel the row is no longer a candidate. A second invocation
-- therefore returns expired=0 and moves no stock.
--
-- Scheduling (no invented infrastructure):
--   Supabase hosted projects ship the pg_cron extension. Enable it in
--   Dashboard → Database → Extensions, then run ONCE in SQL Editor:
--     select cron.schedule(
--       'expire-pending-orders', '*/10 * * * *',
--       $$ select public.expire_pending_orders(); $$
--     );
--   Until pg_cron is enabled, the function can be triggered manually via
--   POST /api/admin/orders/expire (requireAdminApi + service_role).

begin;

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

-- Fast candidate scan at scale.
create index if not exists idx_orders_pending_expires
  on orders(expires_at)
  where status = 'pending' and expires_at is not null;

revoke all on function public.expire_pending_orders(int) from public;
revoke execute on function public.expire_pending_orders(int) from anon, authenticated;
grant execute on function public.expire_pending_orders(int) to service_role;

commit;

-- Reminder (run separately once pg_cron is enabled):
--   select cron.schedule('expire-pending-orders','*/10 * * * *',
--     $$ select public.expire_pending_orders(); $$);
