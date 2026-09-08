/**
 * Ukrposhta client — behavior + security tests.
 * Provider HTTP is always a stub (never a real Ukrposhta call).
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createUkrposhtaClient,
  UKRPOSHTA_ERROR_BODY_CAP,
} from '../app/lib/delivery/ukrposhta/client.ts';
import { isUkrposhtaError } from '../app/lib/delivery/ukrposhta/errors.ts';
import { UKRPOSHTA_ACCEPT_JSON } from '../app/lib/delivery/ukrposhta/config.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stubFetch(
  handler: (call: Call) => Response | Promise<Response>
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('CLIENT: classifier GET is keyless and ALWAYS asks for JSON', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(200, { Entries: {} }));
  const client = createUkrposhtaClient({ bearer: null, fetchImpl });
  const body = await client.classifierGet(
    'get_postoffices_by_postindex',
    new URLSearchParams({ poCityId: '14288' })
  );
  assert.deepEqual(body, { Entries: {} });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.url, /^https:\/\/www\.ukrposhta\.ua\/address-classifier\/0\.0\.1\//);
  assert.match(call.url, /poCityId=14288$/);
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.Accept, UKRPOSHTA_ACCEPT_JSON);
  assert.equal(call.headers.Authorization, undefined);
});

test('CLIENT: classifier XML answer (missing Accept behavior / provider change) is unexpected_response', async () => {
  const { fetchImpl } = stubFetch(
    () =>
      new Response('<Entries xmlns="http://ws.wso2.org/dataservice"/>', {
        status: 200,
      })
  );
  const client = createUkrposhtaClient({ bearer: null, fetchImpl });
  await assert.rejects(
    client.classifierGet('get_regions_by_region_ua', new URLSearchParams()),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'unexpected_response'
  );
});

test('CLIENT: classifier HTTP failure → unavailable; 401/403 → unauthorized', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(500, { message: 'boom' }));
  const client = createUkrposhtaClient({ bearer: null, fetchImpl });
  await assert.rejects(
    client.classifierGet('x', new URLSearchParams()),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'unavailable'
  );
  const { fetchImpl: unauthorizedFetch } = stubFetch(() => jsonResponse(403, {}));
  const client2 = createUkrposhtaClient({ bearer: null, fetchImpl: unauthorizedFetch });
  await assert.rejects(
    client2.classifierGet('x', new URLSearchParams()),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'unauthorized'
  );
});

test('CLIENT: ecom POST without bearer fails typed not_configured BEFORE any network call', async () => {
  const { calls, fetchImpl } = stubFetch(() => jsonResponse(200, {}));
  const client = createUkrposhtaClient({ bearer: null, fetchImpl });
  await assert.rejects(
    client.ecomPost('domestic/delivery-price', { weight: 1000 }),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'not_configured'
  );
  assert.equal(calls.length, 0, 'no fetch may happen without the bearer');
});

test('CLIENT: ecom POST sends the static bearer (no auth handshake, no cache)', async () => {
  const { calls, fetchImpl } = stubFetch(() =>
    jsonResponse(200, { deliveryPrice: 55.5 })
  );
  const client = createUkrposhtaClient({ bearer: 'bearer-uuid-1', fetchImpl });
  await client.ecomPost('domestic/delivery-price', { weight: 1000 });
  await client.ecomPost('domestic/delivery-price', { weight: 2000 });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.match(call.url, /^https:\/\/www\.ukrposhta\.ua\/ecom\/0\.0\.1\/domestic\/delivery-price$/);
    assert.equal(call.headers.Accept, UKRPOSHTA_ACCEPT_JSON);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers.Authorization, 'Bearer bearer-uuid-1');
  }
  // every request re-sends the same static bearer — no cached JWT flow
  assert.equal(calls[0]!.headers.Authorization, calls[1]!.headers.Authorization);
});

test('CLIENT: ecom 401 → unauthorized; 400/422 → provider_error with sanitized details', async () => {
  const base = { bearer: 'b', fetchImpl: undefined as unknown as typeof fetch };
  const { fetchImpl: f1 } = stubFetch(() => jsonResponse(401, {}));
  const c1 = createUkrposhtaClient({ ...base, fetchImpl: f1 });
  await assert.rejects(
    c1.ecomPost('x', {}),
    (e: unknown) => isUkrposhtaError(e) && e.kind === 'unauthorized'
  );

  const longJunk = 'x'.repeat(10_000);
  const { fetchImpl: f2 } = stubFetch(() =>
    jsonResponse(422, { message: longJunk })
  );
  const c2 = createUkrposhtaClient({ ...base, fetchImpl: f2 });
  try {
    await c2.ecomPost('x', {});
    assert.fail('must throw');
  } catch (e) {
    assert.ok(isUkrposhtaError(e));
    assert.equal(e.kind, 'provider_error');
    assert.ok((e.providerDetails?.message ?? '').length <= 200);
    assert.ok((e.providerDetails?.message ?? '').length <= UKRPOSHTA_ERROR_BODY_CAP);
  }
});
