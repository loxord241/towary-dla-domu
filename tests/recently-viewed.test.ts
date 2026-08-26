/**
 * Recently-viewed shelf: pure storage logic (no DB — localStorage only).
 * Covers order, dedupe, cap-8, move-to-front, malformed input, hydration-safe
 * contracts, plus static pins on the client islands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  RECENTLY_VIEWED_STORAGE_KEY,
  MAX_RECENTLY_VIEWED,
  sanitizeRecentlyViewed,
  readRecentlyViewed,
  writeRecentlyViewed,
  recordRecentlyViewed,
} from '../app/lib/recently-viewed-storage.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const E = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const uuidN = (n: number) =>
  `${String(n % 10).repeat(8)}-${String(n % 10).repeat(4)}-4${String(n % 10).repeat(3)}-8${String(n % 10).repeat(3)}-${String(n % 10).repeat(12)}`;

test('RECENT: sanitize keeps valid uuids in order, drops everything else', () => {
  assert.deepEqual(sanitizeRecentlyViewed([A, B]), [A, B]);
  assert.deepEqual(sanitizeRecentlyViewed(['not-a-uuid', A, 42, null, {}]), [A]);
  assert.deepEqual(sanitizeRecentlyViewed('junk'), []);
  assert.deepEqual(sanitizeRecentlyViewed(null), []);
  assert.deepEqual(sanitizeRecentlyViewed([]), []);
});

test('RECENT: sanitize dedupes keeping the FIRST occurrence (stored recency order)', () => {
  assert.deepEqual(sanitizeRecentlyViewed([A, B, A, C]), [A, B, C]);
});

test('RECENT: sanitize caps at 8 entries', () => {
  const many = Array.from({ length: 20 }, (_, i) => uuidN(i));
  const kept = sanitizeRecentlyViewed(many);
  assert.equal(kept.length, MAX_RECENTLY_VIEWED);
  // No truncation of the recency head: first entries survive intact.
  assert.deepEqual(kept, many.slice(0, MAX_RECENTLY_VIEWED));
});

test('RECENT: record adds new product at front', () => {
  assert.deepEqual(recordRecentlyViewed([B, C], A), [A, B, C]);
});

test('RECENT: record moves existing product to front without duplication', () => {
  assert.deepEqual(recordRecentlyViewed([C, B, A], A), [A, C, B]);
  const once = recordRecentlyViewed([C, B, A], A);
  assert.equal(once.filter((id) => id === A).length, 1);
});

test('RECENT: record evicts oldest beyond the cap of 8', () => {
  const eight = [A, B, C, uuidN(4), uuidN(5), uuidN(6), uuidN(7), uuidN(8)];
  // Fresh id (hex letters) that uuidN() can never generate.
  const next = recordRecentlyViewed(eight, E);
  assert.equal(next.length, MAX_RECENTLY_VIEWED);
  assert.equal(next[0], E, 'newest first');
  assert.equal(next.includes(uuidN(8)), false, 'oldest dropped');
});

test('RECENT: invalid product id leaves the list unchanged', () => {
  assert.deepEqual(recordRecentlyViewed([A, B], 'garbage'), [A, B]);
  assert.deepEqual(recordRecentlyViewed([], ''), []);
});

test('RECENT: read guards malformed JSON and wrong shapes', () => {
  const get = (raw: string | null) => (key: string) => {
    assert.equal(key, RECENTLY_VIEWED_STORAGE_KEY);
    return raw;
  };
  assert.deepEqual(readRecentlyViewed(get('not json')), []);
  assert.deepEqual(readRecentlyViewed(get(JSON.stringify({ x: 1 }))), []);
  assert.deepEqual(readRecentlyViewed(get(JSON.stringify([A, 'bad']))), [A]);
  assert.deepEqual(readRecentlyViewed(get(null)), []);
});

test('RECENT: write serializes the array; storage failures are swallowed', () => {
  let savedKey: string | undefined;
  let stored: string | undefined;
  writeRecentlyViewed((key, value) => { savedKey = key; stored = value; }, [A, B]);
  assert.equal(savedKey, RECENTLY_VIEWED_STORAGE_KEY);
  assert.ok(stored !== undefined, 'write must serialize the list');
  assert.deepEqual(JSON.parse(stored), [A, B]);

  assert.doesNotThrow(() =>
    writeRecentlyViewed(() => { throw new Error('quota'); }, [A])
  );

  assert.equal(RECENTLY_VIEWED_STORAGE_KEY, 'eshop-recently-viewed-v1');
});

// ---- client islands: hydration-safe contracts ----

test('RECENT TRACKER: renders null, writes only inside useEffect', () => {
  const cmp = src('app/components/RecentlyViewedTracker.tsx');
  assert.match(cmp, /'use client'/);
  assert.match(cmp, /useEffect/);
  assert.match(cmp, /return null/, 'renders nothing — SSR-safe');
  // Storage access must live inside the effect body, not module/render scope.
  const effectPart = cmp.slice(cmp.indexOf('useEffect'));
  assert.match(effectPart, /localStorage/);
});

test('RECENT SHELF: excludes current product, caps 8, reuses cart-preview invariant', () => {
  const cmp = src('app/components/RecentProducts.tsx');
  assert.match(cmp, /excludeProductId/);
  assert.match(cmp, /\.filter\(\(id\) => id !== excludeProductId/);
  assert.match(cmp, /fetchCartPreview/, 'ONLY sanctioned preview fetcher');
  assert.match(cmp, /MAX_RECENTLY_VIEWED/, 'cap enforced at fetch boundary');
  assert.match(cmp, /mounted/, 'renders nothing before mount (hydration-safe)');
  assert.match(cmp, /Нещодавно переглянуті/);
  assert.match(cmp, /<ProductCard/, 'reuses the existing ProductCard');
  assert.match(
    cmp,
    /line\.found/,
    'stale/deleted products (found:false) are dropped'
  );
  const page = src('app/product/[slug]/page.tsx');
  assert.match(page, /<RecentProducts excludeProductId=\{product\.id\}/);
});
