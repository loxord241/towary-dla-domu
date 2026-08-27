/**
 * Nova Post shipment document operations (stage 2F) — SERVER-ONLY.
 *
 * Implements the three provider calls needed to create a TTN for a
 * warehouse shipment, verified live in the Nova Post sandbox
 * (api-stage.novapost.com, 2026-08-27):
 *
 *   POST   /shipments            → create (201) — domestic UA needs NO
 *                                   invoice, NO status, NO note; parcels
 *                                   require cargoCategory + parcelDescription;
 *                                   sender/recipient use `divisionId`
 *                                   (camelCase — the docs table's
 *                                   `divisionID` spelling is wrong and 422s);
 *   GET    /shipments?clientOrder=…  → reconciliation lookup (works although
 *                                   undocumented; documented fallback is the
 *                                   same list endpoint with pagination);
 *   DELETE /shipments/{ref}      → admin rollback by Ref ID only (UA does
 *                                   NOT support deletion by number);
 *                                   repeated deletion → 422
 *                                   `shipment_was_deleted` (idempotent).
 *
 * Every response is parsed through a strict whitelist — the provider is NOT
 * trusted. Field names and units (grams / mm / UAH declared value) mirror
 * the research payload in docs from the sandbox run.
 */

import type { NovaPostClient } from './client.ts';
import { NovaPostError } from './errors.ts';

const CLIENT_ORDER_MAX_LENGTH = 50;
const LIST_PAGE_LIMIT = 15;

/** Normalized POST /shipments 201 body (strict whitelist). */
export interface NpShipmentCreated {
  /** Provider Ref ID (UUID) — the ONLY delete/edit key for UA shipments. */
  id: string;
  /** Transportation document number (customer-visible tracking). */
  number: string;
  status: string;
  cost: number;
  parcelsAmount: number;
  scheduledDeliveryDate: string | null;
  deletedAt: string | null;
}

/** Normalized GET /shipments list item (reconciliation lookup). */
export interface NpShipmentSummary {
  id: string;
  number: string;
  clientOrder: string | null;
  status: string;
  deletedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** string | null | undefined (undefined = type violation). */
function optString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function requireString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function requireFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requirePositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

/** Strict parse of the POST /shipments 201 body; null when malformed. */
export function parseShipmentCreated(raw: unknown): NpShipmentCreated | null {
  if (!isRecord(raw)) return null;
  const id = requireString(raw.id);
  const number = requireString(raw.number);
  const status = requireString(raw.status);
  const cost = requireFinite(raw.cost);
  const parcelsAmount = requirePositiveInt(raw.parcelsAmount);
  if (
    id === null ||
    number === null ||
    status === null ||
    cost === null ||
    parcelsAmount === null
  ) {
    return null;
  }
  const scheduledDeliveryDate = optString(raw.scheduledDeliveryDate);
  const deletedAt = optString(raw.deletedAt);
  if (
    scheduledDeliveryDate === undefined ||
    deletedAt === undefined
  ) {
    return null;
  }
  return {
    id,
    number,
    status,
    cost,
    parcelsAmount,
    scheduledDeliveryDate,
    deletedAt,
  };
}

/** Strict parse of one GET /shipments item; null when malformed. */
export function parseShipmentSummary(raw: unknown): NpShipmentSummary | null {
  if (!isRecord(raw)) return null;
  const id = requireString(raw.id);
  const number = requireString(raw.number);
  const status = requireString(raw.status);
  if (id === null || number === null || status === null) return null;
  const clientOrder = optString(raw.clientOrder);
  const deletedAt = optString(raw.deletedAt);
  if (clientOrder === undefined || deletedAt === undefined) return null;
  return { id, number, clientOrder, status, deletedAt };
}

/**
 * Creates a shipment document. Resolves to the normalized 201 body or
 * throws NovaPostError (provider_error for 422 validation rejections,
 * unavailable for network/5xx, unexpected_response for malformed success
 * payloads). The unknown-outcome rule lives in the caller: a thrown
 * unavailable error after POST must NOT trigger a blind re-POST — the
 * caller reconciles via clientOrder first.
 */
export async function createShipment(
  client: NovaPostClient,
  payload: unknown
): Promise<NpShipmentCreated> {
  const body = await client.postJson('shipments', payload);
  const parsed = parseShipmentCreated(body);
  if (!parsed) {
    throw new NovaPostError(
      'unexpected_response',
      'shipment creation response is malformed'
    );
  }
  return parsed;
}

/**
 * Reconciliation lookup by our own clientOrder. The `clientOrder` query
 * parameter is undocumented but verified live (filters correctly); the
 * documented fallback is the same list endpoint with pagination.
 */
export async function findShipmentsByClientOrder(
  client: NovaPostClient,
  clientOrder: string
): Promise<NpShipmentSummary[]> {
  const trimmed = clientOrder.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > CLIENT_ORDER_MAX_LENGTH
  ) {
    throw new NovaPostError(
      'invalid_input',
      'clientOrder is blank or exceeds the provider limit'
    );
  }
  const params = new URLSearchParams();
  params.append('clientOrder', trimmed);
  params.append('limit', String(LIST_PAGE_LIMIT));
  const body = await client.getJson('shipments', params);
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new NovaPostError(
      'unexpected_response',
      'shipment lookup response has no items'
    );
  }
  const items: NpShipmentSummary[] = [];
  for (const raw of body.items) {
    const parsed = parseShipmentSummary(raw);
    if (parsed) items.push(parsed);
  }
  return items;
}

export type DeleteShipmentResult = 'deleted' | 'already_deleted';

/**
 * Deletes a shipment document by Ref ID (UA supports ONLY Ref-ID deletion).
 * A repeated deletion returns the provider's idempotent
 * `shipment_was_deleted` validation signal, mapped to 'already_deleted'.
 */
export async function deleteShipmentByRef(
  client: NovaPostClient,
  ref: string
): Promise<DeleteShipmentResult> {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    throw new NovaPostError('invalid_input', 'shipment ref is blank');
  }
  try {
    await client.deleteJson(`shipments/${encodeURIComponent(trimmed)}`);
    return 'deleted';
  } catch (error) {
    if (
      isNovaPostError(error) &&
      error.kind === 'provider_error' &&
      error.providerDetails?.['errorMessage'] === 'shipment_was_deleted'
    ) {
      return 'already_deleted';
    }
    throw error;
  }
}

function isNovaPostError(value: unknown): value is NovaPostError {
  return value instanceof NovaPostError;
}
