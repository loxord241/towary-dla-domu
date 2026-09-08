/**
 * Post office lookup — SERVER-ONLY, keyless classifier.
 *
 * Official endpoint (open surface, live-verified 2026-09-08):
 *   GET /get_postoffices_by_postindex
 *   Documented params (at least ONE required): pi (office post index),
 *   pc (delivery-zone postcode), poCityId (settlement id), poDistrictId,
 *   poStreetId, poRegionId, pdCityId, pdDistrictId, pdRegionId.
 *   NOTE the plural-by-history name: with poCityId it returns ALL offices
 *   of the settlement (Lviv = 131 entries, ~250KB; Kyiv = 312, ~580KB).
 *
 * Verified response fields used here: ID, PO_SHORT, PO_LONG, POSTINDEX,
 * ADDRESS, PHONE, TYPE_ACRONYM, POLOCK_UA / LOCK_CODE (lock markers).
 *
 * ACTIVE-RECORD FILTER (fail-closed): rows whose POLOCK_UA is not exactly
 * «Активний запис» are dropped at the normalization boundary — the public
 * route can never offer a blocked/closed office as a destination (the
 * classifier data also carries LOCK_CODE 0/65535; POLOCK_UA is the
 * documented human-readable marker and is what we pin).
 *
 * Ukrposhta publishes no rate limits and the response for a big city is
 * large — the OFFICES_MAX cap bounds every normalized answer.
 */

import type { UkrposhtaClient } from './client.ts';
import { UkrposhtaError } from './errors.ts';
import {
  classifierText,
  extractClassifierEntries,
  parseClassifierId,
} from './classifier.ts';
import type { RawUpPostOffice, UpOffice } from './types.ts';

/** Max offices returned to a client (real max observed: Kyiv 312). */
export const OFFICES_MAX = 100;

/**
 * Exact lock marker of live records (official classifier docs §2.1 sample
 * data; verified against real Lviv/Kyiv responses 2026-09-08).
 */
export const POSTOFFICE_ACTIVE_MARKER = 'Активний запис';

const TEXT_MAX_LENGTH = 255;
const POSTINDEX_MAX_LENGTH = 10;

export interface OfficesQuery {
  cityId: number;
}

/** Strict parse of client-supplied query params; returns null when invalid. */
export function parseOfficesQuery(
  searchParams: URLSearchParams
): OfficesQuery | null {
  const rawCityId = searchParams.get('cityId');
  // Strict digits-only: Number() would accept "1e2" / "0x10" / " 5 " as
  // valid integers (same contract as novapost divisions.ts).
  const cityId =
    rawCityId === null || !/^\d{1,18}$/.test(rawCityId)
      ? NaN
      : Number(rawCityId);
  if (rawCityId === null || !Number.isSafeInteger(cityId) || cityId < 1) {
    return null;
  }
  return { cityId };
}

export interface PostIndexQuery {
  postIndex: string;
}

/** Strict parse of a 5-digit post index query; returns null when invalid. */
export function parsePostIndexQuery(
  searchParams: URLSearchParams
): PostIndexQuery | null {
  const postIndex = (searchParams.get('postIndex') ?? '').trim();
  if (!/^\d{5}$/.test(postIndex)) return null;
  return { postIndex };
}

export function isActivePostOffice(raw: RawUpPostOffice): boolean {
  return raw.POLOCK_UA === POSTOFFICE_ACTIVE_MARKER;
}

export function normalizePostOffice(raw: unknown): UpOffice | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as RawUpPostOffice;
  if (!isActivePostOffice(item)) return null;
  const id = parseClassifierId(item.ID);
  if (id === null) return null;
  return {
    id,
    shortName: classifierText(item.PO_SHORT, TEXT_MAX_LENGTH),
    longName: classifierText(item.PO_LONG, TEXT_MAX_LENGTH),
    postIndex: classifierText(item.POSTINDEX, POSTINDEX_MAX_LENGTH),
    address: classifierText(item.ADDRESS, TEXT_MAX_LENGTH),
    phone: classifierText(item.PHONE, 40),
    typeAcronym: classifierText(item.TYPE_ACRONYM, 16),
  };
}

/**
 * Fetches raw entries via a classifier office query, normalizes them
 * (dropping non-active records) and caps the output. Shared by the
 * by-city and by-post-index lookups.
 */
async function fetchOffices(
  client: UkrposhtaClient,
  path: string,
  params: URLSearchParams
): Promise<UpOffice[]> {
  const body = await client.classifierGet(path, params);
  const rawEntries = extractClassifierEntries(body);
  const items: UpOffice[] = [];
  for (const raw of rawEntries) {
    const normalized = normalizePostOffice(raw);
    if (normalized) items.push(normalized);
    if (items.length >= OFFICES_MAX) break;
  }
  return items;
}

/** All ACTIVE post offices of a settlement (by classifier CITY_ID). */
export async function findOfficesByCityId(
  client: UkrposhtaClient,
  query: OfficesQuery
): Promise<UpOffice[]> {
  const params = new URLSearchParams();
  params.append('poCityId', String(query.cityId));
  return fetchOffices(
    client,
    'get_postoffices_by_postindex',
    params
  );
}

/** Post offices whose OWN post index equals `postIndex` (usually 0..n). */
export async function findOfficesByPostIndex(
  client: UkrposhtaClient,
  query: PostIndexQuery
): Promise<UpOffice[]> {
  const params = new URLSearchParams();
  params.append('pi', query.postIndex);
  return fetchOffices(
    client,
    'get_postoffices_by_postindex',
    params
  );
}

/**
 * Guard for route handlers: a city whose office list came back malformed
 * must surface the typed error, never a silent empty list (an empty list
 * is a legitimate "no offices here" answer — this function does not
 * confuse the two; the client distinguishes them).
 */
export function assertOfficesPayload(body: unknown): void {
  if (body === null || typeof body !== 'object') {
    throw new UkrposhtaError('unexpected_response', 'offices: bad payload');
  }
}
