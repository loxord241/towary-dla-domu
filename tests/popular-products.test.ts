/**
 * «Популярні товари» on the home page.
 *
 * Data contract (REVISED 2026-08-26, supersedes the Stage-11 fallback):
 * no reliable popularity signal exists yet, so the shelf shows EXACTLY the
 * admin-curated `is_featured` products — NO newest-arrivals fill. If more
 * than 8 are flagged, the first 8 in deterministic order win and data is
 * never changed automatically. Zero featured ⇒ the home page hides the
 * whole section. Single bounded read (.range(0..7)) — never a full scan.
 * JSX is not executable in node:test (established pattern), so these pin
 * source invariants of app/lib/catalog.ts and app/(home)/page.tsx.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- data layer: bounded featured-only fetch ----

test('POPULAR: catalog exports fetchPopularProducts reading real products', () => {
  const lib = src('app/lib/catalog.ts');
  assert.match(lib, /export async function fetchPopularProducts/);
  // real table + real eligibility join, no mock/test fixtures
  assert.match(lib, /\.from\('products'\)/);
  assert.match(lib, /PRODUCT_SELECT/, 'must reuse the shared eligibility select');
});

test('POPULAR: featured-only leg with stable ordering (NO fallback fill)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(
    lib.indexOf('async function fetchPopularProducts'),
    lib.indexOf('export async function fetchActiveCategories')
  );
  assert.ok(fn.length > 0 && fn.length < 4000, 'function must stay local');
  assert.match(fn, /\.eq\('is_featured', true\)/);
  assert.match(fn, /created_at/, 'existing date field orders the shelf');
  assert.match(fn, /\.order\('id'/, 'id tiebreaker required for bulk imports');
  assert.doesNotMatch(
    fn,
    /\.eq\('is_featured', false\)|\.neq\('is_featured'|\bremaining\b/,
    'fallback-to-newest was REMOVED by decision 2026-08-26'
  );
});

test('POPULAR: single bounded window, not a paged scan', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(
    lib.indexOf('async function fetchPopularProducts'),
    lib.indexOf('export async function fetchActiveCategories')
  );
  const ranges = fn.match(/\.range\(/g) ?? [];
  assert.equal(ranges.length, 1, 'exactly one bounded window');
  assert.doesNotMatch(fn, /for\s*\(\s*;;\)/, 'no unbounded pagination loop');
  assert.match(fn, /\.range\(0,\s*[A-Za-z]/, 'window derives from the limit cap');
});

test('POPULAR: limit is clamped to a safe constant (bounded DB read)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(
    lib.indexOf('async function fetchPopularProducts'),
    lib.indexOf('export async function fetchActiveCategories')
  );
  assert.match(fn, /POPULAR_(MAX_|)LIMIT|Math\.min\(/, 'needs an explicit cap');
});

test('POPULAR: excludeIds filters IN SQL, before the bounded window (dedupe + backfill)', () => {
  // 2026-09 audit: a product flagged both is_selected and is_featured used
  // to render on BOTH home shelves. The exclusion must happen via a PostgREST
  // not-in filter applied BEFORE .range(), so the window still yields `take`
  // rows (backfilled from the next featured candidates) — and it must stay a
  // SINGLE bounded read.
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(
    lib.indexOf('async function fetchPopularProducts'),
    lib.indexOf('export async function fetchActiveCategories')
  );
  assert.match(fn, /excludeIds:\s*string\[\]\s*=\s*\[\]/, 'excludeIds parameter exists');
  assert.match(fn, /if \(excludeIds\.length > 0\)/, 'no-op when nothing to exclude');
  assert.match(fn, /\.not\('id', 'in', `\(\$\{excludeIds\.join\(','\)\}\)`\)/,
    'PostgREST not-in list over the ids');
  // exclusion must be chained BEFORE the terminal range window
  const notIdx = fn.indexOf(".not('id', 'in'");
  const rangeIdx = fn.indexOf('.range(');
  assert.ok(notIdx !== -1 && rangeIdx !== -1 && notIdx < rangeIdx,
    'not-in filter precedes the window');
  assert.equal((fn.match(/\.range\(/g) ?? []).length, 1,
    'still exactly one bounded window');
  // featured-first contract untouched
  assert.match(fn, /\.eq\('is_featured', true\)/);
  assert.doesNotMatch(fn, /\.neq\('is_featured'|\bremaining\b/);
});

test('POPULAR: errors propagate honestly (no silent empty shelf)', () => {
  const lib = src('app/lib/catalog.ts');
  const fn = lib.slice(
    lib.indexOf('async function fetchPopularProducts'),
    lib.indexOf('export async function fetchActiveCategories')
  );
  assert.match(fn, /throw new Error/, 'data error must reach error boundary');
});

// ---- presentation: home page section ----

test('POPULAR: home renders «Популярні товари» using ProductCard grid', () => {
  const page = src('app/(home)/page.tsx');
  assert.match(page, /Популярні товари/);
  // Extended 2026-09: the call now passes (limit, excludeIds) so products
  // already shown on the «Обрані» shelf are deduped out of «Популярні» —
  // the featured-first contract itself is unchanged.
  assert.match(page, /fetchPopularProducts\(/);
  assert.match(page, /<ProductCard\b/, 'must use the existing ProductCard');
  assert.match(page, /grid grid-cols-2|grid-cols-1 sm:grid-cols-2 lg:grid-cols-4/,
    'grid must be responsive mobile→desktop');
});

test('POPULAR: home hides the whole section when nothing is featured', () => {
  const page = src('app/(home)/page.tsx');
  assert.match(page, /popularProducts\.length > 0 && \(/, 'conditional render');
});

test('POPULAR: existing «Обрані товари» block survives unchanged', () => {
  const page = src('app/(home)/page.tsx');
  // Superseded 2026-08-28: the first home section is now driven by the
  // independent is_selected flag (migration 028), NOT by is_featured —
  // see curated-selected.test.ts.
  assert.match(page, /Обрані товари/);
  assert.match(page, /fetchSelectedProducts\(\)/);
  assert.match(page, /Добірка найкращих товарів/, 'empty-state promo banner kept');
});

test('POPULAR: no mock or hardcoded product names on the home page', () => {
  const page = src('app/(home)/page.tsx');
  assert.doesNotMatch(page, /Test|Mock|Lorem|FIXME/i);
});
