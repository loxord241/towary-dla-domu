import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import { parseManualTtnPayload } from '@/app/lib/admin-shipments-manual-ttn';
import { carrierServiceTypePairingOk } from '@/app/lib/order-tracking';

/**
 * Manual TTN attach (owner 2026-09-13): the owner hands the parcel over at
 * a carrier branch and gets the tracking number on paper — no Nova Post API
 * call is involved, unlike shipments/ttn (stage 2F).
 *
 * POST /api/admin/orders/[id]/shipments/manual-ttn
 *   body { shipment_id, ttn_number, carrier }
 *   → UPDATE order_shipments SET ttn_number, carrier, status='created'
 *     WHERE id = shipment_id AND order_id = :id (a shipment of a DIFFERENT
 *     order can never be touched) AND status='planned' AND ttn_number IS NULL
 *     (atomic: an existing TTN is never overwritten).
 *   → { ok: true, ttn_number }
 *
 * Carrier ↔ service_type pairing mirrors migration 038 (ukrposhta ⇔
 * ukrposhta_warehouse) — the DB CHECK would reject a mismatch with an
 * unreadable 500, so it is validated here for a readable error.
 */

interface ShipmentRow {
  service_type: string;
}

async function readShipmentServiceType(
  serviceClient: SupabaseClient,
  orderId: string,
  shipmentId: string
): Promise<ShipmentRow | null> {
  const res = await serviceClient
    .from('order_shipments')
    .select('service_type')
    .eq('id', shipmentId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (res.error) {
    throw new Error(`shipment fetch failed: ${res.error.message}`);
  }
  return (res.data ?? null) as ShipmentRow | null;
}

export async function POST(
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

  const parsed = parseManualTtnPayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { shipment_id: shipmentId, ttn_number: ttnNumber, carrier } = parsed.payload;

  try {
    const shipment = await readShipmentServiceType(ctx.serviceClient, id, shipmentId);
    if (!shipment) {
      return NextResponse.json({ error: 'Відправлення не знайдено' }, { status: 404 });
    }
    if (!carrierServiceTypePairingOk(carrier, shipment.service_type)) {
      return NextResponse.json(
        { error: 'Перевізник не відповідає типу доставки відправлення' },
        { status: 400 }
      );
    }

    // Atomic guard: the row must still be planned AND TTN-free — a second
    // concurrent attach (manual or via Nova Post API) can never overwrite.
    const upd = await ctx.serviceClient
      .from('order_shipments')
      .update({ ttn_number: ttnNumber, carrier, status: 'created' })
      .eq('id', shipmentId)
      .eq('order_id', id)
      .eq('status', 'planned')
      .is('ttn_number', null)
      .select('id');
    if (upd.error) {
      console.error('manual-ttn update failed:', upd.error.message);
      return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
    }
    if (!Array.isArray(upd.data) || upd.data.length !== 1) {
      return NextResponse.json(
        { error: 'Відправлення вже має ТТН або більше не в статусі planned' },
        { status: 409 }
      );
    }

    return NextResponse.json({ ok: true, ttn_number: ttnNumber });
  } catch (err) {
    console.error('Admin manual TTN API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
