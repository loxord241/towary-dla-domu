/**
 * Sitemap expansion: products enter the sitemap under the SAME visibility
 * contract as the storefront grid (active + ≥1 photo), reads stay bounded
 * (paged windows ≤1000, deterministic id tiebreaker), and no private route
 * ever enters the URL list (spec C of the SEO package).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectPaged,
  collectNonEmptyCategoryIds,
  collectNonEmptyBrandIds,
  collectNonEmptyComboPairs,
} from '../app/lib/seo-sitemap.ts';

test('SITEMAP: collectPaged walks exact windows and stops on a short page', async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ slug: `s${i}` }));
  const calls: [number, number][] = [];
  const out = await collectPaged(async (from, limit) => {
    calls.push([from, limit]);
    return rows.slice(from, from + limit);
  }, { pageSize: 1000 });

  assert.deepEqual(calls, [[0, 1000], [1000, 1000], [2000, 1000]]);
  assert.equal(out.length, 2500);
  const last = out[2499];
  assert.ok(last !== undefined);
  assert.equal(last.slug, 's2499');
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

// ---- SEO batch 2026-09-17: non-empty category+brand combo pairs -------------
// Owner decision 2026-09-17: non-empty combos enter the sitemap, restoring
// «indexable set = sitemap set» (lib/seo.ts). A pair (C, brand) is non-empty
// exactly when C's subtree holds ≥1 eligible product of that brand — derived
// from the SAME product rows the sitemap already reads (brand_id ×
// category_ids, ancestors via parent_id), zero extra queries.

test('SITEMAP-COMBO: direct pair plus ancestors inherit the assignment', () => {
  // root r1 → child c1 → leaf l1 (assigned); r2 fully empty.
  const categories = [
    { id: 'r1', parent_id: null },
    { id: 'c1', parent_id: 'r1' },
    { id: 'l1', parent_id: 'c1' },
    { id: 'r2', parent_id: null },
  ];
  const out = collectNonEmptyComboPairs(categories, [
    { brand_id: 'b1', category_ids: ['l1'], updated_at: '2026-09-01T00:00:00Z' },
  ]);
  const keys = [...out.values()].map((p) => `${p.categoryId}×${p.brandId}`).sort();
  assert.deepEqual(keys, ['c1×b1', 'l1×b1', 'r1×b1'],
    'the pair must exist on the leaf AND every ancestor; sibling r2 stays out');
});

test('SITEMAP-COMBO: brandless product contributes no pairs', () => {
  const out = collectNonEmptyComboPairs(
    [{ id: 'c1', parent_id: null }],
    [{ brand_id: null, category_ids: ['c1'], updated_at: '2026-09-01T00:00:00Z' }]
  );
  assert.equal(out.size, 0);
});

test('SITEMAP-COMBO: unknown category ids are ignored', () => {
  const out = collectNonEmptyComboPairs(
    [{ id: 'c1', parent_id: null }],
    [{ brand_id: 'b1', category_ids: ['ghost'], updated_at: '2026-09-01T00:00:00Z' }]
  );
  assert.equal(out.size, 0, 'pairs are built only from ACTIVE category slugs');
});

test('SITEMAP-COMBO: cycle-safe parent walk', () => {
  const categories = [
    { id: 'x', parent_id: 'y' },
    { id: 'y', parent_id: 'x' },
  ];
  const out = collectNonEmptyComboPairs(categories, [
    { brand_id: 'b1', category_ids: ['x'], updated_at: '2026-09-01T00:00:00Z' },
  ]);
  assert.equal(out.size, 2, 'cycle must terminate with exactly the two nodes');
  const keys = [...out.values()].map((p) => p.categoryId).sort();
  assert.deepEqual(keys, ['x', 'y']);
});

test('SITEMAP-COMBO: pairs dedupe across products and shared ancestors', () => {
  const categories = [
    { id: 'p', parent_id: null },
    { id: 'leaf', parent_id: 'p' },
  ];
  const out = collectNonEmptyComboPairs(categories, [
    // Both products land on the (p, b1) pair — via p directly and via the
    // leaf's ancestor walk; the pair must stay a SINGLE entry.
    { brand_id: 'b1', category_ids: ['p'], updated_at: '2026-09-01T00:00:00Z' },
    { brand_id: 'b1', category_ids: ['leaf'], updated_at: '2026-09-05T00:00:00Z' },
    { brand_id: 'b2', category_ids: ['leaf'], updated_at: '2026-09-02T00:00:00Z' },
  ]);
  assert.equal(out.size, 4, 'exactly (p,b1), (leaf,b1), (leaf,b2), (p,b2)');
  const keys = [...out.values()]
    .map((pair) => `${pair.categoryId}×${pair.brandId}`)
    .sort();
  assert.deepEqual(keys, ['leaf×b1', 'leaf×b2', 'p×b1', 'p×b2']);
  const pB1 = out.get('p\u0000b1');
  assert.ok(pB1, '(p,b1) must exist');
  assert.equal(Date.parse(pB1.lastUpdated), Date.parse('2026-09-05T00:00:00Z'),
    'lastModified must be the MAX updated_at of the contributing products');
});

test('SITEMAP-COMBO: empty inputs stay empty', () => {
  assert.equal(collectNonEmptyComboPairs([], []).size, 0);
  assert.equal(
    collectNonEmptyComboPairs([{ id: 'c1', parent_id: null }], []).size,
    0
  );
});

test('SITEMAP-COMBO: combo entries are wired into sitemap.ts (source-level)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(
    src,
    /collectNonEmptyComboPairs/,
    'combo entries must derive through the pure helper'
  );
  assert.match(
    src,
    /\/catalog\/\$\{encodeURIComponent\(category\.slug\)\}\?brand=\$\{encodeURIComponent\(brand\.slug\)\}/,
    'combo URL must use the canonical form /catalog/<cat>?brand=<brand> (lib/seo.ts)'
  );
});

// ---- audit R15 2026-09-15: image sitemap -------------------------------------

test('SITEMAP-R15: product entries carry the main product image (image sitemap)', () => {
  const src = readFileSync('app/sitemap.ts', 'utf8');
  assert.match(
    src,
    /images:product_images!inner\(image_url, is_main\)/,
    'the product read must fetch the image rows it already joins'
  );
  assert.match(
    src,
    /getPublicImageUrl/,
    'image URLs must resolve to absolute public URLs (same resolver as the gallery)'
  );
  assert.match(
    src,
    /images:\s*\[mainImageUrl\]/,
    'product entries must carry the images array'
  );
});
