/**
 * Admin shipment plan prefill from the structured checkout delivery choice
 * (stage 2G). Pure logic, no HTTP/DB.
 *
 * The manager opens the 2D planner: when the order carries a structured
 * Nova Post delivery choice in orders.shipping_info.delivery and the plan
 * is still EMPTY, the first planned shipment row is prefilled from it. A
 * non-empty plan is never touched (manual planning stays authoritative).
 *
 * DB mapping (migration 026 roles):
 *   - settlementId → city_ref (numeric text, Nova Post settlement id);
 *   - divisionId   → warehouse_ref (numeric text, Nova Post division id);
 *   - warehouse AND locker map to service_type 'nova_poshta_warehouse'
 *     (the locker distinction lives in the NP divisionCategory only);
 *   - courier keeps street_name/building/flat structured and composes the
 *     display `address` — never parsed back from a string.
 */

export interface CheckoutDeliveryInfo {
  serviceType: string;
  settlementId: number;
  settlementName: string;
  divisionId?: number;
  divisionName?: string;
  streetId?: number;
  streetName?: string;
  building?: string;
  flat?: string;
}

export interface PrefilledShipment {
  service_type: 'nova_poshta_warehouse' | 'nova_poshta_courier';
  city_ref: string;
  city_name: string;
  warehouse_ref: string | null;
  warehouse_name: string | null;
  address: string | null;
  street_name: string | null;
  building: string | null;
  flat: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Returns zero or one prefilled shipment row from the order's shipping_info
 * object. Any malformed delivery object yields an empty result — prefill is
 * a convenience, never a blocker.
 */
export function prefillShipmentDraft(
  shippingInfo: unknown
): PrefilledShipment[] {
  if (!isRecord(shippingInfo)) return [];
  const delivery = shippingInfo.delivery;
  if (!isRecord(delivery)) return [];

  const serviceType = delivery.serviceType;
  const settlementId = strictId(delivery.settlementId);
  if (
    (serviceType !== 'nova_poshta_warehouse' &&
      serviceType !== 'nova_poshta_locker' &&
      serviceType !== 'nova_poshta_courier') ||
    settlementId === null
  ) {
    return [];
  }
  const settlementName = text(delivery.settlementName).slice(0, 200);

  if (serviceType === 'nova_poshta_courier') {
    const streetName = text(delivery.streetName).slice(0, 100);
    const building = text(delivery.building).slice(0, 100);
    if (streetName.length === 0 || building.length === 0) return [];
    const flat = text(delivery.flat).slice(0, 10);
    const address = `${streetName}, ${building}${flat.length > 0 ? `, кв. ${flat}` : ''}`;
    return [
      {
        service_type: 'nova_poshta_courier',
        city_ref: String(settlementId),
        city_name: settlementName,
        warehouse_ref: null,
        warehouse_name: null,
        address,
        street_name: streetName,
        building,
        flat: flat.length > 0 ? flat : null,
      },
    ];
  }

  // warehouse + locker → nova_poshta_warehouse
  const divisionId = strictId(delivery.divisionId);
  if (divisionId === null) return [];
  const divisionName = text(delivery.divisionName).slice(0, 200);
  return [
    {
      service_type: 'nova_poshta_warehouse',
      city_ref: String(settlementId),
      city_name: settlementName,
      warehouse_ref: String(divisionId),
      warehouse_name: divisionName.length > 0 ? divisionName : null,
      address: null,
      street_name: null,
      building: null,
      flat: null,
    },
  ];
}
