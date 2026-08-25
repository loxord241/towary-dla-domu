/**
 * «Популярні товари» on the home page.
 *
 * Data contract (approved 2026-08): no reliable popularity signal is
 * readable by the storefront (order_items empty; product_stock_history
 * RLS-blocked for anon), so the block = curated `is_featured` items first,
 * topped up with the newest non-featured products by the existing
 * `created_at` field. Both reads are BOUNDED (range 0..limit-1) — never a
 * full-table scan. JSX is not executable in node:test (established
 * pattern), so these pin source invariants of app/lib/catalog.ts and
 * app/(home)/page.tsx.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- data layer: bounded featured-first + newest-fallback fetch ----

test('POPULAR: catalog exports fetchPopularProducts reading real products', () => {
  const lib = src('app/lib/catalog.ts');
  assert.match(lib, /export async function fetchPopularProducts/);
  // real table + real eligibility join, no mock/test fixtures
  assert.match(lib, /\.from\('products'\)/);
  assert.match(lib, /PRODUCT_SELECT/, 'must reuse the shared eligibility select');
});

test('POPULAR: featured leg filters is_featured=true with stable ordering', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  assert.ok(fn.length > 0 && fn.length < 4000, 'function must stay local');
  assert.match(fn, /\.eq\('is_featured', true\)/);
  assert.match(fn, /created_at/, 'existing date field orders the shelf');
  assert.match(fn, /\.order\('id'/, 'id tiebreaker required for bulk imports');
});

test('POPULAR: fallback leg takes newest non-featured products only when short', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  assert.match(fn, /is_featured[^]*?false|neq\('is_featured'/, 
    'fallback must exclude featured rows so nothing duplicates');
  assert.match(
    fn,
    /remaining|shortfall|limit\s*-\s*featured|featured\.length/,
    'fallback size must be computed from what featured actually returned'
  );
});

test('POPULAR: both legs are range-bounded, not paged full scans', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  const ranges = fn.match(/\.range\(/g) ?? [];
  assert.ok(ranges.length >= 2, 'featured and fallback each need a bound');
  assert.doesNotMatch(fn, /for\s*\(\s*;;\)/, 'no unbounded pagination loop');
  // every window starts at 0 and ends inside the limit budget
  assert.match(fn, /\.range\(0,\s*[A-Za-z]/, 'windows must derive from the limit cap');
});

test('POPULAR: limit is clamped to a safe constant (bounded DB read)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  assert.match(fn, /POPULAR_(MAX_|)LIMIT|Math\.min\(/, 'needs an explicit cap');
});

test('POPULAR: errors propagate honestly (no silent empty shelf)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(lib.indexOf('fetchPopularProducts'));
  assert.match(fn, /throw new Error/, 'data error must reach error boundary');
});

// ---- presentation: home page section ----

test('POPULAR: home renders «Популярні товари» section using ProductCard grid', () => {
  const page = src('app/(home)/page.tsx');
  assert.match(page, /Популярні товари/);
  assert.match(page, /fetchPopularProducts\(\)/);
  const section = page.slice(page.indexOf('Популярні товари') - 400);
  assert.match(section, /<ProductCard\b/, 'must use the existing ProductCard');
  assert.match(page, /grid-cols-1 sm:grid-cols-2 lg:grid-cols-4|grid grid-cols-2/,
    'grid must be responsive mobile→desktop');
});

test('POPULAR: existing «Вибрані товари» block survives unchanged', () => {
  const page = src('app/(home)/page.tsx');
  assert.match(page, /Вибрані товари/);
  assert.match(page, /fetchFeaturedProducts\(\)/);
  assert.match(page, /Добірка найкращих товарів/, 'empty-state promo banner kept');
});

test('POPULAR: no mock or hardcoded product names on the home page', () => {
  const page = src('app/(home)/page.tsx');
  assert.doesNotMatch(page, /Test|Mock|Lorem|FIXME/i);
});
