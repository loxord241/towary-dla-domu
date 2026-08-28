/**
 * Street lookup — SERVER-ONLY (stage 2G).
 *
 * Endpoint: GET /streets (live-verified 2026-08-28, production;
 * docs/novapost-courier-addressparts-research.md):
 *   - the filter parameter is `name`, NOT `textSearch` — a `textSearch`
 *     value is silently ignored by the provider;
 *   - settlementId is an integer id from GET /settlements;
 *   - canonical street names include the type prefix («вул. Хрещатик»);
 *     similar names exist — the UI must match on the exact canonical
 *     name / id, never on a fuzzy best guess;
 *   - `Accept-Language: uk` is REQUIRED for Ukrainian names (same rule as
 *     settlements; without it names come back transliterated).
 * Documented item shape used here: {id, name, settlement: {id, name}}.
 */

import type { NovaPostClient } from './client.ts';
import { NovaPostError } from './errors.ts';

export const STREETS_MIN_LIMIT = 1;
export const STREETS_MAX_LIMIT = 50;
const NAME_MAX_LENGTH = 200;

export interface StreetsQuery {
  settlementId: number;
  name: string;
  limit: number;
  page: number;
}

/** NpStreet — normalized item returned to our routes. */
export interface NpStreet {
  id: number;
  name: string;
  settlementId: number;
  settlementName: string | null;
}

interface RawNpStreet {
  id: number;
  name: string;
  settlement?: { id: number; name?: string } | null;
  [key: string]: unknown;
}

/** Strict parse of client-supplied query params; returns null when invalid. */
export function parseStreetsQuery(
  searchParams: URLSearchParams
): StreetsQuery | null {
  const rawSettlementId = searchParams.get('settlementId');
  if (
    rawSettlementId === null ||
    !/^\d{1,18}$/.test(rawSettlementId) ||
    rawSettlementId === '0'
  ) {
    return null;
  }
  const settlementId = Number(rawSettlementId);
  if (!Number.isSafeInteger(settlementId) || settlementId < 1) {
    return null;
  }

  const name = (searchParams.get('name') ?? '').trim();
  if (name.length < 2 || name.length > 100) return null;

  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (
    !Number.isInteger(limit) ||
    limit < STREETS_MIN_LIMIT ||
    limit > STREETS_MAX_LIMIT
  ) {
    return null;
  }

  const rawPage = searchParams.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 1000) return null;

  return { settlementId, name, limit, page };
}

export function normalizeStreet(raw: unknown): NpStreet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as RawNpStreet;
  if (!Number.isInteger(item.id) || (item.id as number) < 1) return null;
  if (typeof item.name !== 'string' || item.name.trim().length === 0) return null;
  if (item.name.length > NAME_MAX_LENGTH) return null;
  const settlement = item.settlement;
  if (
    typeof settlement !== 'object' ||
    settlement === null ||
    !Number.isInteger(settlement.id) ||
    (settlement.id as number) < 1
  ) {
    return null;
  }
  return {
    id: item.id,
    name: item.name,
    settlementId: settlement.id,
    settlementName:
      typeof settlement.name === 'string' && settlement.name.trim().length > 0
        ? settlement.name.slice(0, NAME_MAX_LENGTH)
        : null,
  };
}

export async function searchStreets(
  client: NovaPostClient,
  query: StreetsQuery
): Promise<NpStreet[]> {
  const params = new URLSearchParams();
  params.append('settlementId', String(query.settlementId));
  params.append('name', query.name);
  params.append('limit', String(query.limit));
  params.append('page', String(query.page));

  const body = await client.getJson('streets', params, {
  // Live-verified 2026-08-28: without this header street names come back
  // transliterated (e.g. "Mazepy" instead of "вул. Мазепи").
  'Accept-Language': 'uk',
});
  if (typeof body !== 'object' || body === null) {
    throw new NovaPostError('unexpected_response', 'streets: bad payload');
  }
  const rawItems = (body as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) {
    throw new NovaPostError('unexpected_response', 'streets: no items');
  }
  const items: NpStreet[] = [];
  for (const raw of rawItems) {
    const normalized = normalizeStreet(raw);
    if (normalized) items.push(normalized);
  }
  return items;
}
