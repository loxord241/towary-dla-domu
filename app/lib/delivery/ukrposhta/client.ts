/**
 * Ukrposhta HTTP client — SERVER-ONLY.
 *
 * Two surfaces (see config.ts for the base URLs and host pinning):
 *
 *   - classifierGet(): OPEN (keyless) Address Classifier GET. Sends
 *     `Accept: application/json` — the ONLY header that makes the service
 *     answer in JSON (live-verified 2026-09-08; without it the answer is
 *     XML). No Authorization header by design: the endpoint was verified
 *     open, and we never attach credentials where none are required.
 *
 *   - ecomPost(): Ecom API POST with a STATIC bearer —
 *     `Authorization: Bearer {bearer}`. Unlike Nova Post there is NO
 *     JWT-issuing handshake to cache: the bearer from the contract is used
 *     as-is on every request (no TTL, no refresh loop). Without a
 *     configured bearer, ecomPost fails with a typed not_configured error
 *     BEFORE any network activity (fail-closed, not a network throw).
 *
 * Provider responses are validated/normalized by the callers — the
 * provider is NOT trusted. Error bodies are sanitized: raw provider text
 * never reaches clients or logs.
 */

import {
  UKRPOSHTA_ACCEPT_JSON,
  UKRPOSHTA_CLASSIFIER_BASE_URL,
  UKRPOSHTA_ECOM_BASE_URL,
  readUkrposhtaBearer,
} from './config.ts';
import { UkrposhtaError } from './errors.ts';

const REQUEST_TIMEOUT_MS = 12_000;

/** Provider error bodies are capped before any text is surfaced. */
const ERROR_BODY_CAP = 500;

export interface UkrposhtaClientDeps {
  /** Ecom bearer; null = ecom not configured (classifier stays usable). */
  bearer: string | null;
  fetchImpl: typeof fetch;
}

export interface UkrposhtaClient {
  /** Keyless GET against the Address Classifier base URL. */
  classifierGet(path: string, params: URLSearchParams): Promise<unknown>;
  /** Bearer POST against the Ecom base URL. */
  ecomPost(path: string, body: unknown): Promise<unknown>;
}

interface ProviderErrorBody {
  message?: unknown;
  error?: unknown;
  errors?: unknown;
  errorMessage?: unknown;
}

function sanitizeProviderDetails(body: unknown): Record<string, string> | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as ProviderErrorBody;
  const source =
    typeof raw.message === 'string'
      ? { message: raw.message }
      : typeof raw.errorMessage === 'string'
        ? { message: raw.errorMessage }
        : typeof raw.errors === 'object' && raw.errors !== null
          ? (raw.errors as Record<string, unknown>)
          : typeof raw.error === 'string'
            ? { error: raw.error }
            : null;
  if (!source) return null;
  const details: Record<string, string> = {};
  for (const [field, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.length > 0) {
      details[field.slice(0, 50)] = value.slice(0, 200);
    }
    if (Object.keys(details).length >= 20) break;
  }
  return Object.keys(details).length > 0 ? details : null;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // XML (missing Accept) and HTML error pages both land here.
    return null;
  }
}

export function createUkrposhtaClient(
  deps: UkrposhtaClientDeps
): UkrposhtaClient {
  const { bearer, fetchImpl } = deps;

  async function classifierGet(
    path: string,
    params: URLSearchParams
  ): Promise<unknown> {
    const url = `${joinUrl(UKRPOSHTA_CLASSIFIER_BASE_URL, path)}?${params.toString()}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: UKRPOSHTA_ACCEPT_JSON },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new UkrposhtaError(
        'unavailable',
        `address classifier ${path} is unreachable`
      );
    }
    const body = await readBody(response);
    if (!response.ok) {
      const details = sanitizeProviderDetails(body);
      if (response.status === 401 || response.status === 403) {
        throw new UkrposhtaError(
          'unauthorized',
          'classifier rejected the request'
        );
      }
      throw new UkrposhtaError(
        'unavailable',
        `classifier request to ${path} failed (http ${response.status})`,
        details ?? undefined
      );
    }
    if (body === null || typeof body !== 'object') {
      // Missing Accept JSON header (our bug) or provider-side change: the
      // payload would be XML — never parsed as reference data.
      throw new UkrposhtaError(
        'unexpected_response',
        `classifier ${path} returned non-JSON payload`
      );
    }
    return body;
  }

  async function ecomPost(path: string, body: unknown): Promise<unknown> {
    // Fail-closed BEFORE any network activity: without the contract bearer
    // there is nothing to send — never a network error, always a typed one.
    if (bearer === null) {
      throw new UkrposhtaError(
        'not_configured',
        'ukrposhta ecom bearer is not configured'
      );
    }
    const url = joinUrl(UKRPOSHTA_ECOM_BASE_URL, path);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: UKRPOSHTA_ACCEPT_JSON,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new UkrposhtaError(
        'unavailable',
        `ecom request to ${path} is unreachable`
      );
    }
    const responseBody = await readBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new UkrposhtaError('unauthorized', 'ecom rejected the bearer');
    }
    if (!response.ok) {
      const details = sanitizeProviderDetails(responseBody);
      if (response.status === 400 || response.status === 422) {
        throw new UkrposhtaError(
          'provider_error',
          'ecom rejected the request parameters',
          details ?? undefined
        );
      }
      throw new UkrposhtaError(
        'unavailable',
        `ecom request to ${path} failed (http ${response.status})`
      );
    }
    if (responseBody === null || typeof responseBody !== 'object') {
      throw new UkrposhtaError(
        'unexpected_response',
        `ecom ${path} returned non-JSON payload`
      );
    }
    return responseBody;
  }

  return { classifierGet, ecomPost };
}

let defaultClient: UkrposhtaClient | null = null;

/**
 * Server-side singleton. The Ecom surface reports not_configured through
 * typed failures when the bearer is absent; the keyless classifier surface
 * works regardless of configuration.
 */
export function getUkrposhtaClient(): UkrposhtaClient {
  if (!defaultClient) {
    defaultClient = createUkrposhtaClient({
      bearer: readUkrposhtaBearer(),
      fetchImpl: fetch,
    });
  }
  return defaultClient;
}

/** Test seam: drop the singleton (pass null) or install a stub client. */
export function setUkrposhtaClientForTests(
  client: UkrposhtaClient | null
): void {
  defaultClient = client;
}

/** Kept for tests: provider error text must be capped, never dumped raw. */
export const UKRPOSHTA_ERROR_BODY_CAP = ERROR_BODY_CAP;
