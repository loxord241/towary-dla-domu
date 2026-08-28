/**
 * Admin delivery cost calculation (stage 2E + 2G) — pure mapping/selection
 * logic.
 *
 * Both branches flow through the shared calculateDeliveryCost pipeline:
 *   - WAREHOUSE (incl. parcel lockers): recipient resolved by divisionId
 *     (warehouse_ref = Nova Post division id);
 *   - COURIER (stage 2G, live-verified): recipient resolved ONLY via
 *     recipient.settlementId (city_ref = GET /settlements integer id) plus
 *     structured address parts (street/building/flat, migration 026) —
 *     never by free-text city, which the provider rejects (422
 *     "RecipientCityName not selected").
 *
 * Service selection is fail-closed (verified live 2026-08-27): for a
 * domestic UA request the response carries exactly one delivery service
 * row; zero or multiple valid rows are an error, never silently resolved.
 *
 * Pure functions, no HTTP/DB. Run: npm test
 */

import type { NpDeliveryQuote } from './delivery/novapost/types.ts';
import type { ParsedCalculation } from './delivery/novapost/delivery-cost.ts';

export interface ShipmentForCalcParcel {
  parcel_index: number;
  cargo_category: string;
  actual_weight_grams: number;
  width_mm: number;
  length_mm: number;
  height_mm: number;
  insurance_cost: number;
}

export interface ShipmentForCalc {
  shipment_id: string;
  shipment_index: number;
  status: string;
  service_type: string;
  city_ref: string | null;
  city_name: string | null;
  warehouse_ref: string | null;
  street_name: string | null;
  building: string | null;
  flat: string | null;
  parcels: ShipmentForCalcParcel[];
}

export type CalcSkipReason =
  | 'not_planned'
  | 'courier_not_supported'
  | 'no_parcels'
  | 'bad_destination';

export type CalcInputResult =
  | { ok: true; input: ParsedCalculation }
  | { ok: false; reason: CalcSkipReason; detail?: string };

export function buildCalculationInput(s: ShipmentForCalc): CalcInputResult {
  if (s.status !== 'planned') {
    return { ok: false, reason: 'not_planned', detail: `status=${s.status}` };
  }
  if (s.parcels.length === 0) {
    return { ok: false, reason: 'no_parcels' };
  }

  const parcels = s.parcels.map((p) => ({
    cargoCategory: p.cargo_category as ParsedCalculation['parcels'][number]['cargoCategory'],
    rowNumber: p.parcel_index,
    actualWeightGrams: p.actual_weight_grams,
    widthMm: p.width_mm,
    lengthMm: p.length_mm,
    heightMm: p.height_mm,
    insuranceCost: p.insurance_cost,
  }));

  if (s.service_type === 'nova_poshta_warehouse') {
    const divisionId = Number(s.warehouse_ref);
    if (
      !s.warehouse_ref ||
      !Number.isInteger(divisionId) ||
      divisionId < 1
    ) {
      return { ok: false, reason: 'bad_destination', detail: String(s.warehouse_ref) };
    }
    return {
      ok: true,
      input: {
        parcels,
        recipientDivisionId: divisionId,
        recipientSettlementId: null,
        recipientAddress: null,
      },
    };
  }

  if (s.service_type === 'nova_poshta_courier') {
    // Live-verified locator: settlementId integer + structured address
    // parts. Free-text city resolution is impossible (422) — fail closed.
    const settlementId = Number(s.city_ref);
    if (!s.city_ref || !Number.isInteger(settlementId) || settlementId < 1) {
      return { ok: false, reason: 'bad_destination', detail: String(s.city_ref) };
    }
    const street = (s.street_name ?? '').trim();
    const building = (s.building ?? '').trim();
    if (street.length === 0 || building.length === 0) {
      return {
        ok: false,
        reason: 'bad_destination',
        detail: 'courier shipment lacks structured street/building',
      };
    }
    return {
      ok: true,
      input: {
        parcels,
        recipientDivisionId: null,
        recipientSettlementId: settlementId,
        recipientAddress: {
          city: s.city_name,
          street,
          building,
          flat: (s.flat ?? '').trim() || null,
          postCode: null,
        },
      },
    };
  }

  return { ok: false, reason: 'courier_not_supported', detail: s.service_type };
}

export type ServiceSelection =
  | { ok: true; cost: number; scheduledDeliveryDate: string | null }
  | { ok: false; error: 'no_services' | 'ambiguous_services' };

export function selectDeliveryService(quote: NpDeliveryQuote): ServiceSelection {
  // normalizeQuote already guarantees every row has a finite, non-negative
  // cost — but re-verify here so the fail-closed rule cannot regress.
  const rows = quote.services.filter(
    (s) => typeof s.cost === 'number' && Number.isFinite(s.cost) && s.cost >= 0
  );
  if (rows.length === 0) return { ok: false, error: 'no_services' };
  if (rows.length > 1) return { ok: false, error: 'ambiguous_services' };
  return {
    ok: true,
    cost: rows[0].cost,
    scheduledDeliveryDate: quote.scheduledDeliveryDate,
  };
}
