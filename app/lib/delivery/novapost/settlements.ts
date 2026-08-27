/**
 * City (settlement) lookup — SERVER-ONLY.
 *
 * Official endpoint: GET /settlements
 * Documented query params: countryCodes[] (ISO 3166-1 alpha-2), limit
 * (default 15), page, textSearch. LIVE VERIFICATION (stage 2B): the
 * provider rejects the documented lowercase enum value ("uk") with 422
 * `validation.country_code` and requires UPPERCASE "UA"; Ukrainian names
 * are returned only with the `Accept-Language: uk` header (undocumented
 * for this method — without it names come back in English). Both
 * live-confirmed values are used here.
 * Documented item fields used here: id (integer >= 1), name, region.name,
 * region.parent.name. Everything else is ignored by design.
 */

import type { NovaPostClient } from './client.ts';
import { NovaPostError } from './errors.ts';
import type { NpSettlement, RawNpSettlement } from './types.ts';

const COUNTRY_CODE_UKRAINE = 'UA'; // live-confirmed: lowercase "uk" -> 422
const ACCEPT_LANGUAGE_UKRAINE = 'uk'; // live-confirmed: names in Ukrainian
export const SETTLEMENTS_MIN_LIMIT = 1;
export const SETTLEMENTS_MAX_LIMIT = 50;
const NAME_MAX_LENGTH = 200;

export interface SettlementsQuery {
  query: string;
  limit: number;
  page: number;
}

/** Strict parse of client-supplied query params; returns null when invalid. */
export function parseSettlementsQuery(
  searchParams: URLSearchParams
): SettlementsQuery | null {
  const query = (searchParams.get('q') ?? '').trim();
  if (query.length < 2 || query.length > 100) return null;

  const rawLimit = searchParams.get('limit');
  const limit = rawLimit === null ? 10 : Number(rawLimit);
  if (
    !Number.isInteger(limit) ||
    limit < SETTLEMENTS_MIN_LIMIT ||
    limit > SETTLEMENTS_MAX_LIMIT
  ) {
    return null;
  }

  const rawPage = searchParams.get('page');
  const page = rawPage === null ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1 || page > 1000) return null;

  return { query, limit, page };
}

export function normalizeSettlement(raw: unknown): NpSettlement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as RawNpSettlement;
  if (!Number.isInteger(item.id) || (item.id as number) < 1) return null;
  if (typeof item.name !== 'string' || item.name.trim().length === 0) {
    return null;
  }
  if (item.name.length > NAME_MAX_LENGTH) return null;
  const regionName =
    typeof item.region?.name === 'string' && item.region.name.trim().length > 0
      ? item.region.name.slice(0, NAME_MAX_LENGTH)
      : null;
  const regionParentName =
    typeof item.region?.parent?.name === 'string' &&
    item.region.parent.name.trim().length > 0
      ? item.region.parent.name.slice(0, NAME_MAX_LENGTH)
      : null;
  return {
    id: item.id,
    name: item.name,
    regionName,
    regionParentName,
  };
}

export async function searchSettlements(
  client: NovaPostClient,
  query: SettlementsQuery
): Promise<NpSettlement[]> {
  const params = new URLSearchParams();
  params.append('countryCodes[]', COUNTRY_CODE_UKRAINE);
  params.append('textSearch', query.query);
  params.append('limit', String(query.limit));
  params.append('page', String(query.page));

  const body = await client.getJson('settlements', params, {
    'Accept-Language': ACCEPT_LANGUAGE_UKRAINE,
  });
  if (typeof body !== 'object' || body === null) {
    throw new NovaPostError('unexpected_response', 'settlements: bad payload');
  }
  const rawItems = (body as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) {
    throw new NovaPostError('unexpected_response', 'settlements: no items');
  }
  const items: NpSettlement[] = [];
  for (const raw of rawItems) {
    const normalized = normalizeSettlement(raw);
    if (normalized) items.push(normalized);
  }
  return items;
}
