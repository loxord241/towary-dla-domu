// Explicit .ts extension: required by node:test ESM resolution and allowed
// by allowImportingTsExtensions for the Next bundler.
import { signHs256Jwt } from './jwt.ts';

/**
 * Server-only Yugcontract B2B API client (auth + get-price).
 *
 * Security invariants:
 *  - YUGCONTRACT_USER_KEY / YUGCONTRACT_SECRET are read from env at call
 *    time and NEVER logged, returned, cached on disk or embedded into
 *    error messages.
 *  - requestToken / authToken live only in this module's memory; the
 *    authToken is kept in a process-local cache which is safe for the
 *    current single-instance deployment (same assumption as rate-limit).
 *  - Errors carry only kind/status and generic Ukrainian messages, so no
 *    credential can leak through API responses or logs.
 *
 * Transport rules:
 *  - authToken is requested once and reused (~1h lifetime per docs,
 *    refreshed 5 minutes before expiry);
 *  - on 401 the token cache is invalidated and the original request is
 *    retried EXACTLY ONCE (no retry loops);
 *  - 429/5xx/network failures raise typed errors — callers must not
 *    build partial imports from failed runs.
 */

// Base URLs may be overridden server-side (internal testing hook for
// local integration runs); production defaults are the official endpoints.
function authUrl(): string {
  return (
    process.env.YUGCONTRACT_AUTH_URL ??
    'https://auth.yugcontract.ua/api/auth/get-auth-token'
  );
}

function priceUrl(): string {
  return (
    process.env.YUGCONTRACT_PRICE_URL ??
    'https://b2b.yugcontract.ua/api/catalog/get-price'
  );
}

const REQUEST_TOKEN_TTL_SEC = 3 * 60;
const AUTH_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTH_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type YugcontractErrorKind =
  | 'config'
  | 'auth'
  | 'rate_limited'
  | 'upstream'
  | 'malformed';

export class YugcontractError extends Error {
  readonly kind: YugcontractErrorKind;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    kind: YugcontractErrorKind,
    httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'YugcontractError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

type FetchLike = typeof fetch;

interface CachedAuthToken {
  token: string;
  expiresAtMs: number;
}

let cachedAuthToken: CachedAuthToken | null = null;

/** Test hook: clears the process-local authToken cache. */
export function resetAuthTokenCacheForTests(): void {
  cachedAuthToken = null;
}

function readCredentials(): { userKey: string; secret: string } {
  const userKey = process.env.YUGCONTRACT_USER_KEY?.trim() ?? '';
  const secret = process.env.YUGCONTRACT_SECRET?.trim() ?? '';
  if (!userKey || !secret) {
    throw new YugcontractError(
      'Yugcontract не налаштований: відсутні серверні змінні середовища',
      'config'
    );
  }
  return { userKey, secret };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new YugcontractError(
      'Некоректна відповідь сервера Yugcontract (не JSON)',
      'malformed',
      response.status
    );
  }
}

/**
 * Same validation as parseJsonResponse, but reads the body once through
 * a buffer so callers can also measure the actual payload size
 * (decompressed byte count) without a second fetch.
 */
async function parseJsonResponseWithSize(
  response: Response
): Promise<{ parsed: unknown; byteLength: number }> {
  let text: string;
  try {
    const buf = await response.arrayBuffer();
    text = new TextDecoder().decode(buf);
  } catch {
    throw new YugcontractError(
      'Некоректна відповідь сервера Yugcontract (не вдалося прочитати тіло)',
      'malformed',
      response.status
    );
  }
  try {
    return { parsed: JSON.parse(text), byteLength: Buffer.byteLength(text) };
  } catch {
    throw new YugcontractError(
      'Некоректна відповідь сервера Yugcontract (не JSON)',
      'malformed',
      response.status
    );
  }
}

/**
 * Obtain (or reuse) an authToken. The requestToken JWT is signed fresh
 * for every auth call — it is short-lived by design.
 */
async function getAuthToken(fetchImpl: FetchLike): Promise<string> {
  const now = Date.now();
  if (
    cachedAuthToken &&
    cachedAuthToken.expiresAtMs - AUTH_TOKEN_REFRESH_MARGIN_MS > now
  ) {
    return cachedAuthToken.token;
  }

  const { userKey, secret } = readCredentials();
  const requestToken = signHs256Jwt(
    { algorithm: 'HS256', user_key: userKey },
    secret,
    REQUEST_TOKEN_TTL_SEC
  );

  let response: Response;
  try {
    response = await fetchImpl(authUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestToken }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Deliberately opaque: the underlying error may embed request details.
    throw new YugcontractError(
      'Не вдалося з’єднатися з сервером авторизації Yugcontract',
      'upstream'
    );
  }

  const parsed = await parseJsonResponse(response);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new YugcontractError(
        'Yugcontract відхилив авторизацію (перевірте ключі)',
        'auth',
        response.status
      );
    }
    throw new YugcontractError(
      'Сервер авторизації Yugcontract недоступний',
      response.status === 429 ? 'rate_limited' : 'upstream',
      response.status
    );
  }

  const authToken = (parsed as { content?: { authToken?: unknown } } | null)
    ?.content?.authToken;
  if (typeof authToken !== 'string' || authToken.trim() === '') {
    throw new YugcontractError(
      'Некоректна відповідь авторизації Yugcontract',
      'malformed',
      response.status
    );
  }

  cachedAuthToken = {
    token: authToken,
    expiresAtMs: Date.now() + AUTH_TOKEN_TTL_MS,
  };
  return authToken;
}

function invalidateAuthToken(): void {
  cachedAuthToken = null;
}

async function postCatalogOnce(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike
): Promise<Response> {
  const authToken = await getAuthToken(fetchImpl);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000),
    });
  } catch {
    invalidateAuthToken();
    throw new YugcontractError(
      'Не вдалося завантажити каталог Yugcontract (мережева помилка)',
      'upstream'
    );
  }
}

/**
 * Shared catalog-endpoint transport: Bearer auth, single 401 re-auth +
 * retry, typed 429/5xx errors. `entity` only shapes the Ukrainian error
 * text ("ціновий каталог" / "категорії") — never any credential.
 */
async function postCatalogEndpoint(
  url: string,
  body: Record<string, unknown>,
  entity: string,
  fetchImpl: FetchLike
): Promise<{ parsed: unknown; byteLength: number }> {
  let response = await postCatalogOnce(url, body, fetchImpl);

  if (response.status === 401) {
    // Single authorized retry with a fresh token — never a loop.
    invalidateAuthToken();
    response = await postCatalogOnce(url, body, fetchImpl);
  }

  const { parsed, byteLength } = await parseJsonResponseWithSize(response);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new YugcontractError(
        `Yugcontract відхилив доступ до ${entity} після оновлення токена`,
        'auth',
        response.status
      );
    }
    throw new YugcontractError(
      response.status === 429
        ? 'Перевищено ліміт запитів до Yugcontract'
        : `Помилка сервера Yugcontract при отриманні ${entity}`,
      response.status === 429 ? 'rate_limited' : 'upstream',
      response.status
    );
  }

  return { parsed, byteLength };
}

export interface GetPriceOptions {
  /** supplier category ids to limit the feed; empty array = full catalog */
  cats?: number[];
}

/**
 * Fetch the get-price catalog. Returns the raw parsed JSON body;
 * interpretation of the envelope lives in normalize.ts so that transport
 * and shape validation stay independently testable.
 *
 * 401 handling: refresh the authToken once and replay the request once.
 * A second 401 raises 'auth'. 429 raises 'rate_limited', other non-ok
 * statuses raise 'upstream'.
 */
export async function getPriceCatalog(
  options: GetPriceOptions = {},
  fetchImpl: FetchLike = fetch
): Promise<unknown> {
  const { parsed } = await getPriceCatalogWithMeta(options, fetchImpl);
  return parsed;
}

/** Result of a get-price call together with its observed payload size. */
export interface GetPriceResultWithMeta {
  parsed: unknown;
  /** decompressed body size in bytes (what had to be parsed) */
  byteLength: number;
}

/**
 * Same transport as getPriceCatalog plus the actual payload byte size —
 * used by dry-run diagnostics to report real data volumes per batch.
 */
export async function getPriceCatalogWithMeta(
  options: GetPriceOptions = {},
  fetchImpl: FetchLike = fetch
): Promise<GetPriceResultWithMeta> {
  return postCatalogEndpoint(
    priceUrl(),
    {
      format: 'json',
      type: 'regular',
      cats: options.cats ?? [],
      ext_cols: [],
      type_prod: [],
    },
    'цінового каталогу',
    fetchImpl
  );
}

function categoriesUrl(): string {
  return (
    process.env.YUGCONTRACT_CATEGORIES_URL ??
    'https://b2b.yugcontract.ua/api/catalog/get-categories'
  );
}

function contentUrl(): string {
  return (
    process.env.YUGCONTRACT_CONTENT_URL ??
    'https://b2b.yugcontract.ua/api/catalog/get-content-goods'
  );
}

export interface GetContentResultWithMeta {
  parsed: unknown;
  /** decompressed body size in bytes */
  byteLength: number;
}

/**
 * Fetch the get-content-goods catalog. The endpoint has NO server-side
 * filtering: it always returns the FULL content dump (~9k goods, tens of
 * MB, slow upstream assembly), so callers MUST invoke it at most once per
 * refresh cycle and stage the result — never once per batch.
 * Same transport guarantees as the other catalog endpoints.
 */
export async function getContentGoodsWithMeta(
  fetchImpl: FetchLike = fetch
): Promise<GetContentResultWithMeta> {
  return postCatalogEndpoint(
    contentUrl(),
    { format: 'json', type: 'regular' },
    'контенту товарів',
    fetchImpl
  );
}

/**
 * Fetch the get-categories catalog (read-only preview support).
 * Minimal documented-generic body; the response envelope is intentionally
 * NOT assumed here — shape probing lives in normalize.ts because the
 * provider docs do not pin down the exact JSON structure.
 */
export async function getCategoriesCatalog(
  fetchImpl: FetchLike = fetch
): Promise<unknown> {
  const { parsed } = await postCatalogEndpoint(
    categoriesUrl(),
    { format: 'json', type: 'regular' },
    'категорій',
    fetchImpl
  );
  return parsed;
}
