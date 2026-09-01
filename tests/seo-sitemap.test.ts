/**
 * Sitemap expansion: products enter the sitemap under the SAME visibility
 * contract as the storefront grid (active + ≥1 photo), reads stay bounded
 * (paged windows ≤1000, deterministic id tiebreaker), and no private route
 * ever enters the URL list (spec C of the SEO package).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectPaged, collectNonEmptyCategoryIds, collectNonEmptyBrandIds } from '../app/lib/seo-sitemap.ts';

test('SITEMAP: collectPaged walks exact windows and stops on a short page', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ slug: `s${i}` }));
  const calls: [number, number][] = [];
  const out = await collectPaged(async (from, limit) => {
    calls.push([from, limit]);
    return rows.slice(from, from + limit);
  }, { pageSize: 1000 });

  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal(out.length, 2500);
  assert.equal(out[2499].slug, 's2499');
});

test('SITEMAP: collectPaged enforces pageSize ≤1000 and honors maxRows cap', async () => {
  const big = Array.from({ length: 999_999 }, (_, i) => i);
  const out = await collectPaged(
    async (from, limit) => big.slice(from, from + limit),
    { pageSize: 5000, maxRows: 2500 }
  );
  assert.equal(out.length, 2500);

  const seen: number[] = [];
  await collectPaged(
    async (_from, limit) => {
      seen.push(limit);
      return new Array(limit).fill(0);
    },
    { pageSize: 20000, maxRows: 10 }
  );
  assert.ok(seen.every((l) => l <= 1000), 'window must clamp to 1000');
});

test('SITEMAP: empty source resolves to an empty list without throwing', async () => {
  const out = await collectPaged(async () => [], { pageSize: 1000 });
  assert.deepEqual(out, []);
});

test('SITEMAP: product query mirrors storefront eligibility (source-level)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(src, /product_images!inner/, 'eligibility join required');
  assert.match(src, /\.eq\('is_active',\s*true\)/);
  assert.match(src, /\.order\('id'/, 'deterministic tiebreaker required');
  for (const banned of ['/cart', '/favorites', '/checkout', '/admin', '/api/']) {
    assert.ok(!src.includes(`'${banned}'`), `${banned} must not appear in sitemap paths`);
  }
});

// ---------------------------------------------------------------------------
// Task #14 (2026-09): empty category/brand views (0 eligible products) are
// noindex'd and must stay OUT of the sitemap. Pure helpers decide which
// entries survive; the subtree semantics mirror fetchCatalogProducts.
// ---------------------------------------------------------------------------

test('SITEMAP: category is non-empty when it or any descendant holds an assignment', () => {
  // root r1 → child c1 → leaf l1 (assigned); r2 fully empty; orphan o.
  const categories = [
    { id: 'r1', parent_id: null },
    { id: 'c1', parent_id: 'r1' },
    { id: 'l1', parent_id: 'c1' },
    { id: 'r2', parent_id: null },
    { id: 'o', parent_id: 'missing' }, // orphan behaves as a root
  ];
  const out = collectNonEmptyCategoryIds(categories, new Set(['l1']));
  for (const id of ['l1', 'c1', 'r1']) {
    assert.ok(out.has(id), `${id} inherits the leaf assignment`);
  }
  for (const id of ['r2', 'o']) {
    assert.ok(!out.has(id), `${id} stays excluded (empty view)`);
  }
});

test('SITEMAP: assignments on a parent category keep the whole branch', () => {
  const categories = [
    { id: 'p', parent_id: null },
    { id: 'leaf', parent_id: 'p' },
  ];
  const out = collectNonEmptyCategoryIds(categories, new Set(['p', 'leaf']));
  assert.ok(out.has('p') && out.has('leaf'));
});

test('SITEMAP: unknown assigned ids are ignored; empty inputs stay empty', () => {
  const categories = [{ id: 'a', parent_id: null }];
  assert.deepEqual(
    [...collectNonEmptyCategoryIds(categories, new Set(['ghost', 'a']))],
    ['a'],
    'assignment to an unknown category id must not mark anything'
  );
  assert.deepEqual([...collectNonEmptyCategoryIds([], new Set(['a']))], []);
  assert.deepEqual([...collectNonEmptyCategoryIds(categories, new Set())], []);
});

test('SITEMAP: cycle-safe parent walk (cycle cannot hang or lose nodes)', () => {
  const categories = [
    { id: 'x', parent_id: 'y' },
    { id: 'y', parent_id: 'x' },
  ];
  const out = collectNonEmptyCategoryIds(categories, new Set(['x']));
  assert.ok(out.has('x') && out.has('y'));
});

test('SITEMAP: brand is non-empty only with ≥1 eligible assignment', () => {
  const brands = [{ id: 'b1' }, { id: 'b2' }];
  assert.deepEqual(
    [...collectNonEmptyBrandIds(brands, new Set(['b1']))].sort(),
    ['b1'],
    'b2 (0 eligible products) must be excluded'
  );
  assert.deepEqual([...collectNonEmptyBrandIds(brands, new Set())], []);
});

test('SITEMAP: empty-view exclusion is wired into sitemap.ts (source-level)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(src, /collectNonEmptyCategoryIds/, 'categories must go through the non-empty filter');
  assert.match(src, /collectNonEmptyBrandIds/, 'brands must go through the non-empty filter');
  // The product URL set itself must keep its existing contract.
  assert.match(src, /DU_REDIRECT_SLUGS\.has/, 'product _du redirect filter unchanged');
});
