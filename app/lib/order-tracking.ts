/**
 * Guest-facing parcel tracking (owner 2026-09-13): turns an order_shipments
 * row with a ttn_number into a human-readable carrier label and a deep link
 * to the carrier's tracking page. Pure functions, no HTTP/DB — the guest
 * order page injects the rows read via the service-role server client.
 *
 * Carrier values mirror the DB CHECK chk_order_shipments_carrier
 * (migration 038): carrier in ('nova_poshta','ukrposhta'); carrier
 * 'ukrposhta' pairs ONLY with service_type 'ukrposhta_warehouse' (strict
 * pairing enforced by the admin_replace_shipment_plan RPC).
 */

export const CARRIERS = ['nova_poshta', 'ukrposhta'] as const;
export type Carrier = (typeof CARRIERS)[number];

/**
 * Manual TTN format (owner attaches a paper-slip number): letters, digits
 * and hyphens only, 5–20 chars — covers Nova Post 14-digit numbers and
 * Ukrposhta 13-char barcodes (RR123456789UA).
 */
export const TTN_NUMBER_RE = /^[A-Za-z0-9-]{5,20}$/;
export const TTN_NUMBER_MAX_LENGTH = 20;

/** Nova Post domestic tracking: TTN goes straight into the hash route. */
const NOVA_POSHTA_TRACKING_BASE = 'https://tracking.novaposhta.ua/#/?number=';
/** Ukrposhta official tracking (track.ukrposhta.ua, ?ttn= query param). */
const UKRPOSHTA_TRACKING_BASE = 'https://track.ukrposhta.ua/tracking-uk/?ttn=';

export function isCarrier(value: unknown): value is Carrier {
  return typeof value === 'string' && (CARRIERS as readonly string[]).includes(value);
}

/**
 * Human-readable carrier name. service_type wins when the carrier column
 * is somehow out of sync — every service_type maps to exactly one carrier.
 */
export function carrierLabel(serviceType: string, carrier: string | null): string {
  if (serviceType === 'ukrposhta_warehouse') return 'Укрпошта';
  if (serviceType === 'nova_poshta_warehouse' || serviceType === 'nova_poshta_courier') {
    return 'Нова Пошта';
  }
  if (carrier === 'ukrposhta') return 'Укрпошта';
  if (carrier === 'nova_poshta') return 'Нова Пошта';
  return '';
}

/** Deep link to the carrier's tracking page; null for unknown inputs. */
export function trackingUrl(
  serviceType: string,
  carrier: string | null,
  ttnNumber: string
): string | null {
  if (typeof ttnNumber !== 'string' || !TTN_NUMBER_RE.test(ttnNumber)) return null;
  if (serviceType === 'ukrposhta_warehouse' || carrier === 'ukrposhta') {
    return UKRPOSHTA_TRACKING_BASE + encodeURIComponent(ttnNumber);
  }
  if (serviceType === 'nova_poshta_warehouse' || serviceType === 'nova_poshta_courier') {
    return NOVA_POSHTA_TRACKING_BASE + encodeURIComponent(ttnNumber);
  }
  return null;
}

/**
 * carrier ↔ service_type pairing (mirrors the RPC rule in migration 038):
 * carrier 'ukrposhta' ⇔ service_type 'ukrposhta_warehouse'.
 */
export function carrierServiceTypePairingOk(
  carrier: string,
  serviceType: string
): boolean {
  return (carrier === 'ukrposhta') === (serviceType === 'ukrposhta_warehouse');
}
