/**
 * Address Classifier low-level helpers — SERVER-ONLY, keyless.
 *
 * Shared response contract (live-verified 2026-09-08 against
 * https://www.ukrposhta.ua/address-classifier/0.0.1/):
 *   { "Entries": { "Entry": [ … ] } }
 *   - zero matches come back as {"Entries":{}} — Entry absent, NOT an
 *     empty array;
 *   - single-match payloads MAY collapse Entry to a bare object (WSO2
 *     dataservice convention) — handled defensively;
 *   - every numeric id arrives as a JSON string; strict integer-string
 *     parsing only (Number() would accept "1e2"/"0x10"/" 5 ").
 *
 * Ukrposhta publishes NO rate limits for the classifier — this module is
 * the single funnel through which all classifier reads flow, so the
 * response-size guard and entry cap apply to every caller (per-city
 * office lists measured at ~250KB for Lviv and ~580KB for Kyiv).
 */

import { UkrposhtaError } from './errors.ts';

/**
 * Hard ceiling on classifier JSON size we are willing to process. Largest
 * observed legitimate payload (all Kyiv offices, poCityId=29713) is ~0.6MB;
 * anything beyond this cap is treated as an unexpected (broken/hostile)
 * response rather than parsed.
 */
export const CLASSIFIER_MAX_BODY_BYTES = 2_000_000;

/**
 * Hard ceiling on raw entries processed per response. Cities never match
 * this for real queries (7 entries for «Львів», 26 regions); the cap
 * bounds CPU on pathological matches before normalization even starts.
 */
export const CLASSIFIER_MAX_ENTRIES = 1000;

/**
 * Extracts the Entry array from a classifier payload. Returns an empty
 * array for the legitimate "no matches" shape and THROWS unexpected_response
 * for any shape that is not the documented Entries wrapper.
 */
export function extractClassifierEntries(body: unknown): Record<string, unknown>[] {
  if (typeof body !== 'object' || body === null) {
    throw new UkrposhtaError('unexpected_response', 'classifier: bad payload');
  }
  const entries = (body as { Entries?: unknown }).Entries;
  if (typeof entries !== 'object' || entries === null) {
    // {"Entries":{}} (no matches) and broken payloads are
    // indistinguishable at this level only if Entry is also absent —
    // the documented no-match shape is Entries:{} WITHOUT Entry.
    if (
      entries === null ||
      (typeof entries === 'object' &&
        !('Entry' in (entries as Record<string, unknown>)))
    ) {
      return [];
    }
    throw new UkrposhtaError('unexpected_response', 'classifier: no Entries');
  }
  const entry = (entries as { Entry?: unknown }).Entry;
  if (entry === undefined || entry === null) return [];
  if (typeof entry !== 'object' && !Array.isArray(entry)) {
    // A scalar Entry is not a documented shape — never parse it as data.
    throw new UkrposhtaError('unexpected_response', 'classifier: bad Entry');
  }
  const list = Array.isArray(entry) ? entry : [entry];
  if (list.length > CLASSIFIER_MAX_ENTRIES) {
    throw new UkrposhtaError(
      'unexpected_response',
      'classifier: entry count exceeds the safety cap'
    );
  }
  const out: Record<string, unknown>[] = [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Strict integer-string/number parse for classifier ids ("262" → 262).
 * Accepts a JSON string of 1..18 digits or a safe integer number; anything
 * else (floats, "1e2", " 5 ", negative, 0) is rejected.
 */
export function parseClassifierId(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  return null;
}

/** Trimmed display string capped at max; null when absent/empty. */
export function classifierText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}
