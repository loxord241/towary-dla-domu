-- Migration 032: security remediation (code audit 2026-09-02).
--
-- Findings fixed here (each minimal, no business-logic changes):
--   HIGH  admin_users had NO row level security: Supabase platform defaults
--         (plus the final_001 ALTER DEFAULT PRIVILEGES ... GRANT SELECT TO
--         public) left the admin email list readable by anon.
--   HIGH  026 re-created admin_replace_shipment_plan "verbatim from 021"
--         and silently reverted the 023 parcel cap 10 -> 50 (regression:
--         delivery-cost.ts only verifies up to 10 parcels). Restored to 10
--         while KEEPING the 026 courier-address logic; also restores the
--         per-parcel error index v_j (026 printed the shipment index v_i).
--   MEDIUM place_order idempotency replay returned any order's
--         order_number/total to whoever presented the key — the key was not
--         bound to the caller. The replay now requires the payload email to
--         match the stored order email (a genuine retry re-sends the same
--         payload, so legitimate retries are unaffected).
--   MEDIUM is_current_user_admin(): SECURITY DEFINER without a fixed
--         search_path and with public EXECUTE (anon "is this JWT admin"
--         oracle). The app does not call it (proxy.ts/layout do their own
--         admin_users lookup), so EXECUTE is revoked from everyone except
--         service_role; search_path is pinned.
--   MEDIUM ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO public
--         (final_001) made every future table world-readable until RLS was
--         enabled in the same migration. Revoked; grants are explicit from
--         now on.
--   MEDIUM product_attribute_values: the only initial-schema table with no
--         RLS. Enabled (default deny); the app never reads it directly —
--         all access is service-role.
--   MEDIUM product_review_summary(): EXECUTE was granted to anon and
--         service_role but not authenticated (inconsistent with the rest
--         of the public surface).
--   LOW    trigger helper functions (update_updated_at_column,
--         validate_product_brand, handle_brand_deactivation,
--         check_stock_update) re-created with SET search_path = public
--         (defense-in-depth; matches the definer-function standard).
--   LOW    duplicate FKs on attributes_translations / attribute_values_translations
--         (final_002 re-added what its own comment declares useless and
--         embedding-breaking) dropped; the REFERENCES-made *_fkey remain.
--   LOW    orders money columns got a non-negative CHECK (NOT VALID first,
--         then validated, so a pre-existing dirty row fails loudly instead
--         of silently blocking the migration table lock).

-- ---------------------------------------------------------------------------
-- 1) admin_users: RLS on, anon/authenticated locked out (service_role only)
-- ---------------------------------------------------------------------------
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) product_attribute_values: RLS on (default deny)
-- ---------------------------------------------------------------------------
alter table public.product_attribute_values enable row level security;
revoke all on public.product_attribute_values from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) stop making every future table world-readable by default
-- ---------------------------------------------------------------------------
alter default privileges for role postgres revoke select on tables from public;

-- ---------------------------------------------------------------------------
-- 4) is_current_user_admin(): pin search_path, close the anon oracle
-- ---------------------------------------------------------------------------
create or replace function public.is_current_user_admin()
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    return exists (
        select 1 from public.admin_users
        where email = (
            select email from auth.identities
            where id = current_setting('request.jwt.claims', true)::json->>'sub'
        )
    );
end;
$$;
revoke all on function public.is_current_user_admin() from public;
revoke execute on function public.is_current_user_admin() from anon, authenticated;
grant execute on function public.is_current_user_admin() to service_role;

-- ---------------------------------------------------------------------------
-- 5) trigger helpers: SET search_path = public (defense-in-depth)
-- ---------------------------------------------------------------------------
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    NEW.updated_at = NOW();
    RETURN NEW;
end;
$$;

create or replace function public.validate_product_brand()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    IF NEW.brand_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM brands
        WHERE id = NEW.brand_id AND is_active = TRUE
    ) THEN
        RAISE EXCEPTION 'Brand must exist and be active';
    END IF;
    RETURN NEW;
end;
$$;

create or replace function public.handle_brand_deactivation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    IF OLD.is_active = TRUE AND NEW.is_active = FALSE THEN
        IF EXISTS (
            SELECT 1 FROM products
            WHERE brand_id = NEW.id AND is_active = TRUE
        ) THEN
            RAISE EXCEPTION 'Cannot deactivate brand while active products reference it';
        END IF;
    END IF;
    RETURN NEW;
end;
$$;

create or replace function public.check_stock_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    IF NEW.stock_quantity < 0 THEN
        RAISE EXCEPTION 'Stock quantity cannot be negative';
    END IF;
    RETURN NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) admin_replace_shipment_plan: restore the 023 cap (10), keep 026 logic
-- (026 re-created it verbatim from 021 and reverted the 023 cap; the body
-- below is 026's current definition with ONLY the cap and the error index
-- changed — verified by diff against 021/023/026.)
-- ---------------------------------------------------------------------------

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
            street_name, building, flat,
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
-- (018/019 pattern; Postgres would otherwise grant EXECUTE to PUBLIC).
revoke all on function public.admin_replace_shipment_plan(uuid, jsonb) from public;
revoke execute on function public.admin_replace_shipment_plan(uuid, jsonb) from anon, authenticated;
grant execute on function public.admin_replace_shipment_plan(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7) place_order: bind idempotency replay to the caller's email
-- (body is 030's definition — the latest version, verified consistent by a
-- full migration sweep — with ONLY the replay binding added.)
-- ---------------------------------------------------------------------------

create or replace function public.place_order(payload jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_max_items    constant int := 20;
  c_max_qty      constant int := 99;
  c_uuid_re      constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_int_re       constant text := '^[0-9]{1,3}$';
  c_email_re     constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$';

  v_items        jsonb;
  v_item         jsonb;
  v_email        text;
  v_name         text;
  v_first_name   text;
  v_last_name    text;
  v_patronymic   text;
  v_phone        text;
  v_shipping     jsonb;

  v_pid          text;
  v_vid          text;
  v_qty          int;
  v_qty_text     text;
  v_key          text;
  v_seen_keys    text[] := '{}';

  v_product      products%rowtype;
  v_variant      product_variants%rowtype;
  v_has_variant  boolean;

  v_currency     text := null;
  v_unit_price   numeric(12,2);
  v_sku          text;
  v_old_stock    int;
  v_subtotal     numeric(12,2) := 0;
  v_lines        jsonb := '[]'::jsonb;
  v_rec          record;
  v_line         record;

  v_customer_id  uuid;
  v_order_id     uuid;
  v_order_number text;
  v_attempts     int := 0;

  -- F2 idempotency
  v_ik            text;
  v_constraint    text;
  v_replay_id     uuid;
  v_replay_number text;
  v_replay_total  numeric;
  v_replay_currency text;
  v_replay_email   text;
begin
  -- ---------------- idempotency key + replay fast-path ----------------
  -- Runs BEFORE the rest of payload validation: a retry of an
  -- already-committed order must return its original result. Since 032 the
  -- replay is bound to the caller: the payload email must equal the email
  -- stored on the replayed order, so a leaked/observed key alone can no
  -- longer read someone else's order. A genuine retry re-sends the same
  -- payload (same email), so legitimate retries are unaffected.
  v_ik := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_ik is not null and (length(v_ik) < 8 or length(v_ik) > 128) then
    raise exception 'IDEMPOTENCY_KEY_INVALID' using errcode = 'P0400';
  end if;

  if v_ik is not null then
    v_email := lower(btrim(coalesce(payload->>'email', '')));
    if v_email = '' or v_email !~ c_email_re or length(v_email) > 254 then
      raise exception 'EMAIL_INVALID' using errcode = 'P0400';
    end if;
    select id, order_number, total_amount, currency, email
      into v_replay_id, v_replay_number, v_replay_total, v_replay_currency, v_replay_email
      from orders
      where idempotency_key = v_ik;
    if found then
      if v_replay_email is distinct from v_email then
        raise exception 'IDEMPOTENCY_KEY_CONFLICT' using errcode = 'P0409';
      end if;
      return jsonb_build_object(
        'order_id',     v_replay_id,
        'order_number', v_replay_number,
        'total',        v_replay_total,
        'currency',     v_replay_currency,
        'created',      false
      );
    end if;
  end if;

  -- ---------------- payload shape ----------------
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'INVALID_PAYLOAD' using errcode = 'P0400';
  end if;

  v_items := payload->'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) = 0
     or jsonb_array_length(v_items) > c_max_items then
    raise exception 'INVALID_ITEMS' using errcode = 'P0400';
  end if;

  v_email := lower(btrim(coalesce(payload->>'email', '')));
  v_name  := btrim(coalesce(payload->>'name', ''));
  v_phone := btrim(coalesce(payload->>'phone', ''));

  -- Optional structured ПІБ (migration 027). Each part is capped like the
  -- legacy single `name`; empty strings mean "not provided".
  v_first_name := btrim(coalesce(payload->>'first_name', ''));
  v_last_name  := btrim(coalesce(payload->>'last_name', ''));
  v_patronymic := btrim(coalesce(payload->>'patronymic', ''));

  if length(v_first_name) > 120 or length(v_last_name) > 120
     or length(v_patronymic) > 120 then
    raise exception 'NAME_INVALID' using errcode = 'P0400';
  end if;

  -- Composed ПІБ (last first patronymic) wins when any structured part is
  -- provided; otherwise the legacy `name` payload is used as-is.
  if v_first_name <> '' or v_last_name <> '' then
    v_name := btrim(concat_ws(' ', v_last_name, v_first_name, v_patronymic));
  end if;

  if v_email !~ c_email_re or length(v_email) > 254 then
    raise exception 'EMAIL_INVALID' using errcode = 'P0400';
  end if;
  if v_name = '' or length(v_name) > 120 then
    raise exception 'NAME_INVALID' using errcode = 'P0400';
  end if;
  if length(v_phone) > 40 then
    raise exception 'PHONE_INVALID' using errcode = 'P0400';
  end if;

  v_shipping := payload->'shipping_info';
  if v_shipping is not null and jsonb_typeof(v_shipping) <> 'object' then
    raise exception 'SHIPPING_INVALID' using errcode = 'P0400';
  end if;
  if v_shipping is not null and octet_length(v_shipping::text) > 4000 then
    raise exception 'SHIPPING_TOO_LARGE' using errcode = 'P0400';
  end if;

  -- ---------------- structural validation + dedupe ----------------
  for v_item in select * from jsonb_array_elements(v_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'INVALID_ITEM' using errcode = 'P0400';
    end if;

    v_pid := coalesce(v_item->>'product_id', '');
    v_vid := coalesce(v_item->>'variant_id', '');

    if v_pid !~* c_uuid_re then
      raise exception 'INVALID_PRODUCT_ID' using errcode = 'P0400';
    end if;
    if v_vid <> '' and v_vid !~* c_uuid_re then
      raise exception 'INVALID_VARIANT_ID' using errcode = 'P0400';
    end if;
    if v_vid in ('null') then
      v_vid := '';
    end if;

    v_qty_text := coalesce(v_item->>'quantity', '');
    if v_qty_text !~ c_int_re then
      -- rejects 0, negatives, decimals ("1.5"), non-numeric, huge values
      raise exception 'INVALID_QUANTITY' using errcode = 'P0400';
    end if;
    v_qty := v_qty_text::int;
    if v_qty < 1 or v_qty > c_max_qty then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0400';
    end if;

    v_key := lower(v_pid) || ':' || lower(v_vid);
    if v_key = any(v_seen_keys) then
      raise exception 'DUPLICATE_ITEM' using errcode = 'P0409';
    end if;
    v_seen_keys := v_seen_keys || v_key;
  end loop;

  -- ---------------- business validation, locking, pricing ----------------
  -- Sorted iteration => deterministic lock ordering => no self-deadlocks.
  for v_rec in
    select e->>'product_id' as pid,
           case when coalesce(e->>'variant_id','') = '' then null else e->>'variant_id' end as vid,
           (e->>'quantity')::int as qty
    from jsonb_array_elements(v_items) e
    order by e->>'product_id', coalesce(e->>'variant_id', '')
  loop
    select * into v_product
      from products
      where id = v_rec.pid::uuid
      for update;
    if not found then
      raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0422';
    end if;
    if v_product.is_active is distinct from true then
      raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0422';
    end if;
    if v_product.availability_status = 'out_of_stock' then
      raise exception 'PRODUCT_OUT_OF_STOCK' using errcode = 'P0422';
    end if;

    v_has_variant := v_rec.vid is not null;

    if v_has_variant then
      -- also locks parent row: protects product-level reads while admins edit
      select * into v_variant
        from product_variants
        where id = v_rec.vid::uuid
          and product_id = v_product.id   -- чужой variant не пройдёт
        for update;
      if not found then
        raise exception 'VARIANT_NOT_FOUND' using errcode = 'P0422';
      end if;
      if v_variant.is_active is distinct from true then
        raise exception 'VARIANT_UNAVAILABLE' using errcode = 'P0422';
      end if;
      if v_variant.availability_status = 'out_of_stock' then
        raise exception 'VARIANT_OUT_OF_STOCK' using errcode = 'P0422';
      end if;
      if v_variant.stock_quantity < v_rec.qty then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0422';
      end if;
      v_unit_price := v_variant.price;
      v_sku        := coalesce(v_variant.sku, v_product.sku);
      v_old_stock  := v_variant.stock_quantity;
    else
      if v_product.stock_quantity < v_rec.qty then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0422';
      end if;
      v_unit_price := v_product.price;
      v_sku        := v_product.sku;
      v_old_stock  := v_product.stock_quantity;
    end if;

    -- single-currency cart
    if v_currency is null then
      v_currency := v_product.currency;
    elsif v_product.currency is distinct from v_currency then
      raise exception 'CURRENCY_MISMATCH' using errcode = 'P0400';
    end if;

    v_subtotal := v_subtotal + (v_unit_price * v_rec.qty);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'pid',       v_product.id,
      'vid',       case when v_has_variant then v_variant.id else null end,
      'qty',       v_rec.qty,
      'price',     v_unit_price,
      'pname',     v_product.name,
      'sku',       v_sku,
      'vname',     case when v_has_variant then v_variant.name else null end,
      'vsku',      case when v_has_variant then v_variant.sku else null end,
      'old_stock', v_old_stock
    ));
  end loop;

  -- ---------------- customer upsert ----------------
  insert into customers (email, first_name, phone)
  values (v_email, v_name, nullif(v_phone, ''))
  on conflict (email) do update
    set first_name = excluded.first_name,
        phone      = coalesce(excluded.phone, customers.phone)
  returning id into v_customer_id;

  -- ---------------- order creation (collision-safe number) ----------------
  loop
    v_attempts := v_attempts + 1;
    v_order_number :=
      'ORD-' || to_char(now(), 'YYYYMMDD') || '-'
      || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    begin
      insert into orders (
        order_number, customer_id, status, subtotal, shipping_total,
        total_amount, currency, email, customer_info, shipping_info,
        payment_status, auth_user_id, expires_at, idempotency_key
      ) values (
        v_order_number, v_customer_id, 'pending', v_subtotal, 0,
        v_subtotal, v_currency, v_email,
        -- Base object (legacy shape) + structured ПІБ keys, merged in only
        -- when provided: jsonb_strip_nulls drops absent parts entirely.
        jsonb_build_object('name', v_name, 'phone', nullif(v_phone, ''))
          || jsonb_strip_nulls(jsonb_build_object(
               'first_name', nullif(v_first_name, ''),
               'last_name',  nullif(v_last_name, ''),
               'patronymic', nullif(v_patronymic, '')
             )),
        coalesce(v_shipping, '{}'::jsonb),
        'unpaid', null, now() + interval '24 hours', v_ik
      )
      returning id into v_order_id;
      exit;
    exception
      when unique_violation then
        -- Distinguish the idempotency index from the order_number retry:
        -- a concurrent twin with the same key won the insert race. The
        -- unique index wait means the twin has COMMITTED by now, so this
        -- statement's snapshot (READ COMMITTED) can see it.
        begin
          get stacked diagnostics v_constraint = constraint_name;
        end;
        if v_constraint = 'idx_orders_idempotency_key' then
          select id, order_number, total_amount, currency
            into v_replay_id, v_replay_number, v_replay_total, v_replay_currency
            from orders
            where idempotency_key = v_ik and email = v_email;
          if found then
            return jsonb_build_object(
              'order_id',     v_replay_id,
              'order_number', v_replay_number,
              'total',        v_replay_total,
              'currency',     v_replay_currency,
              'created',      false
            );
          end if;
          raise exception 'IDEMPOTENCY_RACE' using errcode = 'P0409';
        end if;
        if v_attempts >= 5 then
          raise exception 'ORDER_NUMBER_COLLISION' using errcode = 'P0409';
        end if;
    end;
  end loop;

  -- ---------------- items + stock decrement + audit ----------------
  for v_line in
    select * from jsonb_to_recordset(v_lines)
      as x(pid uuid, vid uuid, qty int, price numeric, pname text,
           sku text, vname text, vsku text, old_stock int)
  loop
    -- XOR CHECK (chk_order_items_product_or_variant): variant items carry
    -- variant_id only, plain items carry product_id only.
    insert into order_items (
      order_id, product_id, variant_id, product_name, sku,
      variant_name, variant_sku, quantity, price, total
    ) values (
      v_order_id,
      case when v_line.vid is null then v_line.pid else null end,
      v_line.vid,
      v_line.pname, v_line.sku, v_line.vname, v_line.vsku,
      v_line.qty, v_line.price, v_line.price * v_line.qty
    );

    if v_line.vid is null then
      update products
        set stock_quantity = stock_quantity - v_line.qty
        where id = v_line.pid and stock_quantity >= v_line.qty;
      if not found then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0422';
      end if;
      insert into product_stock_history (product_id, old_quantity, new_quantity, reason, source)
      values (v_line.pid, v_line.old_stock, v_line.old_stock - v_line.qty, 'order', 'web');
    else
      update product_variants
        set stock_quantity = stock_quantity - v_line.qty
        where id = v_line.vid and stock_quantity >= v_line.qty;
      if not found then
        raise exception 'INSUFFICIENT_STOCK' using errcode = 'P0422';
      end if;
      insert into product_stock_history (product_id, variant_id, old_quantity, new_quantity, reason, source)
      values (v_line.pid, v_line.vid, v_line.old_stock, v_line.old_stock - v_line.qty, 'order', 'web');
    end if;
  end loop;

  return jsonb_build_object(
    'order_id',     v_order_id,
    'order_number', v_order_number,
    'total',        v_subtotal,
    'currency',     v_currency,
    'created',      true
  );
end;
$$;

-- Replace the legacy one-arg signature: leaving it in place would create
-- an overload, and PostgREST could resolve payload-only calls to the old
-- function, silently bypassing idempotency. Dropping it keeps exactly one
-- place_order; payload-only calls use the p_idempotency_key default (NULL
-- → legacy behaviour, byte-identical to migration 027).
drop function if exists public.place_order(jsonb);

revoke all on function public.place_order(jsonb, text) from public;
grant execute on function public.place_order(jsonb, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) product_review_summary: symmetric EXECUTE for authenticated
-- ---------------------------------------------------------------------------
grant execute on function public.product_review_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) duplicate translation FKs (PostgREST embedding ambiguity)
-- ---------------------------------------------------------------------------
alter table public.attributes_translations
  drop constraint if exists chk_attributes_translations_attribute_id;
alter table public.attribute_values_translations
  drop constraint if exists chk_attribute_values_translations_attribute_value_id;

-- ---------------------------------------------------------------------------
-- 10) orders money columns: non-negative CHECK
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'chk_orders_amounts_non_negative'
    ) then
        alter table public.orders add constraint chk_orders_amounts_non_negative
            check (
                total_amount >= 0
                and subtotal >= 0
                and shipping_total >= 0
                and (prepayment_amount is null or prepayment_amount >= 0)
            ) not valid;
    end if;
end $$;
alter table public.orders validate constraint chk_orders_amounts_non_negative;

-- ---------------------------------------------------------------------------
-- 11) order lookup: shared DB-backed brute-force ceiling
-- ---------------------------------------------------------------------------
-- The per-IP in-memory limiter (app/lib/rate-limit.ts) is per-instance on
-- serverless. /api/orders/lookup is the one route where that limiter is the
-- only defense once an attacker knows a victim email, so FAILED lookups get
-- a global hourly ceiling. One row, reset each hour; service-role only.
create table if not exists public.failed_lookup_counters (
    name              text primary key,
    window_started_at timestamptz not null default now(),
    count             integer not null default 0
);
alter table public.failed_lookup_counters enable row level security;
revoke all on public.failed_lookup_counters from anon, authenticated;

create or replace function public.record_failed_lookup()
returns void
language sql
security definer
set search_path = public
as $$
    insert into public.failed_lookup_counters as f (name, window_started_at, count)
    values ('orders_lookup', now(), 1)
    on conflict (name) do update
      set count = case when f.window_started_at < now() - interval '1 hour'
                       then 1 else f.count + 1 end,
          window_started_at = case when f.window_started_at < now() - interval '1 hour'
                                   then now() else f.window_started_at end;
$$;
revoke all on function public.record_failed_lookup() from public;
revoke execute on function public.record_failed_lookup() from anon, authenticated;
grant execute on function public.record_failed_lookup() to service_role;
