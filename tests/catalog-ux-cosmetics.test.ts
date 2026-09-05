/**
 * Source invariants for the 2026-09-05 catalog UX audit batch (low
 * priority items 1–4). Same constraint as ux-fixes.test.ts: JSX client
 * components are not unit-mountable in node:test, so the behavior is
 * pinned on the SOURCE level.
 *
 *  1. «Фільтри» badge counts filter chips only — the search term q is not
 *     a filter (its own chip removes it).
 *  2. «Скинути» clears the filters but keeps the search term: reset
 *     routes through buildFilterUrl with an empty draft. Full reset incl.
 *     search stays the page-level «Скинути всі» chip (/catalog).
 *  3. AddToCartButton hides «макс. N» while no variant is selected
 *     (effectiveStock === null — showing MAX_QTY would be a lie).
 *  4. min > max price range: inline hint near the fields, apply skips
 *     the navigation (mobile sheet stays open).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

// ---- item 1: badge excludes the search chip ----

test('BADGE: «Фільтри» activeCount counts filter chips only, not q', () => {
  const catalog = src('app/catalog/page.tsx');
  assert.match(catalog, /removeKey !== 'q'/,
    'badge count must exclude the search chip');
  assert.match(catalog, /activeCount=\{filterChipCount\}/,
    'CatalogFilters must receive the filter-only count');
  assert.ok(!catalog.includes('activeCount={chips.length}'),
    'raw chips.length (which includes q) must not come back');
});

// ---- item 2: reset keeps the search term ----

test('RESET: «Скинути» preserves q via buildFilterUrl with an empty draft', () => {
  const filters = src('app/catalog/CatalogFilters.tsx');
  assert.match(filters, /buildFilterUrl\(searchParams, \{\}\)/,
    'reset must reuse the shared URL contract (q+sort preserved)');
  assert.ok(
    !/router\.push\(['"`]\/catalog['"`]\)/.test(filters),
    'bare /catalog push retired — it silently dropped the search term'
  );
});

test('RESET: full reset (incl. search) stays on the page as «Скинути всі»', () => {
  const catalog = src('app/catalog/page.tsx');
  assert.match(catalog, /Скинути всі/);
  assert.match(catalog, /href="\/catalog"/);
});

// ---- item 3: «макс. N» hidden without a selected variant ----

test('MAX-HINT: stock caption renders only when effectiveStock is known', () => {
  const btn = src('app/components/AddToCartButton.tsx');
  assert.match(
    btn,
    /effectiveStock !== null && \([\s\S]*?макс\. \{maxQty\}/,
    'the caption must be guarded by the null sentinel'
  );
});

// ---- item 4: min > max validation ----

test('PRICE: min>max shows an inline hint and blocks apply/navigation', () => {
  const filters = src('app/catalog/CatalogFilters.tsx');
  assert.match(filters, /priceRangeInvalid/);
  assert.match(filters, /role="alert"/, 'hint must be announced');
  assert.match(filters, /aria-invalid=\{priceRangeInvalid \|\| undefined\}/,
    'both price inputs are marked aria-invalid');
  // apply guards: desktop submit AND the mobile sheet stay on the page
  const guards = filters.match(/if \(priceRangeInvalid\) return;/g) ?? [];
  assert.ok(guards.length >= 2,
    'both applyFilters and applyAndClose must skip the dead URL');
});
