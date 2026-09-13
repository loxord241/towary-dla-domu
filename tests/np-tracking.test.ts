/**
 * Nova Poshta tracking statuses (owner task 2026-09-13).
 *
 * The provider is display-only cache and treated as UNTRUSTED: parse is a
 * strict whitelist, any failure degrades to the plain tracking link. Pure
 * logic is imported directly (no next/server in app/lib/np-tracking.ts);
 * page/route wiring is pinned at source level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const np = await import(
  pathToFileURL(path.join(root, 'app/lib/np-tracking.ts')).href
) as typeof import('../app/lib/np-tracking.ts');

test('NP: stale logic — null/garbage is stale, fresh timestamp is not', () => {
  const now = Date.now();
  assert.equal(np.isNpStatusStale(null, now), true);
  assert.equal(np.isNpStatusStale('', now), true);
  assert.equal(np.isNpStatusStale('not-a-date', now), true);
  const fresh = new Date(now - np.NP_TRACKING_STALE_MS + 60_000).toISOString();
  const stale = new Date(now - np.NP_TRACKING_STALE_MS - 1).toISOString();
  assert.equal(np.isNpStatusStale(fresh, now), false);
  assert.equal(np.isNpStatusStale(stale, now), true);
});

test('NP: phone normalization to the provider local format', () => {
  assert.equal(np.normalizeNpPhone('+380973144221'), '0973144221');
  assert.equal(np.normalizeNpPhone('380973144221'), '0973144221');
  assert.equal(np.normalizeNpPhone('097 314 42 21'), '0973144221');
  assert.equal(np.normalizeNpPhone('973144221'), '0973144221');
  assert.equal(np.normalizeNpPhone(''), null);
  assert.equal(np.normalizeNpPhone(null), null);
  assert.equal(np.normalizeNpPhone('12345'), null);
});

test('NP: request payload whitelists modelName/calledMethod/Documents', () => {
  const body = np.buildGetStatusDocumentsPayload('key-x', [
    { DocumentNumber: '59000987654321', Phone: '0973144221' },
  ]);
  assert.deepEqual(body, {
    apiKey: 'key-x',
    modelName: 'TrackingDocument',
    calledMethod: 'getStatusDocuments',
    methodProperties: {
      Documents: [{ DocumentNumber: '59000987654321', Phone: '0973144221' }],
    },
  });
});

test('NP: strict response whitelist — junk never becomes a status', () => {
  const ok = np.parseNpStatusResponse({
    success: true,
    data: [
      { Number: '59000987654321', Status: 'В дорозі' },
      { Number: '204', Status: 'Отримана' },
      { Number: '', Status: 'bad' },
      { Status: 'no number' },
      { Number: 204, Status: 1 },
      null,
      'x',
      { Number: 'X'.repeat(30), Status: 'too long number' },
      { Number: '204', Status: 'S'.repeat(200) },
    ],
  });
  assert.deepEqual(
    [...ok.entries()].sort(),
    [
      ['204', 'Отримана'],
      ['59000987654321', 'В дорозі'],
    ]
  );
  // Cloudflare HTML / error envelopes / garbage shapes → empty map
  assert.equal(np.parseNpStatusResponse(null).size, 0);
  assert.equal(np.parseNpStatusResponse('<html>Just a moment</html>').size, 0);
  assert.equal(np.parseNpStatusResponse({ errors: ['Документ не знайдено'] }).size, 0);
  assert.equal(np.parseNpStatusResponse({ data: 'nope' }).size, 0);
});

test('NP: fetch failure paths return an empty map (never throw)', async () => {
  const throwing: typeof fetch = async () => {
    throw new Error('cloudflare interstitial');
  };
  assert.equal((await np.fetchNpStatuses([], 'key', throwing)).size, 0);
  assert.equal(
    (
      await np.fetchNpStatuses(
        [{ DocumentNumber: '59000987654321', Phone: '0973144221' }],
        'key',
        throwing
      )
    ).size,
    0
  );
  // no key → no call
  const calls: string[] = [];
  const spy: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  assert.equal((await np.fetchNpStatuses([{ DocumentNumber: '1', Phone: '' }], '', spy)).size, 0);
  assert.equal(calls.length, 0);
});

test('NP: refresh writes only stale shipments with a matched provider answer', async () => {
  const now = Date.now();
  const freshIso = new Date(now - 60_000).toISOString();
  const shipments = [
    {
      id: 's1',
      ttn_number: '59000987654321',
      np_status: 'Створена',
      np_status_checked_at: null,
      phone: '+380973144221',
    },
    {
      id: 's2',
      ttn_number: '20400000000000',
      np_status: null,
      np_status_checked_at: freshIso,
      phone: null,
    },
    { id: 's3', ttn_number: null, np_status: null, np_status_checked_at: null, phone: null },
  ];
  const writes: { id: string; status: string }[] = [];
  const stubFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          { Number: '59000987654321', Status: 'В дорозі' },
          // s2 is fresh → not requested; an unsolicited answer must be ignored
          { Number: '20400000000000', Status: 'Отримана' },
        ],
      }),
      { status: 200 }
    );
  await np.refreshNpStatuses(
    shipments,
    'key',
    async (id, status) => {
      writes.push({ id, status });
    },
    stubFetch,
    now
  );
  assert.deepEqual(writes, [{ id: 's1', status: 'В дорозі' }]);
});

test('NP: no key configured → refresh is a no-op', async () => {
  const calls: string[] = [];
  const spy: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  };
  await np.refreshNpStatuses(
    [
      {
        id: 's1',
        ttn_number: '59000987654321',
        np_status: null,
        np_status_checked_at: null,
        phone: null,
      },
    ],
    null,
    async () => {},
    spy
  );
  assert.equal(calls.length, 0);
});

test('NP: migration 048 pins the display-cache columns', () => {
  const m = src('database/migrations/048_np_status_cache.sql');
  assert.match(m, /add column if not exists np_status text/);
  assert.match(m, /add column if not exists np_status_checked_at timestamptz/);
  assert.match(m, /VERIFY-PRE/);
  assert.match(m, /VERIFY-POST/);
});

test('NP: guest page + admin planner wire the refresh', () => {
  const guest = src('app/orders/[orderNumber]/page.tsx');
  assert.match(guest, /refreshNpStatuses\(/);
  assert.match(guest, /readNpTrackingApiKey\(\)/);
  assert.match(guest, /np_status, np_status_checked_at/);
  const route = src('app/api/admin/orders/[id]/shipments/route.ts');
  assert.match(route, /np_status, np_status_checked_at/);
  // planner never wedges on a slow provider
  assert.match(route, /Promise\.race\(/);
  const lib = src('app/lib/np-tracking.ts');
  assert.doesNotMatch(lib, /from 'next\/server'/,
    'pure module must stay harness-loadable');
});
