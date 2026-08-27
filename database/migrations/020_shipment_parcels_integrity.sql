-- Migration 020: shipment parcels + cross-order integrity fix (stage 2C-mig)
--
-- 1) CROSS-ORDER INTEGRITY (audit 2C finding):
--    order_shipment_items had two INDEPENDENT FKs (shipment_id, order_item_id),
--    so a shipment of order A could be linked to an order_item of order B.
--    The allocation and COD triggers could not detect this (they aggregate by
--    their own order). Fix = composite-FK pinning:
--      * UNIQUE (order_id, id) on order_shipments and order_items (parents);
--      * new NOT NULL order_shipment_items.order_id, backfilled from the
--        shipment's order (both parent tables are EMPTY in production —
--        verified live before this migration was written);
--      * composite FKs (shipment_id, order_id) -> order_shipments(order_id, id)
--        and (order_item_id, order_id) -> order_items(order_id, id), both
--        ON DELETE CASCADE — if either parent (or the whole order) goes,
--        the link goes with it.
--    With both composite FKs in place, a link row can only exist when its
--    order_id matches BOTH parents, i.e. the parents belong to the same order.
--
-- 2) NEW TABLE order_shipment_parcels:
--    Physical cargo description of a shipment. This is the future SOURCE of
--    Nova Post calculation parameters: one NP "parcel" per row (the live API
--    takes parcels[] with per-place weight/dimensions/insuranceCost — one
--    shipment may consist of several physical places).
--      * weights in GRAMS (integer, multiple of 10 — live API rounding rule),
--        dimensions in MILLIMETERS (integers) — matches the live contract;
--      * insurance_cost: the live API REQUIRES it per parcel; its business
--        semantics are deliberately UNDEFINED at this stage (separate owner
--        decision before stage 2E). The column stores whatever the manager
--        enters; NO automatic derivation from product price, RRP, COD, order
--        total or shipment cost exists anywhere.
--    The flat cargo columns on order_shipments from migration 019 (cargo_type,
--    weight, volume_general, seats_amount, cost_of_goods, description,
--    is_oversized) are NOT deleted, NOT synchronized and MUST NOT be used for
--    Nova Post calculation — order_shipment_parcels is the authoritative
--    physical-parameters source going forward.
--
-- 3) Additional CHECK constraints from the audit: shipment_index > 0 and
--    non-negative money/volume columns (NULL stays allowed by SQL semantics).
--
-- Security: same pattern as migration 019 — RLS enabled, zero policies
-- (default deny), belt-and-suspenders REVOKE ALL from anon/authenticated
-- (final_001 default-privileges footgun), service_role keeps full access.
--
-- Scope guard (stage 2C-mig, explicit GO): no checkout/payment/LiqPay
-- changes, no place_order/admin_cancel_order/expire_pending_orders changes,
-- no admin UI/API, no Nova Post client changes, no app logic for parcels.
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT EXISTS,
-- guarded DO-blocks, CREATE OR REPLACE-free. Rerunnable. Wrapped in one
-- transaction — no partial application.

begin;

-- ==================== PARENT UNIQUE INDEXES ====================
-- Required as FK targets for the composite pinning below.

create unique index if not exists uq_order_shipments_order_id_id
    on order_shipments(order_id, id);
create unique index if not exists uq_order_items_order_id_id
    on order_items(order_id, id);

-- ==================== CHILD ORDER_ID + COMPOSITE FKs ====================

alter table order_shipment_items
    add column if not exists order_id uuid;

-- Backfill from the shipment's order. Production table is empty today;
-- this keeps reruns and any future staging data consistent.
update order_shipment_items si
    set order_id = s.order_id
    from order_shipments s
    where s.id = si.shipment_id and si.order_id is null;

-- Refuse to proceed if any existing data is cross-order (defensive — the
-- table is empty in production, but this makes the migration honest).
do $$
begin
    if exists (
        select 1
          from order_shipment_items si
          join order_items oi on oi.id = si.order_item_id
         where si.order_id is null
            or oi.order_id is null
            or oi.order_id <> si.order_id
    ) then
        raise exception 'ORDER_SHIPMENT_ITEMS_CROSS_ORDER_DATA'
            using errcode = 'P0001';
    end if;
end $$;

alter table order_shipment_items
    alter column order_id set not null;

-- Replace the independent FKs with order-pinning composite FKs.
alter table order_shipment_items
    drop constraint if exists fk_order_shipment_items_shipment_order;
alter table order_shipment_items
    add constraint fk_order_shipment_items_shipment_order
    foreign key (shipment_id, order_id)
    references order_shipments(order_id, id)
    on delete cascade;

alter table order_shipment_items
    drop constraint if exists fk_order_shipment_items_item_order;
alter table order_shipment_items
    add constraint fk_order_shipment_items_item_order
    foreign key (order_item_id, order_id)
    references order_items(order_id, id)
    on delete cascade;

-- ==================== 019 AUDIT CHECK CONSTRAINTS ====================

alter table order_shipments
    drop constraint if exists chk_order_shipments_index;
alter table order_shipments
    add constraint chk_order_shipments_index check (shipment_index > 0);

-- CHECK with NULL operand evaluates to NULL -> passes: NULL stays allowed.
alter table order_shipments
    drop constraint if exists chk_order_shipments_volume_general;
alter table order_shipments
    add constraint chk_order_shipments_volume_general
    check (volume_general >= 0);

alter table order_shipments
    drop constraint if exists chk_order_shipments_cost_of_goods;
alter table order_shipments
    add constraint chk_order_shipments_cost_of_goods
    check (cost_of_goods >= 0);

alter table order_shipments
    drop constraint if exists chk_order_shipments_delivery_cost;
alter table order_shipments
    add constraint chk_order_shipments_delivery_cost
    check (delivery_cost >= 0);

alter table order_shipments
    drop constraint if exists chk_order_shipments_delivery_cost_estimated;
alter table order_shipments
    add constraint chk_order_shipments_delivery_cost_estimated
    check (delivery_cost_estimated >= 0);

-- ==================== ORDER_SHIPMENT_PARCELS ====================

create table if not exists order_shipment_parcels (
    id                  uuid default uuid_generate_v4() primary key,
    shipment_id         uuid not null
                        references order_shipments(id) on delete cascade,

    -- NP parcels[].rowNumber (1, 2, …) — order of places within a shipment.
    parcel_index        integer not null,

    -- NP cargoCategory whitelist (live API enum).
    cargo_category      text not null
                        constraint chk_order_shipment_parcels_category
                        check (cargo_category in ('parcel', 'documents', 'pallet')),

    -- Live API: actualWeight in GRAMS, "precision up to 10 grams",
    -- "round to the nearest 10 g before sending" -> enforced here.
    actual_weight_grams integer not null
                        constraint chk_order_shipment_parcels_weight
                        check (actual_weight_grams > 0
                               and actual_weight_grams % 10 = 0),

    -- Live API: dimensions in MILLIMETERS, integers > 0. Required by the
    -- live calculation endpoint even though the docs mark them optional.
    width_mm            integer not null
                        constraint chk_order_shipment_parcels_width
                        check (width_mm > 0),
    length_mm           integer not null
                        constraint chk_order_shipment_parcels_length
                        check (length_mm > 0),
    height_mm           integer not null
                        constraint chk_order_shipment_parcels_height
                        check (height_mm > 0),

    -- Live API: required per parcel. Business semantics UNDEFINED —
    -- manager-entered value, never derived by the application
    -- (decision expected before stage 2E).
    insurance_cost      numeric(12, 2) not null
                        constraint chk_order_shipment_parcels_insurance
                        check (insurance_cost > 0),

    description         text,
    created_at          timestamptz default now(),
    updated_at          timestamptz default now(),

    constraint uq_order_shipment_parcels_index
        unique (shipment_id, parcel_index)
);

create index if not exists idx_order_shipment_parcels_shipment
    on order_shipment_parcels(shipment_id);

drop trigger if exists update_order_shipment_parcels_updated_at
    on order_shipment_parcels;
create trigger update_order_shipment_parcels_updated_at
    before update on order_shipment_parcels
    for each row execute function update_updated_at_column();

-- ==================== SECURITY ====================
-- Same model as order_shipments (019): RLS default-deny + explicit revokes.

alter table order_shipment_parcels enable row level security;

revoke all on order_shipment_parcels from anon, authenticated;

-- No new business triggers: parcels do NOT participate in the allocation
-- invariant (items are allocated to shipments, not parcels) and do NOT
-- change the COD invariant (cod_amount lives on the shipment).

commit;
