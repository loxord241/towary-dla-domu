/**
 * Branch / parcel-locker lookup — SERVER-ONLY.
 *
 * Official endpoint: GET /divisions
 * Documented query params: countryCodes[] (ISO 3166-1 alpha-2, docs enum
 * uses uppercase, e.g. "UA"), settlementIds[] (integer ids), limit
 * (default 15), page, divisionCategories[], statuses[] ("By default, only
 * divisions with the Working status are returned" — omitted here to keep
 * that documented default).
 * Documented item fields used here: id, name, shortName, address, number,
 * divisionCategory, maxWeightPlaceSender / maxWeightPlaceRecipient (grams).
 */

import type { NovaPostClient } from './client.ts';
import { NovaPostError } from './errors.ts';
import type { NpDivision, RawNpDivision } from './types.ts';

const COUNTRY_CODE_UKRAINE = 'UA'; // docs enum value (uppercase)
export const DIVISIONS_MIN_LIMIT = 1;
export const DIVISIONS_MAX_LIMIT = 100;
const TEXT_MAX_LENGTH = 255;

export interface DivisionsQuery {
  settlementId: number;
  limit: number;
  page: number;
}

/** Strict parse of client-supplied query params; returns null when invalid. */
export function parseDivisionsQuery(
  searchParams: URLSearchParams
): DivisionsQuery | null {
  const rawSettlementId = searchParams.get('settlementId');
  const settlementId = Number(rawSettlementId);
  if (
    rawSettlementId === null ||
    !Number.isInteger(settlementId) ||
    settlementId < 1
  ) {
    return null;
  }

  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (
    !Number.isInteger(limit) ||
    limit < DIVISIONS_MIN_LIMIT ||
    limit > DIVISIONS_MAX_LIMIT
  ) {
    return null;
  }

  const rawPage = searchParams.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 1000) return null;

  return { settlementId, limit, page };
}

export function normalizeDivision(raw: unknown): NpDivision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as RawNpDivision;
  if (!Number.isInteger(item.id) || (item.id as number) < 1) return null;
  if (typeof item.name !== 'string' || item.name.trim().length === 0) {
    return null;
  }

  const optText = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0
      ? value.slice(0, TEXT_MAX_LENGTH)
      : null;
  const optGrams = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;

  return {
    id: item.id,
    name: item.name.slice(0, TEXT_MAX_LENGTH),
    shortName: optText(item.shortName),
    address: optText(item.address),
    number: optText(item.number),
    category: optText(item.divisionCategory),
    maxWeightPlaceSenderGrams: optGrams(item.maxWeightPlaceSender),
    maxWeightPlaceRecipientGrams: optGrams(item.maxWeightPlaceRecipient),
  };
}

export async function findDivisions(
  client: NovaPostClient,
  query: DivisionsQuery
): Promise<NpDivision[]> {
  const params = new URLSearchParams();
  params.append('countryCodes[]', COUNTRY_CODE_UKRAINE);
  params.append('settlementIds[]', String(query.settlementId));
  params.append('limit', String(query.limit));
  params.append('page', String(query.page));

  const body = await client.getJson('divisions', params);
  if (typeof body !== 'object' || body === null) {
    throw new NovaPostError('unexpected_response', 'divisions: bad payload');
  }
  const rawItems = (body as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) {
    throw new NovaPostError('unexpected_response', 'divisions: no items');
  }
  const items: NpDivision[] = [];
  for (const raw of rawItems) {
    const normalized = normalizeDivision(raw);
    if (normalized) items.push(normalized);
  }
  return items;
}
