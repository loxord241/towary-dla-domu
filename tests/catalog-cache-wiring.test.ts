/**
 * Cache wiring for storefront public reads (app/lib/catalog.ts, 2026-08-31).
 *
 * Contract (audit 2026-08-31, caching step 2):
 *  - public, user-independent reads are wrapped via unstable_cache
 *    (dictionaries TTL 120s, everything else 60s);
 *  - cache keys include the keyPrefix AND every function argument
 *    (unstable_cache serializes args into the invocation key);
 *  - DB errors are NEVER a cached failure: a throwing read leaves no cache
 *    entry, so the next request re-executes;
 *  - fetchCatalogProducts / fetchProducts / fetchPopularProducts stay
 *    UNCACHED (user-controlled filter keys / home ISR already bounds them);
 *  - no user-specific context (cookies/headers/searchParams) may enter the
 *    cached reads.
 *
 * The behavioral part runs unstable_cache's plain-node code path against a
 * mock incremental cache installed on globalThis BEFORE catalog.ts loads
 * (node --test runs each file in its own process, so the mock cannot leak).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// catalog.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

// Next's server bootstrap normally installs this global
// (node-environment-baseline.js); the plain-node test runtime must do the
// same before unstable_cache's storage modules load, otherwise ALS-backed
// stores fall back to the throwing Fake implementation.
import { AsyncLocalStorage } from 'node:async_hooks';
(globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;

// ---- mock incremental cache (unstable_cache's plain-node storage) ----
const cacheStore = new Map<string, string>();
const cacheSets: { key: string; revalidate: unknown; tags: unknown }[] = [];
const generatedKeys: string[] = [];

(globalThis as Record<string, unknown>).__incrementalCache = {
  isOnDemandRevalidate: false,
  async generateSimpleCacheKey(invocationKey: string) {
    generatedKeys.push(invocationKey);
    return invocationKey;
  },
  async get(key: string) {
    const body = cacheStore.get(key);
    if (body === undefined) return null;
    return { isStale: false, value: { kind: 'FETCH', data: { body } } };
  },
  async set(
    key: string,
    entry: { revalidate: number; data: { body: string } },
    opts: { tags?: string[] }
  ) {
    cacheSets.push({ key, revalidate: entry.revalidate, tags: opts?.tags });
    cacheStore.set(key, entry.data.body);
  },
};

const {
  cachePublicRead,
  CATALOG_DICTIONARY_TTL_SECONDS,
  CATALOG_PUBLIC_READ_TTL_SECONDS,
} = await import('../app/lib/catalog.ts');

// ---- behavioral: unstable_cache wiring as used by the storefront ----

test('wiring: same args execute the underlying read once, second call is cached', async () => {
  let calls = 0;
  const fn = cachePublicRead(
    'test:once',
    CATALOG_PUBLIC_READ_TTL_SECONDS,
    async (a: string) => {
      calls++;
      return { v: a };
    }
  );
  const first = await fn('x');
  const second = await fn('x');
  assert.equal(calls, 1);
  assert.deepEqual(second, { v: 'x' });
  assert.deepEqual(first, { v: 'x' });
});

test('wiring: different args produce different cache keys and re-execute', async () => {
  let calls = 0;
  const fn = cachePublicRead(
    'test:args',
    CATALOG_PUBLIC_READ_TTL_SECONDS,
    async (a: string) => {
      calls++;
      return a;
    }
  );
  await fn('a');
  await fn('b');
  assert.equal(calls, 2);
  const keysForPrefix = generatedKeys.filter((k) => k.includes('test:args'));
  assert.equal(new Set(keysForPrefix).size, 2);
});

test('wiring: invocation key contains the keyPrefix and the serialized args', async () => {
  const fn = cachePublicRead(
    'test:keys',
    CATALOG_PUBLIC_READ_TTL_SECONDS,
    async (a: string, b: number) => `${a}:${b}`
  );
  await fn('abc', 3);
  const key = generatedKeys.find((k) => k.includes('test:keys'));
  assert.ok(key, 'prefix must appear in the cache key');
  assert.ok(key.includes('"abc"'), 'string arg must appear in the cache key');
  assert.ok(key.includes('3'), 'number arg must appear in the cache key');
});

test('wiring: TTL and shared tag reach the cache backend on write', async () => {
  const fn = cachePublicRead(
    'test:ttl',
    CATALOG_DICTIONARY_TTL_SECONDS,
    async () => 1
  );
  await fn();
  const record = cacheSets.find((s) => s.key.includes('test:ttl'));
  assert.ok(record, 'cache write must happen');
  assert.equal(record.revalidate, CATALOG_DICTIONARY_TTL_SECONDS);
  assert.deepEqual(record.tags, ['catalog-public-reads']);
});

test('wiring: DB error is not cached — next call re-executes and succeeds', async () => {
  let calls = 0;
  let fail = true;
  const fn = cachePublicRead(
    'test:error',
    CATALOG_PUBLIC_READ_TTL_SECONDS,
    async () => {
      calls++;
      if (fail) throw new Error('db down');
      return 'ok';
    }
  );
  await assert.rejects(() => fn(), /db down/);
  assert.equal(calls, 1);
  fail = false;
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 2, 'failed read must not be served from cache');
  assert.equal(await fn(), 'ok');
  assert.equal(calls, 2, 'successful read must be cached afterwards');
});

test('wiring: TTL constants contract (dictionaries 120s, public reads 60s)', () => {
  assert.equal(CATALOG_DICTIONARY_TTL_SECONDS, 120);
  assert.equal(CATALOG_PUBLIC_READ_TTL_SECONDS, 60);
});

// ---- structural invariants over app/lib/catalog.ts source ----

const src = readFileSync(path.join(root, 'app/lib/catalog.ts'), 'utf8');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `function not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `function end not found: ${signature}`);
  return source.slice(start, end);
}

test('source: every planned public read is wrapped exactly once with its prefix/TTL', () => {
  const mappings: [string, string][] = [
    ['catalog:categories', 'CATALOG_DICTIONARY_TTL_SECONDS'],
    ['catalog:brands', 'CATALOG_DICTIONARY_TTL_SECONDS'],
    ['catalog:category-slug', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:brand-slug', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:product-slug', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:review-summary', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:reviews', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:related', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    // Task #14: eligible-product counts per single category/brand view.
    ['catalog:category-product-count', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
    ['catalog:brand-product-count', 'CATALOG_PUBLIC_READ_TTL_SECONDS'],
  ];
  for (const [prefix, ttl] of mappings) {
    const uses = src.split(`'${prefix}'`).length - 1;
    assert.equal(
      uses,
      1,
      `cache prefix '${prefix}' must be used exactly once`
    );
    const callSite = src.slice(src.indexOf(`'${prefix}'`) - 400, src.indexOf(`'${prefix}'`));
    assert.ok(
      callSite.includes('cachePublicRead('),
      `'${prefix}' must be wrapped via cachePublicRead`
    );
    const ttlArg = src.slice(src.indexOf(`'${prefix}'`), src.indexOf(`'${prefix}'`) + 200);
    assert.ok(
      ttlArg.includes(ttl),
      `'${prefix}' must use TTL constant ${ttl}`
    );
  }
  assert.equal(
    src.split('cachePublicRead(').length - 1,
    mappings.length,
    'no unplanned cachePublicRead call sites (the helper definition itself is generic `cachePublicRead<`)'
  );
});

test('source: fetchCatalogProducts / fetchProducts / fetchPopularProducts stay UNCACHED', () => {
  for (const signature of [
    'export async function fetchCatalogProducts',
    'async function fetchProducts(',
    'export async function fetchPopularProducts',
  ]) {
    const body = functionBody(src, signature);
    assert.doesNotMatch(
      body,
      /cachePublicRead|unstable_cache/,
      `${signature} must not be cached (user-controlled keys / ISR-bounded)`
    );
  }
});

test('source: cached reads touch no user-specific context', () => {
  assert.doesNotMatch(src, /from 'next\/headers'/);
  assert.doesNotMatch(src, /cookies\(/);
  assert.doesNotMatch(src, /\bheaders\(\)/);
  // The only 'searchParams' occurrences allowed are prose in comments about
  // supabase-js URL builders — never a request-context read.
  assert.doesNotMatch(src, /await searchParams/);
  assert.doesNotMatch(src, /searchParams\.get\(/);
});

test('source: public signatures of exported fetch functions are unchanged', () => {
  for (const signature of [
    'export async function fetchProductBySlug(slug: string)',
    'export async function fetchRelatedProducts(',
    'export async function fetchCatalogProducts(',
    'export async function fetchActiveCategories()',
    'export async function fetchActiveBrands()',
    'export async function fetchPublishedReviews(',
    'export async function fetchReviewSummary(',
    'export const fetchCategoryBySlug',
    'export const fetchBrandBySlug',
  ]) {
    assert.ok(src.includes(signature), `missing export: ${signature}`);
  }
});
