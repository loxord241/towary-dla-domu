/**
 * Nova Post HTTP client — SERVER-ONLY.
 *
 * Implements the authentication flow from the official documentation
 * (api-portal.novapost.com, API v.1.0):
 *   1. GET /clients/authorization?apiKey={apiKey} -> {jwt}, TTL ~1 hour.
 *   2. Provider calls carry `Authorization: {jwt}` (raw token, as shown in
 *      the official docs' Authorize dialog: `Authorization: {jwt}`).
 * The JWT is cached in-process (55 min — refreshed before the documented
 * ~1h expiry) with single-flight, and re-issued once after a 401.
 *
 * The apiKey exists only inside this module's closure and the outbound
 * authorization request. It never appears in thrown errors, logs or
 * responses. All responses are validated/normalized before use — the
 * provider is NOT trusted.
 */

import {
  NOVA_POST_API_BASE_URL,
  readNovaPostApiKey,
} from './config.ts';
import { NovaPostError } from './errors.ts';

/** Docs: jwt is "valid for ~1 hour; request a new one after expiry". */
const JWT_TTL_MS = 55 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_REDIR_AUTH_RETRIES = 1;

export interface NovaPostClientDeps {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  now: () => number;
}

export interface NovaPostClient {
  /** `Authorization` header value for the current valid JWT. */
  authorizationHeader(): Promise<string>;
  /** GET (query assembled from params) against the documented base URL. */
  getJson(
    path: string,
    params: URLSearchParams,
    extraHeaders?: Record<string, string>
  ): Promise<unknown>;
  /** POST with a JSON body against the documented base URL. */
  postJson(path: string, body: unknown): Promise<unknown>;
  /** DELETE (no request body) against the documented base URL. */
  deleteJson(path: string): Promise<unknown>;
}

interface ProviderErrorBody {
  errors?: unknown;
  error?: unknown;
  ErrorMessage?: unknown;
}

function sanitizeProviderDetails(body: unknown): Record<string, string> | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as ProviderErrorBody).errors;
  if (typeof raw !== 'object' || raw === null) return null;
  const details: Record<string, string> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) {
      details[field.slice(0, 50)] = value.slice(0, 200);
    }
    if (details && Object.keys(details).length >= 20) break;
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
    return null;
  }
}

export function createNovaPostClient(
  deps: NovaPostClientDeps
): NovaPostClient {
  const { apiKey, baseUrl, fetchImpl, now } = deps;

  let cachedJwt: string | null = null;
  let jwtExpiresAt = 0;
  let inflightAuth: Promise<string> | null = null;

  async function authorize(): Promise<string> {
    const url = `${joinUrl(baseUrl, 'clients/authorization')}?apiKey=${encodeURIComponent(apiKey)}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new NovaPostError(
        'unavailable',
        'provider authorization is unreachable'
      );
    }
    if (response.status === 401) {
      throw new NovaPostError('unauthorized', 'provider rejected credentials');
    }
    const body = await readBody(response);
    if (!response.ok) {
      throw new NovaPostError(
        'unavailable',
        `provider authorization failed (http ${response.status})`
      );
    }
    const jwt =
      typeof body === 'object' && body !== null
        ? (body as { jwt?: unknown }).jwt
        : undefined;
    if (typeof jwt !== 'string' || jwt.length === 0) {
      throw new NovaPostError(
        'unexpected_response',
        'authorization response has no jwt'
      );
    }
    cachedJwt = jwt;
    jwtExpiresAt = now() + JWT_TTL_MS;
    return jwt;
  }

  async function authorizationHeader(): Promise<string> {
    if (cachedJwt && now() < jwtExpiresAt) return cachedJwt;
    if (!inflightAuth) {
      inflightAuth = authorize().finally(() => {
        inflightAuth = null;
      });
    }
    return inflightAuth;
  }

  function invalidateJwt(): void {
    cachedJwt = null;
    jwtExpiresAt = 0;
  }

  async function   request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: URLSearchParams | null,
    jsonBody: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      const jwt = await authorizationHeader();
      const url =
        method === 'GET' && params
          ? `${joinUrl(baseUrl, path)}?${params.toString()}`
          : joinUrl(baseUrl, path);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Authorization: jwt,
            ...extraHeaders,
            ...(method === 'POST'
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(method === 'POST' ? { body: JSON.stringify(jsonBody) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new NovaPostError(
          'unavailable',
          `provider request to ${path} is unreachable`
        );
      }

      if (response.status === 401 && attempt < MAX_REDIR_AUTH_RETRIES) {
        // Docs: jwt TTL ~1h — a 401 means the cached token expired or was
        // revoked: drop it, authorize once more and retry the request.
        invalidateJwt();
        attempt += 1;
        continue;
      }

      const body = await readBody(response);
      if (response.ok) return body;

      const details = sanitizeProviderDetails(body);
      if (response.status === 401) {
        throw new NovaPostError('unauthorized', 'provider rejected the token');
      }
      if (response.status === 422) {
        throw new NovaPostError(
          'provider_error',
          'provider rejected the request parameters',
          details ?? undefined
        );
      }
      throw new NovaPostError(
        'unavailable',
        `provider request to ${path} failed (http ${response.status})`
      );
    }
  }

    return {
      authorizationHeader,
      getJson: (path, params, extraHeaders) =>
        request('GET', path, params, null, extraHeaders),
      postJson: (path, body) => request('POST', path, null, body),
      deleteJson: (path) => request('DELETE', path, null, null),
    };
}

let defaultClient: NovaPostClient | null = null;

/** Server-side singleton; throws not_configured when the key is missing. */
export function getNovaPostClient(): NovaPostClient {
  if (!defaultClient) {
    const apiKey = readNovaPostApiKey();
    if (!apiKey) {
      throw new NovaPostError(
        'not_configured',
        'nova post api key is not configured'
      );
    }
    defaultClient = createNovaPostClient({
      apiKey,
      baseUrl: NOVA_POST_API_BASE_URL,
      fetchImpl: fetch,
      now: () => Date.now(),
    });
  }
  return defaultClient;
}

/** Test seam: drop the singleton (pass null) or install a stub client. */
export function setNovaPostClientForTests(
  client: NovaPostClient | null
): void {
  defaultClient = client;
}
