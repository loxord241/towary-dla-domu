/**
 * Nova Post street lookup (stage 2G) — parser/normalizer invariants.
 *
 * GET /streets?settlementId={int}&name={query} — live-verified
 * (docs/novapost-courier-addressparts-research.md): the filter param is
 * `name`, NOT `textSearch` (silently ignored otherwise); settlementId is a
 * strict integer; items carry {id, name, settlement:{id,name}}.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStreetsQuery,
  normalizeStreet,
  searchStreets,
} from '../app/lib/delivery/novapost/streets.ts';
import { NovaPostError } from '../app/lib/delivery/novapost/errors.ts';

const sp = (s: string) => new URLSearchParams(s);

test('STREETS: valid query parses to integer settlementId + name', () => {
  const q = parseStreetsQuery(sp('settlementId=119638&name=Мазепи'));
  assert.ok(q);
  assert.equal(q.settlementId, 119638);
  assert.equal(q.name, 'Мазепи');
  assert.equal(q.limit, 10);
  assert.equal(q.page, 1);
});

test('STREETS: settlementId must be a strict positive integer', () => {
  assert.equal(parseStreetsQuery(sp('settlementId=0&name=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=-5&name=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=12.5&name=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=abc&name=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=+7&name=x')), null);
  assert.equal(parseStreetsQuery(sp('name=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=99999999999999999999&name=x')), null);
});

test('STREETS: name is required (min 2, max 100)', () => {
  assert.equal(parseStreetsQuery(sp('settlementId=1')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=в')), null);
  assert.equal(
    parseStreetsQuery(sp(`settlementId=1&name=${'в'.repeat(101)}`)),
    null
  );
  assert.ok(parseStreetsQuery(sp('settlementId=1&name=Хрещатик')));
});

test('STREETS: limit/page bounds fail closed', () => {
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=ab&limit=0')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=ab&limit=51')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=ab&limit=x')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=ab&page=0')), null);
  assert.equal(parseStreetsQuery(sp('settlementId=1&name=ab&page=1001')), null);
});

test('STREETS: normalize keeps whitelisted fields only', () => {
  const s = normalizeStreet({
    id: 5694732,
    name: 'вул. Гетьмана Івана Мазепи',
    settlement: { id: 119638, name: 'місто Кривий Ріг' },
    alternativeNames: ['x'],
    junk: true,
  });
  assert.ok(s);
  assert.deepEqual(s, {
    id: 5694732,
    name: 'вул. Гетьмана Івана Мазепи',
    settlementId: 119638,
    settlementName: 'місто Кривий Ріг',
  });
});

test('STREETS: normalize rejects malformed items', () => {
  assert.equal(normalizeStreet(null), null);
  assert.equal(normalizeStreet('x'), null);
  assert.equal(normalizeStreet({}), null);
  assert.equal(normalizeStreet({ id: 0, name: 'a' }), null);
  assert.equal(normalizeStreet({ id: 1, name: '' }), null);
  assert.equal(normalizeStreet({ id: 1, name: 'a', settlement: {} }), null);
  assert.equal(normalizeStreet({ id: 1, name: 'a', settlement: { id: 'x' } }), null);
});

test('STREETS: searchStreets sends name param (not textSearch) and normalizes items', async () => {
  const calls: { path: string; params: URLSearchParams; headers?: Record<string, string> }[] = [];
  const client = {
    async getJson(path: string, params: URLSearchParams, headers?: Record<string, string>) {
      calls.push({ path, params, headers });
      return {
        items: [
          { id: 5694732, name: 'вул. Гетьмана Івана Мазепи', settlement: { id: 119638, name: 'місто Кривий Ріг' } },
          { junk: true },
        ],
      };
    },
  } as unknown as Parameters<typeof searchStreets>[0];

  const items = await searchStreets(client, {
    settlementId: 119638,
    name: 'Мазепи',
    limit: 10,
    page: 1,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'streets');
  assert.equal(calls[0].params.get('settlementId'), '119638');
  assert.equal(calls[0].params.get('name'), 'Мазепи');
  assert.equal(calls[0].params.get('textSearch'), null);
  // Live-verified 2026-08-28: without `Accept-Language: uk` street names
  // come back transliterated (e.g. "Mazepy" instead of "вул. Мазепи").
  assert.equal(calls[0].headers?.['Accept-Language'], 'uk');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 5694732);
});

test('STREETS: searchStreets fails closed on malformed provider payload', async () => {
  const client = {
    async getJson() {
      return { nope: true };
    },
  } as unknown as Parameters<typeof searchStreets>[0];
  await assert.rejects(
    () => searchStreets(client, { settlementId: 1, name: 'ab', limit: 5, page: 1 }),
    (err: unknown) => err instanceof NovaPostError
  );
});
