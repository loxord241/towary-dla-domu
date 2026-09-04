/**
 * Stage 2F — TTN creation for warehouse shipments: payload builder and
 * orchestration. Pure logic, no HTTP/DB — the API route injects the
 * Supabase service client and the Nova Post client.
 *
 * Sandbox-verified provider contract (api-stage.novapost.com, 2026-08-27):
 *   - domestic UA needs NO invoice / status / note;
 *   - sender/recipient use `divisionId` (camelCase);
 *   - parcels require cargoCategory + parcelDescription, weights in grams
 *     (10 g precision), dimensions in mm, insuranceCost = declared value
 *     in UAH (> 0);
 *   - payerType = Recipient;
 *   - Nova Post does NOT deduplicate clientOrder — duplicate protection is
 *     ours: pre-check lookup → adopt; unknown POST outcome → recovery
 *     lookup (never a blind re-POST); DB unique ttn_* indexes for the race.
 *
 * clientOrder = shipment_id (deterministic, ≤ 50 chars) so a TTN created
 * but not yet recorded (crash window) is always discoverable again.
 */

import { NovaPostError } from './delivery/novapost/errors.ts';
import type {
  NpShipmentCreated,
  NpShipmentSummary,
} from './delivery/novapost/shipments.ts';

// ------------------------------------------------------------- payload ----

export interface TtnParcelRow {
  parcel_index: number;
  cargo_category: string;
  actual_weight_grams: number;
  width_mm: number;
  length_mm: number;
  height_mm: number;
  insurance_cost: number;
}

export interface TtnSourceShipment {
  shipment_id: string;
  status: string;
  service_type: string;
  /** Nova Post settlementId (numeric text) — courier locator (stage 2G). */
  city_ref: string | null;
  city_name: string | null;
  warehouse_ref: string | null;
  /** Structured courier address parts (migration 026). */
  street_name: string | null;
  building: string | null;
  flat: string | null;
  parcels: TtnParcelRow[];
  productNames: string[];
  recipientName: string | null;
  recipientPhone: string | null;
}

export interface TtnSender {
  divisionId: number;
  name: string;
  phone: string;
}

/**
 * Recipient location branch: warehouse → divisionId; courier →
 * settlementId + addressParts (live-verified locator, stage 2G).
 */
export type NpRecipient = {
  name: string;
  phone: string;
  countryCode: 'UA';
  divisionId?: number;
  settlementId?: number;
  addressParts?: {
    city?: string;
    street: string;
    building: string;
    flat?: string;
  };
};

export interface NpShipmentPayload {
  clientOrder: string;
  payerType: 'Recipient';
  sender: {
    name: string;
    phone: string;
    countryCode: 'UA';
    divisionId: number;
  };
  recipient: NpRecipient;
  parcels: {
    rowNumber: number;
    cargoCategory: string;
    parcelDescription: string;
    insuranceCost: number;
    actualWeight: number;
    width: number;
    length: number;
    height: number;
  }[];
}

export type TtnBuildSkipReason =
  | 'not_planned'
  | 'bad_destination'
  | 'no_parcels'
  | 'bad_recipient_name'
  | 'bad_recipient_phone'
  | 'bad_sender_phone';

export type TtnBuildResult =
  | { ok: true; payload: NpShipmentPayload; clientOrder: string }
  | { ok: false; reason: TtnBuildSkipReason };

const PARCEL_DESCRIPTION_MAX_LENGTH = 255;
const PHONE_MIN_DIGITS = 8;
const PHONE_MAX_DIGITS = 15;

/** E.164 digits only; strips '+', spaces and separators. */
function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    return null;
  }
  return digits;
}

function buildParcelDescription(productNames: string[]): string {
  const joined = productNames
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0)
    .join(', ')
    .slice(0, PARCEL_DESCRIPTION_MAX_LENGTH);
  return joined.length > 0 ? joined : 'Товари замовлення';
}

export function buildShipmentTtnPayload(
  s: TtnSourceShipment,
  sender: TtnSender
): TtnBuildResult {
  if (s.status !== 'planned') {
    return { ok: false, reason: 'not_planned' };
  }
  if (s.parcels.length === 0) {
    return { ok: false, reason: 'no_parcels' };
  }

  let recipient: NpRecipient | null = null;

  if (s.service_type === 'nova_poshta_warehouse') {
    const divisionId = Number(s.warehouse_ref);
    if (!s.warehouse_ref || !Number.isInteger(divisionId) || divisionId < 1) {
      return { ok: false, reason: 'bad_destination' };
    }
    recipient = {
      name: '',
      phone: '',
      countryCode: 'UA',
      divisionId,
    };
  } else if (s.service_type === 'nova_poshta_courier') {
    // Stage 2G (live-verified): the courier recipient is resolved ONLY via
    // settlementId + addressParts; street/building come from the
    // structured checkout/admin data, never parsed out of the display
    // `address` string. POST /shipments has NOT been live-tested with this
    // branch — the first courier TTN must go through the sandbox and use
    // the clientOrder adopt/reconcile + Ref-ID rollback paths.
    const settlementId = Number(s.city_ref);
    const street = (s.street_name ?? '').trim();
    const building = (s.building ?? '').trim();
    if (!s.city_ref || !Number.isInteger(settlementId) || settlementId < 1) {
      return { ok: false, reason: 'bad_destination' };
    }
    if (street.length === 0 || building.length === 0) {
      return { ok: false, reason: 'bad_destination' };
    }
    const city = (s.city_name ?? '').trim();
    const flat = (s.flat ?? '').trim();
    recipient = {
      name: '',
      phone: '',
      countryCode: 'UA',
      settlementId,
      addressParts: {
        ...(city.length > 0 ? { city } : {}),
        street,
        building,
        ...(flat.length > 0 ? { flat } : {}),
      },
    };
  } else {
    return { ok: false, reason: 'bad_destination' };
  }

  const senderPhone = normalizePhone(sender.phone);
  if (!senderPhone) {
    return { ok: false, reason: 'bad_sender_phone' };
  }
  const recipientName =
    typeof s.recipientName === 'string' ? s.recipientName.trim() : '';
  if (recipientName.length === 0) {
    return { ok: false, reason: 'bad_recipient_name' };
  }
  const recipientPhone = normalizePhone(s.recipientPhone);
  if (!recipientPhone) {
    return { ok: false, reason: 'bad_recipient_phone' };
  }
  recipient.name = recipientName;
  recipient.phone = recipientPhone;

  const parcelDescription = buildParcelDescription(s.productNames);
  return {
    ok: true,
    clientOrder: s.shipment_id,
    payload: {
      clientOrder: s.shipment_id,
      payerType: 'Recipient',
      sender: {
        name: sender.name,
        phone: senderPhone,
        countryCode: 'UA',
        divisionId: sender.divisionId,
      },
      recipient,
      parcels: s.parcels.map((p) => ({
        rowNumber: p.parcel_index,
        cargoCategory: p.cargo_category,
        parcelDescription,
        insuranceCost: p.insurance_cost,
        actualWeight: p.actual_weight_grams,
        width: p.width_mm,
        length: p.length_mm,
        height: p.height_mm,
      })),
    },
  };
}

// -------------------------------------------------------- orchestration ---

/** Nova Post operations the orchestration needs (injected for tests). */
export interface TtnNpAdapter {
  findByClientOrder(clientOrder: string): Promise<NpShipmentSummary[]>;
  create(payload: unknown): Promise<NpShipmentCreated>;
  deleteByRef(ref: string): Promise<'deleted' | 'already_deleted'>;
}

export interface TtnMarkInput {
  ttnRef: string;
  ttnNumber: string;
  deliveryCost: number | null;
}

export interface TtnCreateDeps {
  built: TtnBuildResult;
  np: TtnNpAdapter;
  /** Atomic planned→created update; false = lost the race / already marked. */
  markCreated(input: TtnMarkInput): Promise<boolean>;
  /** Persists np_last_error_code / np_last_error on the shipment row. */
  saveProviderError(code: string | null, message: string): Promise<void>;
}

export type TtnCreateOutcome =
  | { kind: 'created' | 'adopted'; ttnRef: string; ttnNumber: string; deliveryCost: number | null }
  | { kind: 'conflict' }
  | { kind: 'invalid'; reason: TtnBuildSkipReason }
  | { kind: 'provider_rejected' }
  | { kind: 'unknown_state' };

function isActive(summary: NpShipmentSummary): boolean {
  return summary.deletedAt === null && summary.status !== 'Deleted';
}

/**
 * Creates (or adopts) the TTN for one shipment.
 *
 * Order of operations (duplicate-TTN protection, sandbox-verified):
 *   1. pre-check lookup by clientOrder — an active TTN from a previous
 *      attempt is ADOPTED, never re-POSTed;
 *   2. POST /shipments exactly once;
 *   3. unknown outcome (network/5xx) → recovery lookup; adopt if found;
 *      a blind re-POST is FORBIDDEN;
 *   4. 422 validation rejection → np_last_error saved, no retry;
 *   5. after 201 the atomic planned→created mark decides ownership:
 *      losing the race triggers a best-effort DELETE of the TTN we just
 *      created so the winner's row stays the only provider document.
 */
export async function createTtnForShipment(
  deps: TtnCreateDeps
): Promise<TtnCreateOutcome> {
  if (!deps.built.ok) {
    return { kind: 'invalid', reason: deps.built.reason };
  }
  const clientOrder = deps.built.clientOrder;

  // 1. Pre-check / crash-window adoption.
  const preExisting = await deps.np.findByClientOrder(clientOrder);
  const active = preExisting.find(isActive);
  if (active) {
    const marked = await deps.markCreated({
      ttnRef: active.id,
      ttnNumber: active.number,
      deliveryCost: null,
    });
    return marked
      ? { kind: 'adopted', ttnRef: active.id, ttnNumber: active.number, deliveryCost: null }
      : { kind: 'conflict' };
  }

  // 2. Single POST.
  let created: NpShipmentCreated;
  try {
    created = await deps.np.create(deps.built.payload);
  } catch (error) {
    if (error instanceof NovaPostError && error.kind === 'provider_error') {
      // 4. Deterministic validation rejection — persist for admin retries.
      const details = error.providerDetails;
      const code = details ? Object.keys(details)[0] ?? null : null;
      const message = details
        ? Object.values(details)[0] ?? error.message
        : error.message;
      await deps.saveProviderError(code, message.slice(0, 500));
      return { kind: 'provider_rejected' };
    }
    // 3. Unknown outcome — reconcile, never blind-retry.
    const recovery = await deps.np.findByClientOrder(clientOrder);
    const recovered = recovery.find(isActive);
    if (recovered) {
      const marked = await deps.markCreated({
        ttnRef: recovered.id,
        ttnNumber: recovered.number,
        deliveryCost: null,
      });
      return marked
        ? { kind: 'adopted', ttnRef: recovered.id, ttnNumber: recovered.number, deliveryCost: null }
        : { kind: 'conflict' };
    }
    return { kind: 'unknown_state' };
  }

  // 5. Atomic ownership mark.
  const marked = await deps.markCreated({
    ttnRef: created.id,
    ttnNumber: created.number,
    deliveryCost: created.cost,
  });
  if (marked) {
    return {
      kind: 'created',
      ttnRef: created.id,
      ttnNumber: created.number,
      deliveryCost: created.cost,
    };
  }
  // Lost the race: remove the duplicate document we just created.
  try {
    await deps.np.deleteByRef(created.id);
  } catch {
    // Best-effort only; the adopted row's TTN stays authoritative.
  }
  return { kind: 'conflict' };
}

export interface TtnRollbackDeps {
  np: TtnNpAdapter;
  ttnRef: string;
  /** Atomic created→planned reset; false = lost the race / already reset. */
  resetRow(ttnRef: string): Promise<boolean>;
}

export type TtnRollbackOutcome =
  | { kind: 'rolled_back' }
  | { kind: 'provider_failed' }
  | { kind: 'reset_failed' };

/**
 * Admin rollback: delete the provider document by ref, then reset the row.
 * The DB reset happens only after a confirmed (or already-done) deletion —
 * a failed provider call must never leave a live TTN with a 'planned' row.
 */
export async function rollbackShipmentTtn(
  deps: TtnRollbackDeps
): Promise<TtnRollbackOutcome> {
  try {
    await deps.np.deleteByRef(deps.ttnRef);
  } catch {
    return { kind: 'provider_failed' };
  }
  const reset = await deps.resetRow(deps.ttnRef);
  return reset ? { kind: 'rolled_back' } : { kind: 'reset_failed' };
}
