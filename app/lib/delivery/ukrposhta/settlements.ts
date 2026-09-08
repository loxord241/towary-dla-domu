/**
 * Settlement (city) lookup — SERVER-ONLY, keyless classifier.
 *
 * Official endpoint (open surface, live-verified 2026-09-08):
 *   GET /get_city_by_region_id_and_district_id_and_city_ua
 *   Documented params (at least ONE required): district_id, region_id,
 *   city_ua, koatuu, katottg. Search matches PART of the name, so a plain
 *   `city_ua=<typed text>` query powers the checkout autocomplete without
 *   needing region/district pre-selection.
 *
 * Verified response shape: Entries.Entry[] with CITY_ID / CITY_UA /
 * SHORTCITYTYPE_UA / DISTRICT_UA / REGION_UA / NAME_UA (record-status
 * marker, "Активний запис" for live records) / CITY_KATOTTG / CITY_KOATUU.
 * KATOTTG/KOATUU are stable codes stored alongside the host-bound CITY_ID.
 */

import type { UkrposhtaClient } from './client.ts';
import { UkrposhtaError } from './errors.ts';
import {
  CLASSIFIER_MAX_ENTRIES,
  classifierText,
  extractClassifierEntries,
  parseClassifierId,
} from './classifier.ts';
import type { RawUpCity, UpSettlement } from './types.ts';

export const SETTLEMENTS_MIN_LIMIT = 1;
export const SETTLEMENTS_MAX_LIMIT = 50;
const TEXT_MAX_LENGTH = 200;
const CODE_MAX_LENGTH = 32;

export interface SettlementsQuery {
  query: string;
  limit: number;
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

  return { query, limit };
}

export function normalizeSettlement(raw: unknown): UpSettlement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as RawUpCity;
  const id = parseClassifierId(item.CITY_ID);
  if (id === null) return null;
  const name = classifierText(item.CITY_UA, TEXT_MAX_LENGTH);
  if (name === null) return null;
  return {
    id,
    name,
    shortType: classifierText(item.SHORTCITYTYPE_UA, 16),
    districtName: classifierText(item.DISTRICT_UA, TEXT_MAX_LENGTH),
    regionName: classifierText(item.REGION_UA, TEXT_MAX_LENGTH),
    katottg: classifierText(item.CITY_KATOTTG, CODE_MAX_LENGTH),
    koatuu: classifierText(item.CITY_KOATUU, CODE_MAX_LENGTH),
  };
}

/**
 * Searches settlements by part of the Ukrainian name. The classifier has
 * no pagination — the full match list arrives in one response; it is
 * bounded by CLASSIFIER_MAX_ENTRIES (raw) and the caller-supplied limit
 * (normalized output).
 */
export async function searchSettlements(
  client: UkrposhtaClient,
  query: SettlementsQuery
): Promise<UpSettlement[]> {
  const params = new URLSearchParams();
  // city_ua alone is a documented query key ("хоча б один з параметрів").
  params.append('city_ua', query.query);

  const body = await client.classifierGet(
    'get_city_by_region_id_and_district_id_and_city_ua',
    params
  );
  const rawEntries = extractClassifierEntries(body);
  const items: UpSettlement[] = [];
  for (const raw of rawEntries) {
    const normalized = normalizeSettlement(raw);
    if (normalized) items.push(normalized);
    if (items.length >= query.limit) break;
  }
  // Defensive: the raw cap is CLASSIFIER_MAX_ENTRIES (never reached in
  // practice); pin the relationship so a future cap change stays sane.
  if (rawEntries.length > CLASSIFIER_MAX_ENTRIES) {
    throw new UkrposhtaError(
      'unexpected_response',
      'settlements: raw entries exceed cap'
    );
  }
  return items;
}
