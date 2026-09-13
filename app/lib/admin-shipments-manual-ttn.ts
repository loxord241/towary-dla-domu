/**
 * Manual TTN attach (owner 2026-09-13): payload validation for
 * POST /api/admin/orders/[id]/shipments/manual-ttn. The owner sends the
 * parcel from a branch office and gets the tracking number on paper — no
 * Nova Post API call is involved, so this is a plain validated UPDATE.
 *
 * Pure functions, no HTTP/DB: the route injects the service client and the
 * row guard (id + order_id + status='planned' + no TTN yet) stays there.
 */
import { isCarrier, TTN_NUMBER_RE, type Carrier } from './order-tracking.ts';

// Local copy of admin-api isUuid — this lib must stay importable by plain
// node:test, and app/lib/admin-api.ts pulls in next/headers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface ManualTtnPayload {
  shipment_id: string;
  ttn_number: string;
  carrier: Carrier;
}

export type ManualTtnParseResult =
  | { ok: true; payload: ManualTtnPayload }
  | { ok: false; error: string };

export function parseManualTtnPayload(body: unknown): ManualTtnParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Некоректний запит' };
  }
  const raw = body as Record<string, unknown>;

  const shipmentId = typeof raw.shipment_id === 'string' ? raw.shipment_id : '';
  if (!isUuid(shipmentId)) {
    return { ok: false, error: 'Некоректний id відправлення' };
  }

  const ttnNumber =
    typeof raw.ttn_number === 'string' ? raw.ttn_number.trim() : '';
  if (!TTN_NUMBER_RE.test(ttnNumber)) {
    return {
      ok: false,
      error: 'ТТН: 5–20 символів, лише латинські літери, цифри та дефіси',
    };
  }

  if (!isCarrier(raw.carrier)) {
    return { ok: false, error: 'Невідомий перевізник' };
  }

  return {
    ok: true,
    payload: { shipment_id: shipmentId, ttn_number: ttnNumber, carrier: raw.carrier },
  };
}
