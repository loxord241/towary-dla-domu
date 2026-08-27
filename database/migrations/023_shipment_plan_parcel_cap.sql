-- Migration 023: shipment plan parcels cap 50 -> 10 (stage 2E)
--
-- The live Nova Post calculation parser (app/lib/delivery/novapost/
-- delivery-cost.ts) caps parcels[] at 10; the OpenAPI schema defines no
-- maxItems, so 10 is our verified live envelope. The replace-all RPC must
-- enforce the same cap so a saved plan can always be calculated in one
-- request (no chunking in MVP — stage 2E decision).
--
-- Only the cap constant changes; the whole function is re-created verbatim
-- from migration 021 with:
--     jsonb_array_length(v_parcels) > 50   ->  > 10
--     'max 50'                             ->  'max 10'
--
-- Scope guard (stage 2E, explicit GO 2026-08-27): no courier fields, no
-- TTN/tracking, no checkout/payment changes, no RLS changes.
--
-- Idempotency: CREATE OR REPLACE + guarded grants. Rerunnable.

begin;

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

        if coalesce(v_sh ->> 'service_type', '') not in
           ('nova_poshta_warehouse', 'nova_poshta_courier') then
            raise exception 'SERVICE_TYPE_INVALID: %', v_sh ->> 'service_type'
                using errcode = 'P0400';
        end if;

        -- Nova Post settlement id: numeric text.
        if coalesce(v_sh ->> 'city_ref', '') !~ '^[0-9]{1,20}$' then
            raise exception 'CITY_INVALID: city_ref must be a Nova Post settlement id'
                using errcode = 'P0400';
        end if;

        -- Destination XOR (mirrors chk_order_shipments_destination).
        if v_sh ->> 'service_type' = 'nova_poshta_warehouse' then
            if coalesce(v_sh ->> 'warehouse_ref', '') !~ '^[0-9]{1,20}$' then
                raise exception 'DESTINATION_REQUIRED: warehouse shipment needs a division id'
                    using errcode = 'P0400';
            end if;
            if coalesce(v_sh ->> 'address', '') <> '' then
                raise exception 'DESTINATION_REQUIRED: warehouse shipment must not have an address'
                    using errcode = 'P0400';
            end if;
        else
            if coalesce(v_sh ->> 'address', '') = '' then
                raise exception 'DESTINATION_REQUIRED: courier shipment needs an address'
                    using errcode = 'P0400';
            end if;
            if coalesce(v_sh ->> 'warehouse_ref', '') <> '' then
                raise exception 'DESTINATION_REQUIRED: courier shipment must not have a division id'
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
               or jsonb_array_length(v_parcels) > 10 then
                raise exception 'PARCEL_INVALID: shipments[%].parcels must be an array (max 10)', v_i
                    using errcode = 'P0400';
            end if;
            for v_j in 0 .. jsonb_array_length(v_parcels) - 1 loop
                v_pa := v_parcels -> v_j;
                if jsonb_typeof(v_pa) is distinct from 'object' then
                    raise exception 'PARCEL_INVALID: parcels[%] must be an object', v_j
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
            order_id, shipment_index, service_type,
            city_ref, city_name, warehouse_ref, warehouse_name, address,
            status, cod_amount
        ) values (
            p_order_id,
            v_i + 1,
            v_sh ->> 'service_type',
            v_sh ->> 'city_ref',
            left(v_sh ->> 'city_name', 200),
            nullif(v_sh ->> 'warehouse_ref', ''),
            left(nullif(v_sh ->> 'warehouse_name', ''), 200),
            left(nullif(v_sh ->> 'address', ''), 300),
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
-- (018/019 pattern; Postgres would otherwise grant EXECUTE to PUBLIC).
revoke all on function public.admin_replace_shipment_plan(uuid, jsonb) from public;
revoke execute on function public.admin_replace_shipment_plan(uuid, jsonb) from anon, authenticated;
grant execute on function public.admin_replace_shipment_plan(uuid, jsonb) to service_role;

commit;
