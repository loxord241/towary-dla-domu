/**
 * Nova Post failure mapping + route-level static invariants.
 * Route files are never imported here (next/server is not resolvable under
 * plain node --test); their logic lives in the pure mapper + parsers that
 * ARE tested, and the build compiles the wrappers.
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mapNovaPostFailure } from '../app/lib/delivery/novapost/map-failure.ts';
import { NovaPostError } from '../app/lib/delivery/novapost/errors.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routeFiles = [
  'app/api/delivery/novapost/settlements/route.ts',
  'app/api/delivery/novapost/divisions/route.ts',
  'app/api/delivery/novapost/delivery-cost/route.ts',
];
const routeSrc = (rel: string) =>
  readFileSync(path.join(root, rel), 'utf8');

describe('nova post failure mapping', () => {
  test('provider unavailable -> 503 with controlled message', () => {
    const failure = mapNovaPostFailure(
      new NovaPostError('unavailable', 'synthetic')
    );
    assert.ok(failure);
    assert.equal(failure.status, 503);
    assert.match(failure.message, /тимчасово недоступна/);
  });

  test('not configured -> 503 (feature is simply unavailable for the client)', () => {
    const failure = mapNovaPostErrorOfKind('not_configured');
    assert.ok(failure);
    assert.equal(failure.status, 503);
    assert.equal(failure.message, 'Доставка тимчасово недоступна');
  });

  test('invalid input -> 400', () => {
    const failure = mapNovaPostErrorOfKind('invalid_input');
    assert.ok(failure);
    assert.equal(failure.status, 400);
  });

  test('provider rejected parameters -> 422, no details in the message', () => {
    const failure = mapNovaPostFailure(
      new NovaPostError('provider_error', 'synthetic', { city: 'bad city' })
    );
    assert.ok(failure);
    assert.equal(failure.status, 422);
    assert.ok(!failure.message.includes('bad city'));
    assert.ok(!failure.message.toLowerCase().includes('synthetic'));
  });

  test('unauthorized / unexpected provider payload -> 502 (no fake data)', () => {
    for (const kind of ['unauthorized', 'unexpected_response'] as const) {
      const failure = mapNovaPostErrorOfKind(kind);
      assert.ok(failure, kind);
      assert.equal(failure.status, 502);
    }
  });

  test('unknown errors -> null (caller answers generic 502)', () => {
    assert.equal(mapNovaPostFailure(new Error('boom')), null);
    assert.equal(mapNovaPostFailure('str'), null);
    assert.equal(mapNovaPostFailure(null), null);
  });

  test('no failure message ever contains the api key', () => {
    const KEY = 'scan-key-do-not-leak';
    const kinds = [
      'not_configured',
      'invalid_input',
      'unauthorized',
      'provider_error',
      'unavailable',
      'unexpected_response',
    ] as const;
    for (const kind of kinds) {
      const failure = mapNovaPostFailure(new NovaPostError(kind, KEY, { f: KEY }));
      assert.ok(failure);
      assert.ok(!failure.message.includes(KEY), kind);
    }
  });
});

function mapNovaPostErrorOfKind(kind: NovaPostError['kind']) {
  return mapNovaPostFailure(new NovaPostError(kind, 'synthetic'));
}

describe('nova post routes: static invariants', () => {
  test('all three routes exist as server-side handlers', () => {
    for (const file of routeFiles) {
      const content = routeSrc(file);
      assert.ok(!content.includes('"use client"'), `${file} must be server-side`);
      assert.match(content, /export async function (GET|POST)/);
    }
  });

  test('every route enforces the existing rate limiter', () => {
    for (const file of routeFiles) {
      assert.match(
        routeSrc(file),
        /enforceRateLimit\(request, 'novaPoshta/,
        `${file} must apply a rate limit rule`
      );
    }
  });

  test('routes never touch the api key or NEXT_PUBLIC vars', () => {
    for (const file of routeFiles) {
      const content = routeSrc(file);
      assert.ok(!/apiKey|NOVA_POST_API_KEY/.test(content), file);
      assert.ok(!/NEXT_PUBLIC_/.test(content), file);
    }
  });

  test('rate limit rules registered for all three proxies', () => {
    const rules = readFileSync(
      path.join(root, 'app/lib/rate-limit.ts'),
      'utf8'
    );
    for (const rule of [
      'novaPoshtaSettlements',
      'novaPoshtaDivisions',
      'novaPoshtaDeliveryCost',
    ]) {
      assert.match(rules, new RegExp(`${rule}:`));
    }
  });

  test('failure mapper is pure (no next/server import)', () => {
    const mapper = readFileSync(
      path.join(root, 'app/lib/delivery/novapost/map-failure.ts'),
      'utf8'
    );
    assert.doesNotMatch(mapper, /next\/server|NextResponse/);
  });
});
