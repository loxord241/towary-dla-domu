import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAdminApi, isUuid } from '@/app/lib/admin-api';
import { getNovaPostClient } from '@/app/lib/delivery/novapost/client';
import { mapNovaPostFailure } from '@/app/lib/delivery/novapost/map-failure';
import { NovaPostError } from '@/app/lib/delivery/novapost/errors';
import {
  readNovaPostSenderDivisionId,
  readNovaPostSenderName,
  readNovaPostSenderPhone,
} from '@/app/lib/delivery/novapost/config';
import {
  createShipment,
  findShipmentsByClientOrder,
  deleteShipmentByRef,
} from '@/app/lib/delivery/novapost/shipments';
import {
  buildShipmentTtnPayload,
  createTtnForShipment,
  rollbackShipmentTtn,
  type TtnNpAdapter,
} from '@/app/lib/admin-shipments-ttn';

/**
 * Stage 2F — admin TTN creation for WAREHOUSE shipments (Nova Post).
 *
 * POST   /api/admin/orders/[id]/shipments/ttn  body { shipment_id }
 *   Duplicate-TTN protection (sandbox-verified contract):
 *     1. pre-check GET /shipments?clientOrder=… — an active TTN from a
 *        previous attempt is ADOPTED, never re-created;
 *     2. POST /shipments exactly once — unknown outcomes (timeout/503) are
 *        NEVER retried blindly; the caller reconciles via clientOrder
 *        (retry-adopt) instead;
 *     3. after 201 the shipment is marked planned→created atomically
 *        (conditional UPDATE … WHERE status='planned' AND ttn_ref IS NULL);
 *        losing the race deletes the duplicate document we just created;
 *     4. 422 provider rejections are persisted to np_last_error_code /
 *        np_last_error for admin retries.
 *
 * DELETE /api/admin/orders/[id]/shipments/ttn  body { shipment_id }
 *   Admin rollback: delete the provider document by Ref ID, then reset the
 *   row to 'planned' (cleared ttn fields and delivery_cost) — only while
 *   status = 'created'; the provider delete must succeed BEFORE the DB reset.
 *
 * Stage 2G: courier shipments are supported — recipient built from the
 * settlementId (city_ref) + structured address parts (migration 026).
 * ⚠️ The courier POST /shipments branch has NOT been live-tested (would
 * create a real TTN): the FIRST courier TTN must be created against the
 * sandbox, then verified (201 → DB row → clientOrder reconciliation →
 * rollback DELETE by ttn_ref → back to 'planned') before production use.
 * Warehouse/payment/tracking flows are untouched.
 */

const INVALID_MESSAGES: Record<string, string> = {
  not_planned: 'Відправлення не в статусі planned',
  bad_destination: 'Некоректне відділення призначення',
  no_parcels: 'Немає місць (посилок) у відправленні',
  bad_recipient_name: 'Некоректне ім’я отримувача в замовленні',
  bad_recipient_phone: 'Некоректний телефон отримувача в замовленні',
  bad_sender_phone: 'Некоректний телефон відправника (NOVA_POST_SENDER_PHONE)',
};

interface ShipmentRow {
  id: string;
  shipment_index: number;
  status: string;
  service_type: string;
  city_ref: string | null;
  city_name: string | null;
  warehouse_ref: string | null;
  street_name: string | null;
  building: string | null;
  flat: string | null;
  ttn_ref: string | null;
  ttn_number: string | null;
  order_shipment_parcels: {
    parcel_index: number;
    cargo_category: string;
    actual_weight_grams: number;
    width_mm: number;
    length_mm: number;
    height_mm: number;
    insurance_cost: number;
  }[];
  order_shipment_items: {
    quantity: number;
    order_items: { product_name: string } | null;
  }[];
}

interface OrderRow {
  shipping_info: Record<string, unknown> | null;
}

const SHIPMENT_SELECT = `
  id, shipment_index, status, service_type, city_ref, city_name,
  warehouse_ref, street_name, building, flat, ttn_ref, ttn_number,
  order_shipment_parcels(parcel_index, cargo_category, actual_weight_grams,
    width_mm, length_mm, height_mm, insurance_cost),
  order_shipment_items(quantity, order_items(product_name))
`.replace(/\s+/g, ' ');

async function readShipmentRow(
  serviceClient: SupabaseClient,
  orderId: string,
  shipmentId: string
): Promise<ShipmentRow | null> {
  const res = await serviceClient
    .from('order_shipments')
    .select(SHIPMENT_SELECT)
    .eq('id', shipmentId)
    .eq('order_id', orderId)
    .maybeSingle();
  if (res.error) {
    throw new Error(`shipment fetch failed: ${res.error.message}`);
  }
  return (res.data ?? null) as ShipmentRow | null;
}

function providerAdapter(): TtnNpAdapter {
  const client = getNovaPostClient();
  return {
    findByClientOrder: (co) => findShipmentsByClientOrder(client, co),
    create: (payload) => createShipment(client, payload),
    deleteByRef: (ref) => deleteShipmentByRef(client, ref),
  };
}

function parseBodyShipmentId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { shipment_id?: unknown }).shipment_id;
  return typeof id === 'string' && isUuid(id) ? id : null;
}

// mapNovaPostFailure returns fixed, curated Ukrainian strings — destructure
// to keep raw *.message expressions out of response bodies.
function novaPostFailureResponse(err: NovaPostError): NextResponse | null {
  const failure = mapNovaPostFailure(err);
  if (!failure) return null;
  const { status, message } = failure;
  return NextResponse.json({ error: message }, { status });
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
  const shipmentId = parseBodyShipmentId(body);
  if (!shipmentId) {
    return NextResponse.json({ error: 'Некоректний id відправлення' }, { status: 400 });
  }

  const divisionId = readNovaPostSenderDivisionId();
  const senderName = readNovaPostSenderName();
  const senderPhone = readNovaPostSenderPhone();
  if (divisionId === null || senderName === null || senderPhone === null) {
    return NextResponse.json(
      { error: 'Створення ТТН не налаштовано (NOVA_POST_SENDER_*)' },
      { status: 503 }
    );
  }

  try {
    const [shipmentRes, orderRes] = await Promise.all([
      readShipmentRow(ctx.serviceClient, id, shipmentId),
      ctx.serviceClient
        .from('orders')
        .select('shipping_info')
        .eq('id', id)
        .maybeSingle(),
    ]);
    if (orderRes.error) {
      throw new Error(`order fetch failed: ${orderRes.error.message}`);
    }
    if (!shipmentRes) {
      return NextResponse.json({ error: 'Відправлення не знайдено' }, { status: 404 });
    }
    const shipment = shipmentRes;
    if (shipment.ttn_number || shipment.ttn_ref) {
      return NextResponse.json(
        { error: 'ТТН для цього відправлення вже створено' },
        { status: 409 }
      );
    }
    const order = (orderRes.data ?? null) as OrderRow | null;
    const shipping = order?.shipping_info ?? null;

    const built = buildShipmentTtnPayload(
      {
        shipment_id: shipment.id,
        status: shipment.status,
        service_type: shipment.service_type,
        city_ref: shipment.city_ref,
        city_name: shipment.city_name,
        warehouse_ref: shipment.warehouse_ref,
        street_name: shipment.street_name,
        building: shipment.building,
        flat: shipment.flat,
        parcels: shipment.order_shipment_parcels ?? [],
        productNames: (shipment.order_shipment_items ?? []).map(
          (si) => si.order_items?.product_name ?? ''
        ),
        recipientName:
          typeof shipping?.name === 'string' ? shipping.name : null,
        recipientPhone:
          typeof shipping?.phone === 'string' ? shipping.phone : null,
      },
      { divisionId, name: senderName, phone: senderPhone }
    );

    const outcome = await createTtnForShipment({
      built,
      np: providerAdapter(),
      markCreated: async (input) => {
        const upd = await ctx.serviceClient
          .from('order_shipments')
          .update({
            status: 'created',
            ttn_ref: input.ttnRef,
            ttn_number: input.ttnNumber,
            ...(input.deliveryCost !== null
              ? { delivery_cost: input.deliveryCost }
              : {}),
          })
          .eq('id', shipment.id)
          .eq('status', 'planned')
          .is('ttn_ref', null)
          .select('id');
        if (upd.error) {
          console.error('ttn markCreated failed:', upd.error.message);
          return false;
        }
        return Array.isArray(upd.data) && upd.data.length === 1;
      },
      saveProviderError: async (code, message) => {
        await ctx.serviceClient
          .from('order_shipments')
          .update({ np_last_error_code: code, np_last_error: message })
          .eq('id', shipment.id);
      },
    });

    switch (outcome.kind) {
      case 'created':
      case 'adopted':
        return NextResponse.json({
          result: outcome.kind,
          ttn_ref: outcome.ttnRef,
          ttn_number: outcome.ttnNumber,
          delivery_cost: outcome.deliveryCost,
        });
      case 'conflict':
        return NextResponse.json(
          { error: 'ТТН для цього відправлення вже створено' },
          { status: 409 }
        );
      case 'invalid':
        return NextResponse.json(
          { error: INVALID_MESSAGES[outcome.reason] ?? 'Некоректні дані відправлення' },
          { status: outcome.reason === 'not_planned' ? 409 : 400 }
        );
      case 'provider_rejected':
        return NextResponse.json(
          { error: 'Перевізник не прийняв параметри відправлення' },
          { status: 422 }
        );
      case 'unknown_state':
        return NextResponse.json(
          {
            error:
              'Результат створення ТТН невідомий. Повторіть спробу — наявне відправлення буде знайдено автоматично',
          },
          { status: 503 }
        );
    }
  } catch (err) {
    if (err instanceof NovaPostError) {
      const response = novaPostFailureResponse(err);
      if (response) return response;
    }
    console.error('Admin TTN create API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}

export async function DELETE(
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
  const shipmentId = parseBodyShipmentId(body);
  if (!shipmentId) {
    return NextResponse.json({ error: 'Некоректний id відправлення' }, { status: 400 });
  }

  try {
    const shipment = await readShipmentRow(ctx.serviceClient, id, shipmentId);
    if (!shipment) {
      return NextResponse.json({ error: 'Відправлення не знайдено' }, { status: 404 });
    }
    if (shipment.status !== 'created' || !shipment.ttn_ref) {
      return NextResponse.json(
        { error: 'Скасувати можна лише ТТН у статусі created' },
        { status: 409 }
      );
    }
    const ttnRef = shipment.ttn_ref;

    const outcome = await rollbackShipmentTtn({
      np: providerAdapter(),
      ttnRef,
      resetRow: async (ref) => {
        const upd = await ctx.serviceClient
          .from('order_shipments')
          .update({
            status: 'planned',
            ttn_ref: null,
            ttn_number: null,
            delivery_cost: null,
          })
          .eq('id', shipment.id)
          .eq('status', 'created')
          .eq('ttn_ref', ref)
          .select('id');
        if (upd.error) {
          console.error('ttn rollback reset failed:', upd.error.message);
          return false;
        }
        return Array.isArray(upd.data) && upd.data.length === 1;
      },
    });

    switch (outcome.kind) {
      case 'rolled_back':
        return NextResponse.json({ result: 'rolled_back' });
      case 'provider_failed':
        return NextResponse.json(
          { error: 'Не вдалося скасувати ТТН у перевізника. Спробуйте пізніше' },
          { status: 503 }
        );
      case 'reset_failed':
        return NextResponse.json(
          { error: 'Стан відправлення змінився. Оновіть сторінку' },
          { status: 409 }
        );
    }
  } catch (err) {
    if (err instanceof NovaPostError) {
      const response = novaPostFailureResponse(err);
      if (response) return response;
    }
    console.error('Admin TTN rollback API error:', err);
    return NextResponse.json({ error: 'Внутрішня помилка сервера' }, { status: 500 });
  }
}
