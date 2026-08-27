/**
 * Admin delivery cost calculation (stage 2E) — pure mapping/selection logic.
 *
 * Scope: WAREHOUSE shipments only. The live calculations endpoint resolves
 * recipient cities against its internal dictionary and rejects free-text
 * cities ("RecipientCityName not selected"), so courier calculation is not
 * implementable until Nova Post clarifies city selection — courier inputs
 * are skipped with an explicit reason, never guessed.
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
  warehouse_ref: string | null;
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
  if (s.service_type !== 'nova_poshta_warehouse') {
    return { ok: false, reason: 'courier_not_supported', detail: s.service_type };
  }
  const divisionId = Number(s.warehouse_ref);
  if (
    !s.warehouse_ref ||
    !Number.isInteger(divisionId) ||
    divisionId < 1
  ) {
    return { ok: false, reason: 'bad_destination', detail: String(s.warehouse_ref) };
  }
  if (s.parcels.length === 0) {
    return { ok: false, reason: 'no_parcels' };
  }

  return {
    ok: true,
    input: {
      parcels: s.parcels.map((p) => ({
        cargoCategory: p.cargo_category as ParsedCalculation['parcels'][number]['cargoCategory'],
        rowNumber: p.parcel_index,
        actualWeightGrams: p.actual_weight_grams,
        widthMm: p.width_mm,
        lengthMm: p.length_mm,
        heightMm: p.height_mm,
        insuranceCost: p.insurance_cost,
      })),
      recipientDivisionId: divisionId,
      recipientAddress: null,
    },
  };
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
