-- Migration 038: Ukrposhta as a second carrier on order_shipments
--
-- WHY:
--   The checkout gains a second delivery option — «Укрпошта — Відділення»
--   (service_type 'ukrposhta_warehouse'). The order-facing side
--   (place_order / orders.shipping_info JSON) is carrier-agnostic and
--   needs NO change: the structured delivery object is whitelisted in the
--   API layer and stored as-is. This migration only widens the ADMIN
--   shipment-plan layer (order_shipments + admin_replace_shipment_plan),
--   which was Nova Post-only:
--     * chk_order_shipments_destination (019) hard-coded
--       nova_poshta_warehouse/nova_poshta_courier destination pairs;
--     * admin_replace_shipment_plan (026) raised SERVICE_TYPE_INVALID for
--       anything outside the nova_poshta pairs.
--
-- SCOPE (additive only):
--   * NEW column order_shipments.carrier text not null default
--     'nova_poshta' + CHECK carrier in ('nova_poshta','ukrposhta');
--     existing rows are backfilled by the default (they are all Nova
--     Post rows — carrier has always been implied).
--   * chk_order_shipments_destination is REPLACED: the destination XOR
--     (warehouse_ref XOR address) becomes carrier-independent and the
--     service_type whitelist gains 'ukrposhta_warehouse'.
--   * admin_replace_shipment_plan is re-created from the 026 version with
--     (a) the extended service_type whitelist, (b) an optional
--     'carrier' key in each plan shipment ('nova_poshta' | 'ukrposhta',
--     default 'nova_poshta'), (c) carrier↔service_type pairing
--     validation (ukrposhta rows must be ukrposhta_warehouse and vice
--     versa), (d) carrier written on insert.
--   * Nova Post roles of city_ref/warehouse_ref are REUSED for Ukrposhta:
--     city_ref = Address Classifier CITY_ID, warehouse_ref = post office
--     ID (both numeric text, both received from the SAME pinned production
--     host www.ukrposhta.ua). KATOTTG/KOATUU stay available in the
--     classifier data as stable cross-references.
--   * NO orders changes, NO money-model changes, NO RLS changes (019
--     default-deny stays), NO trigger changes (COD/allocation invariants
--     are carrier-independent).
--   * nova_poshta_locker stays OUT of the plan whitelist: lockers are
--     planned under 'nova_poshta_warehouse' exactly as before (021
--     semantics), and there is deliberately NO 'ukrposhta_courier'.
--
-- SAFETY / PRE-CHECK (run BEFORE applying; table must be near-empty —
-- as of 2026-09-08 there are 0 real orders):
--     -- rows that would violate the NEW destination XOR (must be 0):
--     SELECT id, service_type, warehouse_ref, address
--       FROM order_shipments
--      WHERE (warehouse_ref IS NULL) = (address IS NULL);
--     -- current plan state snapshot (must be 0 rows or all 'planned'):
--     SELECT status, count(*) FROM order_shipments GROUP BY status;
--
-- VERIFY (run AFTER applying):
--     -- carrier column + backfill:
--     SELECT carrier, count(*) FROM order_shipments GROUP BY carrier;
--     -- new constraint present:
--     SELECT conname FROM pg_constraint
--      WHERE conrelid = 'order_shipments'::regclass
--        AND conname IN ('chk_order_shipments_destination',
--                        'chk_order_shipments_carrier');
--     -- RPC signature/grants unchanged, one definition:
--     SELECT prosrc FROM pg_proc WHERE proname =
--       'admin_replace_shipment_plan';
--     -- ukrposhta plan row is accepted (probe on an empty order):
--     BEGIN;
--       -- insert a throwaway order + item, call the RPC with
--       -- service_type='ukrposhta_warehouse', carrier='ukrposhta',
--       -- then ROLLBACK; expect PLAN applied result jsonb.
--     ROLLBACK;
--
-- ROLLBACK (restore the 019/026 state):
--     begin;
--     alter table order_shipments drop constraint
--       if exists chk_order_shipments_carrier;
--     alter table order_shipments drop column if exists carrier;
--     alter table order_shipments drop constraint
--       if exists chk_order_shipments_destination;
--     alter table order_shipments add constraint
--       chk_order_shipments_destination check (
--         (service_type = 'nova_poshta_warehouse'
--             and warehouse_ref is not null and address is null)
--         or
--         (service_type = 'nova_poshta_courier'
--             and address is not null and warehouse_ref is null)
--       );
--     -- + re-create admin_replace_shipment_plan verbatim from migration
--     -- 026 (it is idempotent to re-run that file's function block).
--     commit;
--
-- Idempotency: ADD COLUMN IF NOT EXISTS, guarded constraint drop/create,
-- CREATE OR REPLACE function, guarded grants. Rerunnable.

begin;

-- ==================== CARRIER COLUMN ====================

alter table order_shipments add column if not exists carrier
    text not null default 'nova_poshta';

alter table order_shipments drop constraint if exists chk_order_shipments_carrier;
alter table order_shipments add constraint chk_order_shipments_carrier
    check (carrier in ('nova_poshta', 'ukrposhta'));

-- ==================== DESTINATION CHECK (carrier-agnostic) ====================
-- Replaces the 019 hard-coded nova_poshta pairing. The XOR becomes purely
-- structural: exactly one of warehouse_ref / address, independent of
-- carrier; the service_type whitelist gains ukrposhta_warehouse.

alter table order_shipments drop constraint if exists chk_order_shipments_destination;
alter table order_shipments add constraint chk_order_shipments_destination check (
    service_type in (
        'nova_poshta_warehouse',
        'nova_poshta_courier',
        'ukrposhta_warehouse'
    )
    and (
        (warehouse_ref is not null and address is null)
        or
        (warehouse_ref is null and address is not null)
    )
);

-- ==================== ADMIN REPLACE SHIPMENT PLAN ====================
-- Re-created from migration 026 with the minimal Ukrposhta extension:
-- extended service_type whitelist + optional carrier key + pairing
-- validation. All existing freeze/validation guarantees (planned-only,
-- no TTN, destination XOR, numeric city_ref/warehouse_ref, COD/allocation
-- triggers) are kept unchanged.

create or replace function public.admin_replace_shipment_plan(
    p_order_id uuid,
    p_plan     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_shipments     jsonb;
    v_n             integer;
    v_sh            jsonb;
    v_items         jsonb;
    v_parcels       jsonb;
    v_it            jsonb;
    v_pa            jsonb;
    v_order_status  text;
    v_locked        integer;
    v_i             integer;
    v_j             integer;
    v_sid           uuid;
    v_iid           uuid;
    v_num           numeric;
    v_int           integer;
    v_carrier       text;
    v_service_type  text;
    v_all_items     uuid[];
    v_distinct_ids  integer;
    v_found         integer;
    v_items_total   integer := 0;
    v_parcels_total integer := 0;
begin
    if p_order_id is null then
        raise exception 'ORDER_ID_REQUIRED: p_order_id is null'
            using errcode = 'P0400';
    end if;
    if p_plan is null
       or jsonb_typeof(p_plan) is distinct from 'object'
       or jsonb_typeof(p_plan -> 'shipments') is distinct from 'array' then
        raise exception 'PLAN_INVALID: p_plan must be {"shipments": [...]}'
            using errcode = 'P0400';
    end if;

    -- Serialize concurrent plan saves for this order.
    select status into v_order_status
      from orders
     where id = p_order_id
      for update;
    if not found then
        raise exception 'ORDER_NOT_FOUND: order % does not exist', p_order_id
            using errcode = 'P0404';
    end if;
    if v_order_status in ('cancelled', 'returned') then
        raise exception 'ORDER_CLOSED: order % is %', p_order_id, v_order_status
            using errcode = 'P0409';
    end if;

    -- Stage 2E freezes the plan: anything past 'planned' (or with a TTN)
    -- must never be replaced by this RPC.
    select count(*) into v_locked
      from order_shipments
     where order_id = p_order_id
       and (status <> 'planned' or ttn_number is not null);
    if v_locked > 0 then
        raise exception
            'SHIPMENTS_LOCKED: order % has % shipment(s) past planned state',
            p_order_id, v_locked
            using errcode = 'P0409';
    end if;

    v_shipments := p_plan -> 'shipments';
    v_n := jsonb_array_length(v_shipments);
    if v_n > 20 then
        raise exception 'PLAN_TOO_LARGE: max 20 shipments per order'
            using errcode = 'P0400';
    end if;

    -- ==================== VALIDATION PASS (no writes) ====================
    for v_i in 0 .. v_n - 1 loop
        v_sh := v_shipments -> v_i;
        if jsonb_typeof(v_sh) is distinct from 'object' then
            raise exception 'SHIPMENT_INVALID: shipments[%] must be an object', v_i
                using errcode = 'P0400';
        end if;

        -- Contiguous 1..n in array order.
        v_int := (v_sh ->> 'shipment_index')::integer;
        if v_int is distinct from v_i + 1 then
            raise exception
                'SHIPMENT_INDEX_INVALID: expected %, got %', v_i + 1, v_sh ->> 'shipment_index'
                using errcode = 'P0400';
        end if;

        v_service_type := coalesce(v_sh ->> 'service_type', '');
        if v_service_type not in
           ('nova_poshta_warehouse', 'nova_poshta_courier', 'ukrposhta_warehouse') then
            raise exception 'SERVICE_TYPE_INVALID: %', v_service_type
                using errcode = 'P0400';
        end if;

        -- Carrier (migration 038): optional key, default nova_poshta;
        -- strict pairing with the service type — an Ukrposhta carrier row
        -- must be ukrposhta_warehouse and a Nova Post row must not.
        v_carrier := coalesce(v_sh ->> 'carrier', 'nova_poshta');
        if v_carrier not in ('nova_poshta', 'ukrposhta') then
            raise exception 'CARRIER_INVALID: %', v_sh ->> 'carrier'
                using errcode = 'P0400';
        end if;
        if (v_carrier = 'ukrposhta') <> (v_service_type = 'ukrposhta_warehouse') then
            raise exception 'SERVICE_TYPE_INVALID: % does not match carrier %',
                v_service_type, v_carrier
                using errcode = 'P0400';
        end if;

        -- Settlement id: numeric text for BOTH carriers (Nova Post
        -- settlementId / Ukrposhta Address Classifier CITY_ID — both ids
        -- are issued by the same pinned host and stored as numeric text).
        if coalesce(v_sh ->> 'city_ref', '') !~ '^[0-9]{1,20}$' then
            raise exception 'CITY_INVALID: city_ref must be a numeric settlement id'
                using errcode = 'P0400';
        end if;

        -- Destination XOR (mirrors chk_order_shipments_destination).
        if v_service_type in ('nova_poshta_warehouse', 'ukrposhta_warehouse') then
            if coalesce(v_sh ->> 'warehouse_ref', '') !~ '^[0-9]{1,20}$' then
                raise exception 'DESTINATION_REQUIRED: warehouse shipment needs a numeric destination id'
                    using errcode = 'P0400';
            end if;
            if coalesce(v_sh ->> 'address', '') <> '' then
                raise exception 'DESTINATION_REQUIRED: warehouse shipment must not have an address'
                    using errcode = 'P0400';
            end if;
            -- Stage 2G: structured courier address parts are courier-only.
            if coalesce(v_sh ->> 'street_name', '') <> ''
               or coalesce(v_sh ->> 'building', '') <> ''
               or coalesce(v_sh ->> 'flat', '') <> '' then
                raise exception
                    'DESTINATION_REQUIRED: warehouse shipment must not have a courier address'
                    using errcode = 'P0400';
            end if;
        else
            if coalesce(v_sh ->> 'address', '') = '' then
                raise exception 'DESTINATION_REQUIRED: courier shipment needs an address'
                    using errcode = 'P0400';
            end if;
            if coalesce(v_sh ->> 'warehouse_ref', '') <> '' then
                raise exception 'DESTINATION_REQUIRED: courier shipment must not have a destination id'
                    using errcode = 'P0400';
            end if;
        end if;

        -- cod_amount: non-negative money, numeric(12,2) range.
        v_num := null;
        if coalesce(v_sh ->> 'cod_amount', '') ~ '^([0-9]{1,10})(\.[0-9]{1,2})?$' then
            v_num := (v_sh ->> 'cod_amount')::numeric;
        end if;
        if v_num is null or v_num > 9999999999.99 then
            raise exception 'COD_AMOUNT_INVALID: %', v_sh ->> 'cod_amount'
                using errcode = 'P0400';
        end if;

        -- Items: at least one, valid uuids, positive integer quantities.
        v_items := v_sh -> 'items';
        if jsonb_typeof(v_items) is distinct from 'array'
           or jsonb_array_length(v_items) = 0
           or jsonb_array_length(v_items) > 500 then
            raise exception 'ITEM_INVALID: shipments[%].items must be a non-empty array (max 500)', v_i
                using errcode = 'P0400';
        end if;
        for v_j in 0 .. jsonb_array_length(v_items) - 1 loop
            v_it := v_items -> v_j;
            begin
                v_iid := (v_it ->> 'order_item_id')::uuid;
            exception
                when invalid_text_representation then
                    raise exception 'ITEM_INVALID: bad order_item_id %', v_it ->> 'order_item_id'
                        using errcode = 'P0400';
            end;
            if coalesce(v_it ->> 'quantity', '') !~ '^[0-9]{1,9}$'
               or (v_it ->> 'quantity')::integer < 1 then
                raise exception 'ITEM_INVALID: quantity %', v_it ->> 'quantity'
                    using errcode = 'P0400';
            end if;
            v_all_items := v_all_items || v_iid;
            v_items_total := v_items_total + 1;
        end loop;

        -- Parcels: optional, but each must satisfy the live-API contract.
        v_parcels := v_sh -> 'parcels';
        if v_parcels is not null then
            if jsonb_typeof(v_parcels) is distinct from 'array'
               or jsonb_array_length(v_parcels) > 50 then
                raise exception 'PARCEL_INVALID: shipments[%].parcels must be an array (max 50)', v_i
                    using errcode = 'P0400';
            end if;
            for v_j in 0 .. jsonb_array_length(v_parcels) - 1 loop
                v_pa := v_parcels -> v_j;
                if jsonb_typeof(v_pa) is distinct from 'object' then
                    raise exception 'PARCEL_INVALID: parcels[%] must be an object', v_i
                        using errcode = 'P0400';
                end if;
                v_int := (v_pa ->> 'parcel_index')::integer;
                if v_int is distinct from v_j + 1 then
                    raise exception
                        'PARCEL_INDEX_INVALID: expected %, got %', v_j + 1, v_pa ->> 'parcel_index'
                        using errcode = 'P0400';
                end if;
                if coalesce(v_pa ->> 'cargo_category', '') not in
                   ('parcel', 'documents', 'pallet') then
                    raise exception 'CARGO_CATEGORY_INVALID: %', v_pa ->> 'cargo_category'
                        using errcode = 'P0400';
                end if;
                -- Live API: grams, multiple of 10, positive.
                v_int := null;
                if coalesce(v_pa ->> 'actual_weight_grams', '') ~ '^[0-9]{1,9}$' then
                    v_int := (v_pa ->> 'actual_weight_grams')::integer;
                end if;
                if v_int is null or v_int < 1 or v_int % 10 <> 0 then
                    raise exception 'WEIGHT_INVALID: % (must be positive, multiple of 10 g)',
                        v_pa ->> 'actual_weight_grams'
                        using errcode = 'P0400';
                end if;
                -- Live API: millimeter integers, positive.
                if coalesce(v_pa ->> 'width_mm', '')  !~ '^[0-9]{1,7}$'
                   or coalesce(v_pa ->> 'length_mm', '') !~ '^[0-9]{1,7}$'
                   or coalesce(v_pa ->> 'height_mm', '') !~ '^[0-9]{1,7}$' then
                    raise exception
                        'DIMENSION_INVALID: dimensions must be positive integer mm (got %, %, %)',
                        v_pa ->> 'width_mm', v_pa ->> 'length_mm', v_pa ->> 'height_mm'
                        using errcode = 'P0400';
                end if;
                v_num := null;
                if coalesce(v_pa ->> 'insurance_cost', '') ~ '^([0-9]{1,10})(\.[0-9]{1,2})?$' then
                    v_num := (v_pa ->> 'insurance_cost')::numeric;
                end if;
                if v_num is null or v_num <= 0 or v_num > 9999999999.99 then
                    raise exception 'INSURANCE_INVALID: %', v_pa ->> 'insurance_cost'
                        using errcode = 'P0400';
                end if;
            end loop;
        end if;
    end loop;

    -- Every allocated order_item must belong to this order (belt for the
    -- composite FKs of migration 020).
    select count(*) into v_distinct_ids
      from unnest(array(select distinct unnest(v_all_items))) as u(id);
    select count(*) into v_found
      from order_items
     where order_id = p_order_id
       and id = any (array(select distinct unnest(v_all_items)));
    if v_found <> v_distinct_ids then
        raise exception 'ITEM_NOT_IN_ORDER: some items do not belong to order %', p_order_id
            using errcode = 'P0400';
    end if;

    -- ==================== REPLACE-ALL PASS ====================
    delete from order_shipments where order_id = p_order_id;

    for v_i in 0 .. v_n - 1 loop
        v_sh := v_shipments -> v_i;

        insert into order_shipments (
            order_id, shipment_index, service_type, carrier,
            city_ref, city_name, warehouse_ref, warehouse_name, address,
            street_name, building, flat,
            status, cod_amount
        ) values (
            p_order_id,
            v_i + 1,
            v_sh ->> 'service_type',
            coalesce(v_sh ->> 'carrier', 'nova_poshta'),
            v_sh ->> 'city_ref',
            left(v_sh ->> 'city_name', 200),
            nullif(v_sh ->> 'warehouse_ref', ''),
            left(nullif(v_sh ->> 'warehouse_name', ''), 200),
            left(nullif(v_sh ->> 'address', ''), 300),
            left(nullif(v_sh ->> 'street_name', ''), 100),
            left(nullif(v_sh ->> 'building', ''), 100),
            left(nullif(v_sh ->> 'flat', ''), 10),
            'planned',
            (v_sh ->> 'cod_amount')::numeric(12, 2)
        )
        returning id into v_sid;

        v_items := v_sh -> 'items';
        for v_j in 0 .. jsonb_array_length(v_items) - 1 loop
            v_it := v_items -> v_j;
            insert into order_shipment_items (shipment_id, order_item_id, quantity, order_id)
            values (v_sid, (v_it ->> 'order_item_id')::uuid,
                    (v_it ->> 'quantity')::integer, p_order_id);
        end loop;

        v_parcels := v_sh -> 'parcels';
        if v_parcels is not null then
            for v_j in 0 .. jsonb_array_length(v_parcels) - 1 loop
                v_pa := v_parcels -> v_j;
                insert into order_shipment_parcels (
                    shipment_id, parcel_index, cargo_category,
                    actual_weight_grams, width_mm, length_mm, height_mm,
                    insurance_cost, description
                ) values (
                    v_sid,
                    v_j + 1,
                    v_pa ->> 'cargo_category',
                    (v_pa ->> 'actual_weight_grams')::integer,
                    (v_pa ->> 'width_mm')::integer,
                    (v_pa ->> 'length_mm')::integer,
                    (v_pa ->> 'height_mm')::integer,
                    (v_pa ->> 'insurance_cost')::numeric(12, 2),
                    left(nullif(v_pa ->> 'description', ''), 500)
                );
                v_parcels_total := v_parcels_total + 1;
            end loop;
        end if;
    end loop;

    return jsonb_build_object(
        'order_id', p_order_id,
        'shipments', v_n,
        'items', v_items_total,
        'parcels', v_parcels_total
    );
end;
$$;

-- Trigger functions are security definer: executable by service_role only
-- (018/019/026 pattern; Postgres would otherwise grant EXECUTE to PUBLIC).
revoke all on function public.admin_replace_shipment_plan(uuid, jsonb) from public;
revoke execute on function public.admin_replace_shipment_plan(uuid, jsonb) from anon, authenticated;
grant execute on function public.admin_replace_shipment_plan(uuid, jsonb) to service_role;

commit;
