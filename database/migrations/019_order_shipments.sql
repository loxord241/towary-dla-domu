-- Migration 019: delivery shipments model (stage 1 — data structure only)
--
-- Introduces the one-order-to-many-shipments model that will later carry
-- Nova Post shipments:
--
--   orders 1 → N order_shipments 1 → N order_shipment_items N → 1 order_items
--
-- Scope guard (stage 1, explicit GO 2026-08-27):
--   * NO Nova Post API calls, NO TTN creation, NO tracking — this file only
--     creates the data structure TTN numbers/refs will be stored into;
--   * order.prepayment_amount is added as a nullable column so the money
--     invariant is expressible, but NOTHING writes it and the existing
--     LiqPay flow (createPaymentInit/processLiqPayCallback/place_order/
--     admin_cancel_order/expire_pending_orders) is NOT touched;
--   * shipment splitting is performed manually by the manager; the system
--     never decides oversize/acceptability (no weight/dimension catalog
--     fields are added on products).
--
-- Money invariant (enforced by a DEFERRABLE constraint trigger):
--     SUM(order_shipments.cod_amount)
--       = orders.total_amount - orders.prepayment_amount
--   checked only once orders.prepayment_amount IS NOT NULL (until the
--   prepayment stage is implemented it stays NULL and shipments are free);
--   verified on every mutation of order_shipments for the affected order.
--
-- Allocation invariant (second constraint trigger):
--   the sum of an order_item's quantity allocated across all its shipments
--   must never exceed the ordered quantity (partial allocation is allowed;
--   a single item may also be split across several shipments).
--
-- Security (final_001 footgun: ALTER DEFAULT PRIVILEGES GRANT SELECT TO
-- public makes every new table world-readable):
--   * RLS ENABLED with ZERO policies (default deny, same as orders);
--   * belt-and-suspenders REVOKE ALL from anon, authenticated (014/006
--     pattern) — service_role bypasses RLS and keeps its grants;
--   * trigger functions: REVOKE EXECUTE from public/anon/authenticated
--     (Supabase default-privilege footgun documented in 018), GRANT to
--     service_role only.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
-- guarded triggers/indexes, CREATE OR REPLACE functions. Rerunnable.

begin;

-- ============================ ORDERS ============================

-- Nullable until the prepayment stage; never written by this migration.
alter table orders add column if not exists prepayment_amount numeric(12, 2);

-- ============================ ORDER_SHIPMENTS ============================

create table if not exists order_shipments (
    id                      uuid default uuid_generate_v4() primary key,
    order_id                uuid not null references orders(id) on delete cascade,

    -- Display/processing order within the order (1, 2, …). Unique per order.
    shipment_index          integer not null,

    -- Delivery mode: Nova Post branch locker/office vs courier to address.
    service_type            text not null,
    city_ref                text not null,
    city_name               text,
    warehouse_ref           text,
    warehouse_name          text,
    address                 text,

    -- Destination XOR: branch shipments point at a warehouse ref, courier
    -- shipments at a free-text address — never both, never neither.
    constraint chk_order_shipments_destination check (
        (service_type = 'nova_poshta_warehouse'
            and warehouse_ref is not null and address is null)
        or
        (service_type = 'nova_poshta_courier'
            and address is not null and warehouse_ref is null)
    ),

    -- Shipment lifecycle, independent of orders.status.
    -- planned    — row created (manual split), TTN not yet requested
    -- created    — TTN exists, not yet picked up by courier
    -- rejected   — carrier refused the shipment parameters (np_last_error*)
    -- in_transit — courier picked up / moving
    -- arrived    — arrived at recipient warehouse / with courier (Doors)
    -- delivered  — delivered, not yet received
    -- received   — received by customer
    -- refused    — customer refused
    -- returned   — returned to sender
    -- cancelled  — shipment abandoned (e.g. order cancelled pre-pickup)
    status                  text not null default 'planned'
                            constraint chk_order_shipments_status check (status in (
                                'planned', 'created', 'rejected', 'in_transit', 'arrived',
                                'delivered', 'received', 'refused', 'returned', 'cancelled'
                            )),

    -- Carrier identifiers. Written by a later stage; unique so a TTN can
    -- never be attached to two shipments.
    ttn_number              text,   -- IntDocNumber (customer-visible)
    ttn_ref                 text,   -- provider-side Ref (edit/delete/tracking)

    -- Money. cod_amount is the cash-on-delivery sum of THIS shipment;
    -- Σ cod_amount over the order is pinned by the trigger below.
    delivery_cost           numeric(12, 2),
    delivery_cost_estimated numeric(12, 2),
    cod_amount              numeric(12, 2) not null,

    -- Cargo parameters snapshot (stage-2 input, informational only here).
    cargo_type              text,
    weight                  numeric(10, 2),
    volume_general          numeric(12, 6),
    seats_amount            integer,
    cost_of_goods           numeric(12, 2),
    description             text,
    is_oversized            boolean default false,

    -- Last provider error (classification + message), for admin retries.
    np_last_error_code      text,
    np_last_error           text,

    status_checked_at       timestamptz,
    created_at              timestamptz default now(),
    updated_at              timestamptz default now(),

    constraint chk_order_shipments_cod_amount check (cod_amount >= 0),
    constraint chk_order_shipments_weight check (weight is null or weight > 0),
    constraint chk_order_shipments_seats check (seats_amount is null or seats_amount > 0),
    constraint uq_order_shipments_order_index unique (order_id, shipment_index)
);

-- A TTN must map to at most one shipment (mirrors idx_orders_liqpay_order_id).
create unique index if not exists uq_order_shipments_ttn_number
    on order_shipments(ttn_number) where ttn_number is not null;
create unique index if not exists uq_order_shipments_ttn_ref
    on order_shipments(ttn_ref) where ttn_ref is not null;

drop trigger if exists update_order_shipments_updated_at on order_shipments;
create trigger update_order_shipments_updated_at
    before update on order_shipments
    for each row execute function update_updated_at_column();

-- ============================ ORDER_SHIPMENT_ITEMS ============================
-- Partial allocation: one order_item may be split across shipments, and one
-- shipment may carry several order_items. quantity is the allocated part.

create table if not exists order_shipment_items (
    shipment_id   uuid not null references order_shipments(id) on delete cascade,
    order_item_id uuid not null references order_items(id) on delete cascade,
    quantity      integer not null,

    primary key (shipment_id, order_item_id),
    constraint chk_order_shipment_items_quantity check (quantity > 0)
);

create index if not exists idx_order_shipment_items_order_item
    on order_shipment_items(order_item_id);

-- ============================ MONEY INVARIANT ============================
-- Σ cod_amount per order must equal total_amount - prepayment_amount once
-- prepayment_amount is known. DEFERRABLE INITIALLY DEFERRED so a manager
-- can rebalance two shipments inside one transaction (move items, update
-- cod_amounts) without transient-mismatch failures.

create or replace function public.assert_shipments_cod_sum()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order_id  uuid;
    v_total     numeric(12, 2);
    v_prepaid   numeric(12, 2);
    v_expected  numeric(12, 2);
    v_actual    numeric(12, 2);
begin
    v_order_id := case tg_op when 'DELETE' then old.order_id else new.order_id end;

    select total_amount, prepayment_amount
      into v_total, v_prepaid
      from orders
      where id = v_order_id;
    if not found or v_prepaid is null then
        -- Invariant activates only when the prepayment stage has set the
        -- prepayment amount; until then shipments are unconstrained.
        return null;
    end if;
    v_expected := v_total - v_prepaid;

    select coalesce(sum(cod_amount), 0)
      into v_actual
      from order_shipments
      where order_id = v_order_id;

    if v_actual <> v_expected then
        raise exception 'COD_SUM_MISMATCH: sum(cod_amount)=% expected=% (order %)',
            v_actual, v_expected, v_order_id
            using errcode = 'P0409';
    end if;
    return null;
end;
$$;

drop trigger if exists trg_shipments_cod_sum on order_shipments;
create constraint trigger trg_shipments_cod_sum
    after insert or update or delete on order_shipments
    deferrable initially deferred
    for each row
    execute function public.assert_shipments_cod_sum();

-- ============================ ALLOCATION INVARIANT ============================
-- A single order_item may be allocated to several shipments in parts, but
-- the parts must never exceed the ordered quantity.

create or replace function public.assert_shipment_items_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item_id   uuid;
    v_ordered   integer;
    v_allocated integer;
begin
    v_item_id := case tg_op when 'DELETE' then old.order_item_id else new.order_item_id end;

    select quantity into v_ordered from order_items where id = v_item_id;
    if not found then
        -- The parent order_item is already gone inside this transaction.
        -- This happens during ON DELETE CASCADE: the cascade deletes rows
        -- here and fires this trigger per deleted row, while the order_item
        -- itself may already be removed (order_items → order_shipment_items
        -- cascade, or the whole order). The allocation is being cleaned up,
        -- so there is nothing to validate — never block the cascade.
        return null;
    end if;

    select coalesce(sum(quantity), 0)
      into v_allocated
      from order_shipment_items
      where order_item_id = v_item_id;

    if v_allocated > v_ordered then
        raise exception 'SHIPMENT_ITEM_OVERALLOCATED: allocated=% ordered=% (item %)',
            v_allocated, v_ordered, v_item_id
            using errcode = 'P0409';
    end if;
    return null;
end;
$$;

drop trigger if exists trg_shipment_items_allocation on order_shipment_items;
create constraint trigger trg_shipment_items_allocation
    after insert or update or delete on order_shipment_items
    deferrable initially deferred
    for each row
    execute function public.assert_shipment_items_allocation();

-- ============================ SECURITY ============================
-- RLS enabled + zero policies = default deny (same model as orders).
-- Explicit revokes are defense-in-depth against the final_001 default
-- "GRANT SELECT ON TABLES TO public" and future accidental policies.

alter table order_shipments enable row level security;
alter table order_shipment_items enable row level security;

revoke all on order_shipments from anon, authenticated;
revoke all on order_shipment_items from anon, authenticated;

-- Trigger functions are security definer: executable by service_role only.
revoke all on function public.assert_shipments_cod_sum() from public;
revoke execute on function public.assert_shipments_cod_sum() from anon, authenticated;
grant execute on function public.assert_shipments_cod_sum() to service_role;

revoke all on function public.assert_shipment_items_allocation() from public;
revoke execute on function public.assert_shipment_items_allocation() from anon, authenticated;
grant execute on function public.assert_shipment_items_allocation() to service_role;

commit;
