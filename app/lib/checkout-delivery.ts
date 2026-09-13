/**
 * Checkout delivery sanitizer (stage 2G) — pure logic, no HTTP/DB.
 *
 * Validates the structured Nova Post delivery object the checkout sends
 * inside `shipping.delivery`. Strict whitelist contract:
 *
 *   {
 *     serviceType:    'nova_poshta_warehouse' | 'nova_poshta_locker'
 *                   | 'nova_poshta_courier' | 'ukrposhta_warehouse'
 *                   | 'pickup',
 *     settlementId:   integer >= 1   (GET /settlements id — NP locator;
 *                                    Ukrposhta Address Classifier CITY_ID;
 *                                    carrier types only — pickup has none),
 *     settlementName: display string,
 *     divisionId?:    integer >= 1   (warehouse / locker only; NP divisionId
 *                                    or UP post office ID),
 *     divisionName?:  display string,
 *     streetId?:      integer >= 1   (courier, optional street id),
 *     streetName?:    courier, required,
 *     building?:      courier, required,
 *     flat?:          courier, optional,
 *
 *     -- pickup only (values set server-side from PICKUP_POINTS): --
 *     pickupPointId:   whitelisted point id (PICKUP_POINTS),
 *     pickupPointName: canonical «city, address» (client value ignored),
 *     paymentIntent:   'online' (default) | 'cash_on_pickup'
 *   }
 *
 * Fail-closed rules:
 *   - ids are strict positive JSON integers (no numeric strings);
 *   - unknown keys are rejected — money/price/payer-like fields are
 *     structurally impossible in the contract (delivery is paid by the
 *     recipient, payerType is fixed server-side, cost never enters the
 *     order);
 *   - required fields depend on serviceType (warehouse/locker: settlement +
 *     division; courier: settlement + street + building; pickup: a
 *     whitelisted pickupPointId, everything else is set server-side).
 *
 * In the DB both warehouse and locker are stored under the admin plan's
 * `nova_poshta_warehouse` service type; the locker distinction lives in the
 * NP divisionCategory and in this checkout object only.
 */

export type CheckoutDeliveryServiceType =
  | 'nova_poshta_warehouse'
  | 'nova_poshta_locker'
  | 'nova_poshta_courier'
  | 'ukrposhta_warehouse'
  | 'pickup';

export interface CheckoutDelivery {
  serviceType: CheckoutDeliveryServiceType;
  /** Carrier orders only (NP/UP dictionary id); pickup has none. */
  settlementId?: number;
  settlementName: string;
  divisionId?: number;
  divisionName?: string;
  streetId?: number;
  streetName?: string;
  building?: string;
  flat?: string;
  /** Pickup only — canonical point id/address are set SERVER-SIDE from
   * PICKUP_POINTS; client values are ignored (never trusted). */
  pickupPointId?: string;
  pickupPointName?: string;
  /** Pickup only: 'online' (default) | 'cash_on_pickup'. */
  paymentIntent?: string;
}

/**
 * Кривий Ріг pickup points (owner-defined 2026-09-12): техника выдаётся на
 * Мазепы 87А, шпалеры — на Серафимовича 83А; a mixed cart may pick either
 * (the whole order waits at the chosen point). Single source of truth for
 * the checkout UI, the sanitizer whitelist and the Telegram notice.
 */
import type { ProductDomain } from './domains';

export interface PickupPoint {
  id: string;
  city: string;
  address: string;
  domains: ReadonlyArray<ProductDomain>;
}

export const PICKUP_POINTS: readonly PickupPoint[] = [
  {
    id: 'kr-mazepy-87a',
    city: 'Кривий Ріг',
    address: 'вул. Гетьмана Івана Мазепи, 87А',
    domains: ['tech'],
  },
  {
    id: 'kr-serafimovycha-83a',
    city: 'Кривий Ріг',
    address: 'вул. Серафимовича, 83А',
    domains: ['wallpaper'],
  },
];

export const PICKUP_PAYMENT_INTENTS = ['online', 'cash_on_pickup'] as const;
export type PickupPaymentIntent = (typeof PICKUP_PAYMENT_INTENTS)[number];

export type SanitizeDeliveryResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: CheckoutDelivery };

const SERVICE_TYPES: readonly string[] = [
  'nova_poshta_warehouse',
  'nova_poshta_locker',
  'nova_poshta_courier',
  // Ukrposhta office delivery: same object shape as an NP warehouse row
  // (settlement + division). Deliberately NO ukrposhta_courier.
  'ukrposhta_warehouse',
  // Кривий Ріг pickup: no carrier dictionaries — the point id must be one
  // of PICKUP_POINTS and the display address is set server-side.
  'pickup',
];

const ALLOWED_KEYS: readonly string[] = [
  'serviceType',
  'settlementId',
  'settlementName',
  'divisionId',
  'divisionName',
  'streetId',
  'streetName',
  'building',
  'flat',
  // Pickup-only (rejected on carrier types below — fail-closed).
  'pickupPointId',
  'pickupPointName',
  'paymentIntent',
];

const NAME_MAX = 200;
const BUILDING_MAX = 100;
const FLAT_MAX = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

/**
 * Trimmed display string. Contract: null = field absent (legitimate),
 * undefined = type violation or over the cap (invalid).
 */
function displayText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? undefined : trimmed.slice(0, max);
}

export function sanitizeDelivery(raw: unknown): SanitizeDeliveryResult {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (!isRecord(raw)) return { kind: 'invalid' };

  // Strict whitelist: any unexpected key (money, payer, cost, …) rejects
  // the whole object instead of being silently dropped.
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.includes(key)) return { kind: 'invalid' };
  }

  const serviceType = raw.serviceType;
  if (typeof serviceType !== 'string' || !SERVICE_TYPES.includes(serviceType)) {
    return { kind: 'invalid' };
  }

  // Pickup branch first: no carrier fields may ride along, the point must
  // be a whitelisted PICKUP_POINTS id and the display address is canonical
  // (client-sent pickupPointName/settlementName are ignored, not trusted).
  if (serviceType === 'pickup') {
    if (
      raw.settlementId !== undefined ||
      raw.divisionId !== undefined ||
      raw.streetId !== undefined ||
      raw.streetName !== undefined ||
      raw.building !== undefined ||
      raw.flat !== undefined
    ) {
      return { kind: 'invalid' };
    }
    const point = PICKUP_POINTS.find((p) => p.id === raw.pickupPointId);
    if (!point) return { kind: 'invalid' };
    const rawIntent = raw.paymentIntent;
    if (rawIntent !== undefined && typeof rawIntent !== 'string') {
      return { kind: 'invalid' };
    }
    const paymentIntent: PickupPaymentIntent =
      rawIntent === undefined ? 'online' : (rawIntent as PickupPaymentIntent);
    if (!PICKUP_PAYMENT_INTENTS.includes(paymentIntent)) {
      return { kind: 'invalid' };
    }
    const value: CheckoutDelivery = {
      serviceType: 'pickup',
      settlementName: point.city,
      pickupPointId: point.id,
      pickupPointName: `${point.city}, ${point.address}`,
      paymentIntent,
    };
    return { kind: 'ok', value };
  }
  // paymentIntent is a pickup-only field — a carrier order carrying it is
  // malformed (cash on pickup does not exist for NP/UP).
  if (raw.paymentIntent !== undefined) return { kind: 'invalid' };

  const settlementId = strictId(raw.settlementId);
  if (settlementId === null) return { kind: 'invalid' };

  const settlementName = displayText(raw.settlementName, NAME_MAX);
  if (settlementName === undefined) return { kind: 'invalid' };
  const value: CheckoutDelivery = {
    serviceType: serviceType as CheckoutDeliveryServiceType,
    settlementId,
    settlementName: settlementName ?? '',
  };

  if (serviceType === 'nova_poshta_courier') {
    const streetId = strictId(raw.streetId);
    if (raw.streetId !== undefined && streetId === null) {
      return { kind: 'invalid' };
    }
    if (streetId !== null) value.streetId = streetId;

    const streetName = displayText(raw.streetName, NAME_MAX);
    if (!streetName) return { kind: 'invalid' };
    value.streetName = streetName;

    const building = displayText(raw.building, BUILDING_MAX);
    if (!building) return { kind: 'invalid' };
    value.building = building;

    const flat = displayText(raw.flat, FLAT_MAX);
    if (flat === undefined) return { kind: 'invalid' };
    if (flat !== null) value.flat = flat;
  } else {
    // warehouse + locker: NP division is the destination.
    const divisionId = strictId(raw.divisionId);
    if (divisionId === null) return { kind: 'invalid' };
    value.divisionId = divisionId;

    const divisionName = displayText(raw.divisionName, NAME_MAX);
    if (divisionName === undefined) return { kind: 'invalid' };
    if (divisionName !== null) value.divisionName = divisionName;
  }

  return { kind: 'ok', value };
}
