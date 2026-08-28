/**
 * Checkout delivery sanitizer (stage 2G) — pure logic, no HTTP/DB.
 *
 * Validates the structured Nova Post delivery object the checkout sends
 * inside `shipping.delivery`. Strict whitelist contract:
 *
 *   {
 *     serviceType:    'nova_poshta_warehouse' | 'nova_poshta_locker'
 *                   | 'nova_poshta_courier',
 *     settlementId:   integer >= 1   (GET /settlements id — NP locator),
 *     settlementName: display string,
 *     divisionId?:    integer >= 1   (warehouse / locker only),
 *     divisionName?:  display string,
 *     streetId?:      integer >= 1   (courier, optional street id),
 *     streetName?:    courier, required,
 *     building?:      courier, required,
 *     flat?:          courier, optional
 *   }
 *
 * Fail-closed rules:
 *   - ids are strict positive JSON integers (no numeric strings);
 *   - unknown keys are rejected — money/price/payer-like fields are
 *     structurally impossible in the contract (delivery is paid by the
 *     recipient, payerType is fixed server-side, cost never enters the
 *     order);
 *   - required fields depend on serviceType (warehouse/locker: settlement +
 *     division; courier: settlement + street + building).
 *
 * In the DB both warehouse and locker are stored under the admin plan's
 * `nova_poshta_warehouse` service type; the locker distinction lives in the
 * NP divisionCategory and in this checkout object only.
 */

export type CheckoutDeliveryServiceType =
  | 'nova_poshta_warehouse'
  | 'nova_poshta_locker'
  | 'nova_poshta_courier';

export interface CheckoutDelivery {
  serviceType: CheckoutDeliveryServiceType;
  settlementId: number;
  settlementName: string;
  divisionId?: number;
  divisionName?: string;
  streetId?: number;
  streetName?: string;
  building?: string;
  flat?: string;
}

export type SanitizeDeliveryResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: CheckoutDelivery };

const SERVICE_TYPES: readonly string[] = [
  'nova_poshta_warehouse',
  'nova_poshta_locker',
  'nova_poshta_courier',
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
