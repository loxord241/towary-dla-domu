/**
 * Unit tests for the Yugcontract server-only client: token caching,
 * single 401 retry, 429/5xx handling and malformed responses.
 * Uses an injected fetch — no real network. Run: npm test
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.YUGCONTRACT_USER_KEY ??= 'test-user-key-NOT-REAL';
process.env.YUGCONTRACT_SECRET ??= 'test-secret-NOT-REAL';

const {
  getPriceCatalog,
  resetAuthTokenCacheForTests,
  YugcontractError,
} = await import('../app/lib/yugcontract/client.ts');

interface Call {
  url: string;
  init?: RequestInit;
}

/** Scripted fake fetch: consumes one queued response per call. */
function makeFetch(script: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), init };
    calls.push(call);
    const next = script[calls.length - 1];
    if (!next) throw new Error('fake-fetch: unexpected extra call');
    return next(call);
  }) as typeof fetch;
  return { fetchImpl: fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OK_PRICE_BODY = {
  content: { data: { rests: { product: [{ id: '1', name_ukr: 'x' }] } } },
};

beforeEach(() => {
  resetAuthTokenCacheForTests();
});

test('auth token is requested once and reused across price calls', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: { authToken: 'TOKEN-1' } }),
    () => jsonResponse(OK_PRICE_BODY),
    () => jsonResponse(OK_PRICE_BODY),
  ]);

  await getPriceCatalog({}, fetchImpl);
  await getPriceCatalog({}, fetchImpl);

  const authCalls = calls.filter((c) => c.url.includes('get-auth-token'));
  const priceCalls = calls.filter((c) => c.url.includes('get-price'));
  assert.equal(authCalls.length, 1);
  assert.equal(priceCalls.length, 2);

  // The requestToken JWT must be present in the auth body…
  const authCall = authCalls[0];
  assert.ok(authCall !== undefined);
  const authBody = JSON.parse(String(authCall.init?.body));
  assert.match(authBody.requestToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // …and the secret/user key must NOT appear anywhere in it or in headers.
  assert.ok(!String(authBody.requestToken).includes('test-secret-NOT-REAL'));
  assert.ok(!String(authBody.init).includes('test-secret-NOT-REAL'));

  const priceCall = priceCalls[0];
  assert.ok(priceCall !== undefined);
  const priceAuthHeader = new Headers(priceCall.init?.headers).get('Authorization');
  assert.equal(priceAuthHeader, 'Bearer TOKEN-1');
});

test('401 on price triggers exactly one re-auth + retry, then succeeds', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: { authToken: 'TOKEN-STALE' } }),
    () => jsonResponse({ error: 'expired' }, 401),
    () => jsonResponse({ content: { authToken: 'TOKEN-FRESH' } }),
    () => jsonResponse(OK_PRICE_BODY),
  ]);

  const result = await getPriceCatalog({}, fetchImpl);
  assert.deepEqual(result, OK_PRICE_BODY);

  const authCalls = calls.filter((c) => c.url.includes('get-auth-token'));
  const priceCalls = calls.filter((c) => c.url.includes('get-price'));
  assert.equal(authCalls.length, 2); // initial + refresh
  assert.equal(priceCalls.length, 2); // original + ONE retry
  const retryCall = priceCalls[1];
  assert.ok(retryCall !== undefined);
  assert.equal(
    new Headers(retryCall.init?.headers).get('Authorization'),
    'Bearer TOKEN-FRESH'
  );
});

test('persistent 401 stops after one retry (no infinite loop)', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: { authToken: 'T1' } }),
    () => jsonResponse({}, 401),
    () => jsonResponse({ content: { authToken: 'T2' } }),
    () => jsonResponse({}, 401),
    () => jsonResponse({}, 401), // would be consumed by a retry loop — must never happen
  ]);

  await assert.rejects(
    getPriceCatalog({}, fetchImpl),
    (err: unknown) =>
      err instanceof YugcontractError &&
      err.kind === 'auth' &&
      err.httpStatus === 401
  );

  const priceCalls = calls.filter((c) => c.url.includes('get-price'));
  assert.equal(priceCalls.length, 2); // exactly one retry, then give up
});

test('429 raises rate_limited without any retry', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: { authToken: 'T' } }),
    () => jsonResponse({}, 429),
    () => jsonResponse(OK_PRICE_BODY), // trap for accidental retries
  ]);

  await assert.rejects(
    getPriceCatalog({}, fetchImpl),
    (err: unknown) => err instanceof YugcontractError && err.kind === 'rate_limited'
  );
  assert.equal(calls.length, 2);
});

test('5xx raises upstream without any retry', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: { authToken: 'T' } }),
    () => jsonResponse({}, 500),
    () => jsonResponse(OK_PRICE_BODY),
  ]);

  await assert.rejects(
    getPriceCatalog({}, fetchImpl),
    (err: unknown) =>
      err instanceof YugcontractError && err.kind === 'upstream' && err.httpStatus === 500
  );
  assert.equal(calls.length, 2);
});

test('malformed auth response (missing content.authToken) raises malformed', async () => {
  const { fetchImpl, calls } = makeFetch([
    () => jsonResponse({ content: {} }),
    () => jsonResponse(OK_PRICE_BODY),
  ]);

  await assert.rejects(
    getPriceCatalog({}, fetchImpl),
    (err: unknown) => err instanceof YugcontractError && err.kind === 'malformed'
  );
  assert.equal(calls.length, 1); // price endpoint never called
});

test('non-JSON response raises malformed', async () => {
  const { fetchImpl } = makeFetch([
    () => new Response('<html>oops</html>', { status: 200 }),
  ]);

  await assert.rejects(
    getPriceCatalog({}, fetchImpl),
    (err: unknown) => err instanceof YugcontractError && err.kind === 'malformed'
  );
});

test('network failure raises upstream (opaque, no internals leaked)', async () => {
  const failing = (async () => {
    throw new Error('ECONNRESET super-secret-internal-detail');
  }) as typeof fetch;

  await assert.rejects(
    getPriceCatalog({}, failing),
    (err: unknown) => {
      if (!(err instanceof YugcontractError) || err.kind !== 'upstream') return false;
      // Error text is a fixed Ukrainian message — no cause details inside.
      assert.ok(!err.message.includes('ECONNRESET'));
      return true;
    }
  );
});

test('error messages never contain credentials or tokens', async () => {
  const { fetchImpl } = makeFetch([
    () => jsonResponse({ content: { authToken: 'LEAKY-TOKEN' } }),
    () => jsonResponse({}, 500),
  ]);

  await assert.rejects(getPriceCatalog({}, fetchImpl), (err: unknown) => {
    const message = err instanceof Error ? err.message : '';
    for (const forbidden of ['LEAKY-TOKEN', 'test-secret-NOT-REAL', 'test-user-key-NOT-REAL']) {
      assert.ok(!message.includes(forbidden), `leaked ${forbidden}`);
    }
    return true;
  });
});

test('missing credentials raise a config error before any network call', async () => {
  const savedKey = process.env.YUGCONTRACT_USER_KEY;
  const savedSecret = process.env.YUGCONTRACT_SECRET;
  delete process.env.YUGCONTRACT_USER_KEY;
  delete process.env.YUGCONTRACT_SECRET;
  try {
    const { fetchImpl, calls } = makeFetch([]);
    await assert.rejects(
      getPriceCatalog({}, fetchImpl),
      (err: unknown) => err instanceof YugcontractError && err.kind === 'config'
    );
    assert.equal(calls.length, 0);
  } finally {
    process.env.YUGCONTRACT_USER_KEY = savedKey;
    process.env.YUGCONTRACT_SECRET = savedSecret;
  }
});
