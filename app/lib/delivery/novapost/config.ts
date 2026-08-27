/**
 * Nova Post integration config — SERVER-ONLY.
 *
 * IMPORTANT: this module is imported ONLY by route handlers and server-side
 * lib code (same guard pattern as app/lib/payment/liqpay-config.ts). None of
 * its exports may reach the client bundle.
 *
 * Official documentation (api-portal.novapost.com, Nova Post Integration
 * Platform API v.1.0):
 *   - production server: https://api.novapost.com/v.1.0/
 *   - sandbox server:    https://api-stage.novapost.com/v.1.0/
 *   - auth: GET /clients/authorization?apiKey={apiKey} -> {jwt} (TTL ~1h)
 *
 * The apiKey is read exclusively from the server-side environment variable
 * NOVA_POST_API_KEY. It is NEVER exposed via NEXT_PUBLIC_*, never logged,
 * never returned in API responses and never included in error messages.
 */

export const NOVA_POST_API_BASE_URL = 'https://api.novapost.com/v.1.0/';

export const NOVA_POST_API_KEY_ENV = 'NOVA_POST_API_KEY';

/** Returns the server-side Nova Post apiKey, or null when not configured. */
export function readNovaPostApiKey(): string | null {
  const key = process.env[NOVA_POST_API_KEY_ENV];
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Division the shop ships FROM. The live calculations endpoint (verified
 * 2026-08-27) rejects requests whose sender has no division/address
 * location, so cost calculation is fail-closed without it. Server-side
 * only; the real value is provided by the owner via the environment.
 */
export const NOVA_POST_SENDER_DIVISION_ID_ENV = 'NOVA_POST_SENDER_DIVISION_ID';

/** Returns the configured sender division id, or null when not configured. */
export function readNovaPostSenderDivisionId(): number | null {
  const raw = process.env[NOVA_POST_SENDER_DIVISION_ID_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Sender contact person / shop name for TTN creation (stage 2F).
 * Server-side only, fail-closed: blank or over the provider's 100-char
 * limit means TTN creation is not configured.
 */
export const NOVA_POST_SENDER_NAME_ENV = 'NOVA_POST_SENDER_NAME';

const SENDER_NAME_MAX_LENGTH = 100;

/** Returns the configured sender name, or null when not configured. */
export function readNovaPostSenderName(): string | null {
  const raw = process.env[NOVA_POST_SENDER_NAME_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SENDER_NAME_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * Sender phone for TTN creation, E.164 digits (e.g. 380671234567).
 * Server-side only, fail-closed: blank/absent means not configured.
 * Digits-only normalization happens in the payload builder; the reader
 * only trims.
 */
export const NOVA_POST_SENDER_PHONE_ENV = 'NOVA_POST_SENDER_PHONE';

const SENDER_PHONE_MAX_LENGTH = 20;

/** Returns the configured sender phone, or null when not configured. */
export function readNovaPostSenderPhone(): string | null {
  const raw = process.env[NOVA_POST_SENDER_PHONE_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SENDER_PHONE_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}
