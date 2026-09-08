/**
 * Ukrposhta integration config — SERVER-ONLY.
 *
 * IMPORTANT: this module is imported ONLY by route handlers and server-side
 * lib code (same guard pattern as app/lib/delivery/novapost/config.ts).
 * None of its exports may reach the client bundle.
 *
 * Two independent provider surfaces with two different base URLs:
 *   1. Address Classifier — OPEN (keyless) at
 *      https://www.ukrposhta.ua/address-classifier/0.0.1/
 *      Live-verified keyless 2026-09-08 (get_regions_by_region_ua,
 *      get_city_by_region_id_and_district_id_and_city_ua,
 *      get_postoffices_by_postindex). JSON is returned ONLY with the
 *      request header `Accept: application/json` — without it the service
 *      answers in XML. The newer official docs describe an authorized
 *      `address-classifier-ws` variant; if the open 0.0.1 surface is
 *      ever switched off, settlements/offices degrade to typed failures
 *      (the checkout keeps working for Nova Post).
 *   2. Ecom API (delivery price calculation, later TTN creation) —
 *      https://www.ukrposhta.ua/ecom/0.0.1/ — Bearer-authorized.
 *      Ukrposhta issues the bearer ONLY after a signed contract (no
 *      self-registration, no public sandbox).
 *
 * ID HOST PINNING: classifier ids are host-bound (www vs dev.ukrposhta.ua
 * yield DIFFERENT id spaces). This codebase pins the production host
 * www.ukrposhta.ua as a constant — never an env switch — so every stored
 * id was received from, and stays valid against, the same host. Stable
 * KATOTTG/KOATUU codes travel in the classifier data and are the fallback
 * cross-reference.
 *
 * Secrets are read exclusively from server-side environment variables
 * (UKRPOSHTA_BEARER / UKRPOSHTA_USER_TOKEN). They are NEVER exposed via
 * NEXT_PUBLIC_*, never logged, never returned in API responses and never
 * included in error messages. Both readers fail closed: anything but a
 * non-empty string reads as null ("not configured").
 */

/** Ecom API (Bearer): delivery price calculation, shipments. */
export const UKRPOSHTA_ECOM_BASE_URL = 'https://www.ukrposhta.ua/ecom/0.0.1/';

/** Address Classifier (OPEN, keyless; production www host — see above). */
export const UKRPOSHTA_CLASSIFIER_BASE_URL =
  'https://www.ukrposhta.ua/address-classifier/0.0.1/';

/**
 * The classifier answers in XML unless the request carries this exact
 * header (live-verified 2026-09-08). Exported so the client and tests pin
 * the same constant.
 */
export const UKRPOSHTA_ACCEPT_JSON = 'application/json';

export const UKRPOSHTA_BEARER_ENV = 'UKRPOSHTA_BEARER';

/** Returns the server-side Ukrposhta Ecom bearer, or null when not configured. */
export function readUkrposhtaBearer(): string | null {
  const key = process.env[UKRPOSHTA_BEARER_ENV];
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const UKRPOSHTA_USER_TOKEN_ENV = 'UKRPOSHTA_USER_TOKEN';

/**
 * Returns the Ukrposhta user bearer (bearerUuid from the signed contract
 * annex; used by some authorized surfaces), or null when not configured.
 */
export function readUkrposhtaUserToken(): string | null {
  const key = process.env[UKRPOSHTA_USER_TOKEN_ENV];
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Post index of the post office the shop ships FROM (Ecom price
 * calculation needs addressFrom.postcode). Server-side env, fail-closed:
 * without it delivery-cost answers a typed not_configured failure.
 */
export const UKRPOSHTA_SENDER_POSTINDEX_ENV = 'UKRPOSHTA_SENDER_POSTINDEX';

const POSTINDEX_RE = /^\d{5}$/;

/** Returns the configured sender post index, or null when not configured. */
export function readUkrposhtaSenderPostIndex(): string | null {
  const raw = process.env[UKRPOSHTA_SENDER_POSTINDEX_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return POSTINDEX_RE.test(trimmed) ? trimmed : null;
}
