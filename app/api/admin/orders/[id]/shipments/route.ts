import { NextResponse } from 'next/server';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import { parseShipmentPlanPayload } from '@/app/lib/admin-shipments';
import {
  readNpTrackingApiKey,
  refreshNpStatuses,
} from '@/app/lib/np-tracking';

/**
 * Stage 2D — admin shipment planning API (manager-driven, no Nova Post
 * calls, no TTN; checkout/payment/LiqPay untouched).
 *
 * GET  /api/admin/orders/[id]/shipments
 *   → order + items with unallocated remainder + shipments (with items and
 *     parcels) + whether the plan is still editable (everything 'planned').
 *
 * Embeds are FK-disambiguated (!order_shipment_items_shipment_id_fkey):
 * the fk-fix migration added a second (composite) FK
 * (shipment_id, order_id) → order_shipments(id, order_id), which made the
 * bare embed ambiguous (PostgREST PGRST201/300 → 500).
 *
 * PUT  /api/admin/orders/[id]/shipments  body = full replace-all plan
 *   → validated by admin-shipments.ts, then applied atomically by the
 *     admin_replace_shipment_plan RPC (one transaction; the DEFERRABLE COD
 *     and allocation triggers evaluate the final state at commit).
 *     Editing is refused once any shipment is past 'planned' or has a TTN.
 */

const ORDER_FIELDS =
  'id, order_number, status, payment_status, total_amount, currency, shipping_info, prepayment_amount';

const ITEM_FIELDS =
  'id, product_name, variant_name, sku, quantity, price, total';

const SHIPMENT_SELECT = `
  id, shipment_index, service_type, carrier, city_ref, city_name, warehouse_ref,
  warehouse_name, address, street_name, building, flat, status, cod_amount,
  delivery_cost_estimated, ttn_number, ttn_ref, delivery_cost,
  np_status, np_status_checked_at,
  order_shipment_items!order_shipment_items_shipment_id_fkey(order_item_id, quantity),
  order_shipment_parcels(parcel_index, cargo_category, actual_weight_grams,
    width_mm, length_mm, height_mm, insurance_cost, description)
`.replace(/\s+/g, ' ');

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id замовлення' }, { status: 400 });
  }

  try {
    const [orderRes, itemsRes, shipmentsRes] = await Promise.all([
      ctx.serviceClient
        .from('orders')
        .select(ORDER_FIELDS + ', customer_info')
        .eq('id', id)
        .maybeSingle(),
      ctx.serviceClient.from('order_items').select(ITEM_FIELDS).eq('order_id', id),
      ctx.serviceClient
        .from('order_shipments')
        .select(SHIPMENT_SELECT)
        .eq('order_id', id)
        .order('shipment_index'),
    ]);

    if (orderRes.error || itemsRes.error || shipmentsRes.error) {
      console.error(
        'admin shipment plan fetch failed:',
        orderRes.error?.message || itemsRes.error?.message || shipmentsRes.error?.message
      );
      return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
    }
    if (!orderRes.data) {
      return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
    }

    // Live NP statuses (owner task 2026-09-13): refresh stale display cache
    // before answering, capped at 4s so a slow provider never wedges the
    // planner; the caller gets whatever is in the cache either way.
    const shipmentsForNp = (shipmentsRes.data ?? []) as unknown as {
      id: string;
      ttn_number: string | null;
      np_status: string | null;
      np_status_checked_at: string | null;
    }[];
    // Generated DB types placeholder the row shape — cast explicitly.
    const order = orderRes.data as unknown as {
      status: string;
      customer_info: { phone?: unknown } | null;
    };
    const customerPhone = order.customer_info?.phone ?? null;
    await Promise.race([
      refreshNpStatuses(
        shipmentsForNp.map((s) => ({
          ...s,
          ttn_number: s.ttn_number ?? null,
          phone: typeof customerPhone === 'string' ? customerPhone : null,
        })),
        readNpTrackingApiKey(),
        async (shipmentId, status, checkedAtIso) => {
          await ctx.serviceClient
            .from('order_shipments')
            .update({ np_status: status, np_status_checked_at: checkedAtIso })
            .eq('id', shipmentId);
        }
      ),
      new Promise((resolve) => setTimeout(resolve, 4_000)),
    ]);

    // Re-read AFTER the refresh so the planner renders the freshest cache.
    const freshShipmentsRes = await ctx.serviceClient
      .from('order_shipments')
      .select(SHIPMENT_SELECT)
      .eq('order_id', id)
      .order('shipment_index');
    if (freshShipmentsRes.error) {
      // Fall back to the pre-refresh rows — the planner still renders.
      console.error(
        'admin shipment plan re-fetch after NP refresh failed:',
        freshShipmentsRes.error.message
      );
    }

    type ShipmentRow = {
      status: string;
      ttn_number?: string | null;
      order_shipment_items?: { order_item_id: string; quantity: number }[];
    };
    const shipments = (freshShipmentsRes.data ??
      shipmentsRes.data ??
      []) as unknown as ShipmentRow[];
    const editable =
      order.status !== 'cancelled' &&
      order.status !== 'returned' &&
      shipments.every((s) => s.status === 'planned' && !s.ttn_number);

    // Remaining (unallocated) quantity per ordered item across all shipments.
    type ItemRow = { id: string; quantity: number };
    const items = ((itemsRes.data ?? []) as ItemRow[]).map((item) => ({
      ...item,
      allocated: shipments.reduce(
        (sum, s) =>
          sum +
          (s.order_shipment_items ?? [])
            .filter((si) => si.order_item_id === item.id)
            .reduce((q, si) => q + si.quantity, 0),
        0
      ),
    }));

    return NextResponse.json({
      order: orderRes.data,
      items,
      shipments: freshShipmentsRes.data ?? shipmentsRes.data ?? [],
      editable,
    });
  } catch (err) {
    console.error('Admin shipment plan API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireAdminApi();
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: 'Некоректний id замовлення' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некоректний JSON' }, { status: 400 });
  }

  // Structural/type validation mirrors the DB constraints for readable
  // errors; the RPC remains the authority.
  const parsed = parseShipmentPlanPayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const { data, error } = await ctx.serviceClient.rpc('admin_replace_shipment_plan', {
      p_order_id: id,
      p_plan: parsed.plan,
    });

    if (error) {
      console.error('admin shipment plan RPC failed:', error.code, error.message);
      const msg = error.message ?? '';
      if (msg.startsWith('SHIPMENTS_LOCKED')) {
        return NextResponse.json(
          { error: 'План зафіксовано: є відправлення з ТТН або в обробці' },
          { status: 409 }
        );
      }
      switch (error.code) {
        case 'P0400':
          return NextResponse.json({ error: 'Некоректний план відправлень' }, { status: 400 });
        case 'P0404':
          return NextResponse.json({ error: 'Замовлення не знайдено' }, { status: 404 });
        case 'P0409':
          return NextResponse.json(
            { error: 'Замовлення закрите або план вже зафіксовано' },
            { status: 409 }
          );
        default:
          return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
      }
    }

    return NextResponse.json({ result: data });
  } catch (err) {
    console.error('Admin shipment plan PUT API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
