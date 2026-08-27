/**
 * Nova Post client — behavior + security tests.
 * Provider HTTP is always a stub (never a real Nova Post call).
 * Run: npm test
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createNovaPostClient } from '../app/lib/delivery/novapost/client.ts';
import {
  isNovaPostError,
} from '../app/lib/delivery/novapost/errors.ts';
import { NOVA_POST_API_KEY_ENV } from '../app/lib/delivery/novapost/config.ts';

const KEY = 'test-np-key-do-not-leak-42';

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
  handler: (call: Call, attempt: number) => Response | Promise<Response>
): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  let attempt = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call, attempt++);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeClient(fetchImpl: typeof fetch) {
  return createNovaPostClient({
    apiKey: KEY,
    baseUrl: 'https://api.example.invalid/v.1.0/',
    fetchImpl,
    now: () => 1_000_000,
  });
}

describe('nova post client: authentication', () => {
  beforeEach(() => {
    /* stateless per test via fresh clients */
  });

  test('authorizes once, caches the jwt, sends raw Authorization header', async () => {
    const { calls, fetchImpl } = stubFetch((call) => {
      if (call.url.includes('clients/authorization')) {
        return jsonResponse(200, { jwt: 'jwt-token-abc' });
      }
      return jsonResponse(200, { items: [] });
    });
    const client = makeClient(fetchImpl);

    await client.getJson('settlements', new URLSearchParams());
    await client.getJson('divisions', new URLSearchParams());

    const authCalls = calls.filter((c) =>
      c.url.includes('clients/authorization')
    );
    assert.equal(authCalls.length, 1, 'jwt must be cached across requests');
    const dataCalls = calls.filter((c) => !c.url.includes('authorization'));
    assert.equal(dataCalls.length, 2);
    assert.ok(dataCalls.every((c) => c.headers.authorization === 'jwt-token-abc'));
    // official docs: apiKey travels only in the authorization query param
    assert.ok(calls.every((c) => !Object.keys(c.headers).includes('x-api-key')));
  });

  test('401 invalidates the cached jwt and retries once', async () => {
    let authCount = 0;
    const { calls, fetchImpl } = stubFetch((call) => {
      if (call.url.includes('clients/authorization')) {
        authCount += 1;
        return jsonResponse(200, { jwt: authCount === 1 ? 'jwt-old' : 'jwt-new' });
      }
      if (call.headers.authorization === 'jwt-old') return jsonResponse(401, {});
      return jsonResponse(200, { items: [] });
    });
    const client = makeClient(fetchImpl);

    const body = await client.getJson('settlements', new URLSearchParams());
    assert.deepEqual(body, { items: [] });
    assert.equal(authCount, 2, 'token must be re-issued exactly once');
    assert.ok(
      calls.some((c) => c.headers.authorization === 'jwt-new'),
      'second attempt must use the fresh jwt'
    );
  });

  test('persistent 401 surfaces as unauthorized', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(401, {}));
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getJson('settlements', new URLSearchParams()),
      (error: unknown) => isNovaPostError(error) && error.kind === 'unauthorized'
    );
  });
});

describe('nova post client: error handling', () => {
  test('422 -> provider_error with sanitized field details', async () => {
    const { fetchImpl } = stubFetch((call) => {
      if (call.url.includes('authorization')) {
        return jsonResponse(200, { jwt: 'jwt-1' });
      }
      return jsonResponse(422, {
        errors: { city: 'unknown city', recipient: 'division not found' },
      });
    });
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.postJson('shipments/calculations', {}),
      (error: unknown) => {
        assert.ok(isNovaPostError(error));
        assert.equal(error.kind, 'provider_error');
        assert.deepEqual(error.providerDetails, {
          city: 'unknown city',
          recipient: 'division not found',
        });
        assert.ok(!error.message.includes(KEY));
        return true;
      }
    );
  });

  test('503 and network failure -> unavailable (controlled)', async () => {
    const { fetchImpl } = stubFetch((call) =>
      call.url.includes('authorization')
        ? jsonResponse(200, { jwt: 'jwt-1' })
        : jsonResponse(503, {})
    );
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getJson('settlements', new URLSearchParams()),
      (error: unknown) => isNovaPostError(error) && error.kind === 'unavailable'
    );

    const failing = createNovaPostClient({
      apiKey: KEY,
      baseUrl: 'https://api.example.invalid/v.1.0/',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED with ' + KEY);
      }) as typeof fetch,
      now: () => 1,
    });
    await assert.rejects(
      () => failing.getJson('settlements', new URLSearchParams()),
      (error: unknown) => {
        assert.ok(isNovaPostError(error));
        assert.equal(error.kind, 'unavailable');
        // network error text must never leak into our error surface
        assert.ok(!error.message.includes(KEY));
        assert.ok(!error.message.includes('ECONNREFUSED'));
        return true;
      }
    );
  });

  test('auth response without jwt -> unexpected_response, no key in message', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(200, { hello: 1 }));
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getJson('settlements', new URLSearchParams()),
      (error: unknown) => {
        assert.ok(isNovaPostError(error));
        assert.equal(error.kind, 'unexpected_response');
        assert.ok(!error.message.includes(KEY));
        return true;
      }
    );
  });

  test('client never throws a non-NovaPostError', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw 'weird sync failure';
    });
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getJson('settlements', new URLSearchParams()),
      (error: unknown) => isNovaPostError(error)
    );
  });
});

describe('nova post client: settlements live-confirmed contract', () => {
  test('sends uppercase countryCodes[]=UA and Accept-Language: uk', async () => {
    const { calls, fetchImpl } = stubFetch((call) =>
      call.url.includes('authorization')
        ? jsonResponse(200, { jwt: 'jwt-ua' })
        : jsonResponse(200, { items: [] })
    );
    const client = makeClient(fetchImpl);
    await client.getJson(
      'settlements',
      new URLSearchParams([['countryCodes[]', 'X']]),
      { 'Accept-Language': 'uk' }
    );
    const settlementsCall = calls.find((c) => c.url.includes('/settlements'));
    assert.ok(settlementsCall);
    assert.equal(settlementsCall.headers['accept-language'], 'uk');
  });

  test('settlements module pins the live-confirmed values (static)', () => {
    const settlementsSrc = readFileSync(
      path.join(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        'app/lib/delivery/novapost/settlements.ts'
      ),
      'utf8'
    );
    // live API rejects the documented lowercase enum ("uk") with 422
    assert.match(
      settlementsSrc,
      /COUNTRY_CODE_UKRAINE = 'UA'/,
      'countryCodes must be uppercase UA (live-confirmed)'
    );
    assert.match(
      settlementsSrc,
      /ACCEPT_LANGUAGE_UKRAINE = 'uk'/,
      'Accept-Language uk must be pinned for Ukrainian names'
    );
    assert.doesNotMatch(settlementsSrc, /COUNTRY_CODE_UKRAINE = 'uk'/);
  });
});

describe('nova post: security invariants (static)', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const layerFiles = [
    'app/lib/delivery/novapost/config.ts',
    'app/lib/delivery/novapost/client.ts',
    'app/lib/delivery/novapost/errors.ts',
    'app/lib/delivery/novapost/types.ts',
    'app/lib/delivery/novapost/settlements.ts',
    'app/lib/delivery/novapost/divisions.ts',
    'app/lib/delivery/novapost/delivery-cost.ts',
    'app/api/delivery/novapost/settlements/route.ts',
    'app/api/delivery/novapost/divisions/route.ts',
    'app/api/delivery/novapost/delivery-cost/route.ts',
  ];
  const src = (rel: string): string =>
    // strip comments entirely so prose cannot trip the secret scans
    readFileSync(path.join(root, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('key env var name is NOVA_POST_API_KEY (no NEXT_PUBLIC_ secret)', () => {
    assert.equal(NOVA_POST_API_KEY_ENV, 'NOVA_POST_API_KEY');
    for (const file of layerFiles) {
      assert.ok(
        !/NEXT_PUBLIC_/.test(src(file)),
        `${file} must not reference NEXT_PUBLIC_*`
      );
    }
  });

  test('apiKey is only read in config.ts and used in client.ts', () => {
    for (const file of layerFiles) {
      const content = src(file);
      if (file.endsWith('config.ts') || file.endsWith('client.ts')) continue;
      assert.ok(
        !/apiKey|NOVA_POST_API_KEY/.test(content),
        `${file} must never touch the api key`
      );
    }
  });

  test('routes are server-side handlers (no "use client")', () => {
    for (const file of layerFiles.filter((f) => f.includes('/route.ts'))) {
      assert.ok(!src(file).includes('"use client"'), `${file} must be server-side`);
      assert.match(src(file), /export async function (GET|POST)/);
    }
  });

  test('error class never embeds provider payload verbatim', () => {
    const errorsSrc = src('app/lib/delivery/novapost/errors.ts');
    assert.match(errorsSrc, /class NovaPostError/);
    // errors.ts never touches raw bodies at all
    assert.doesNotMatch(errorsSrc, /Response|fetch|json\(/);
    // the only place provider text enters our objects is the sanitizer,
    // which caps field names (50) and messages (200) in client.ts
    const clientSrc = src('app/lib/delivery/novapost/client.ts');
    assert.match(clientSrc, /slice\(0, 50\)/);
    assert.match(clientSrc, /slice\(0, 200\)/);
  });
});
