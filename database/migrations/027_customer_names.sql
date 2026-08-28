-- Migration 027: customer ПІБ (first/last/patronymic) in checkout
-- Extends place_order() so the checkout can carry structured customer
-- names. Backward compatible by design:
--   * the function signature is unchanged: place_order(payload jsonb);
--   * first_name / last_name / patronymic are OPTIONAL payload keys;
--   * legacy payloads with only `name` keep working (composed ПІБ wins
--     when provided, otherwise `name` is used verbatim);
--   * orders.customer_info is jsonb — new keys are merged in only when
--     non-empty, existing rows and readers stay untouched;
--   * money model untouched (pricing/validation logic is byte-identical
--     to migration 006 apart from the name handling below).

create or replace function public.place_order(payload jsonb)
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
begin
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
        payment_status, auth_user_id, expires_at
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
        'unpaid', null, now() + interval '24 hours'
      )
      returning id into v_order_id;
      exit;
    exception when unique_violation then
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
    'currency',     v_currency
  );
end;
$$;

revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to anon, authenticated, service_role;
