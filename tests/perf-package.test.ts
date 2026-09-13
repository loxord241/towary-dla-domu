/**
 * Perf package (2026-09-13) regression pins:
 *  1. count+data merge — the NO-SEARCH catalog path and the whole /oboi
 *     listing fetch total + page rows in ONE PostgREST request
 *     (select with count:'exact', total parsed from Content-Range); the
 *     SEARCH path keeps the sequential head-count flow (the zero-result
 *     fallbacks and the ranked scan window need the total up front);
 *  2. route-level loading.tsx skeletons exist for the two slowest
 *     storefront segments (/product/[slug], /oboi) and mirror the
 *     catalog skeleton pattern.
 *
 * Source-level pins (JSX and PostgREST wire behavior are pinned at source
 * and via the runtime fake-PostgREST tests in
 * oboi-filters-lightbox/wallpapers-storefront respectively).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), 'utf8');

// ---- 1. merged count+data requests -----------------------------------------

test('PERF-MERGE: /oboi fetches total + page in ONE request (no head-count)', () => {
  const src = read('app/lib/catalog/wallpaper-listing.ts');
  assert.match(src, /\.select\(CATALOG_CARD_SELECT, \{ count: 'exact' \}\)/);
  assert.doesNotMatch(src, /head:\s*true/, 'head-count round-trip must be gone');
  assert.match(src, /count \?\? 0/, 'total comes from the merged response');
  // Clamp contract: an out-of-range page replays ONCE on the clamped page.
  assert.match(src, /page !== requestedPage/, 'clamp-replay guard present');
});

test('PERF-MERGE: catalog NO-SEARCH path is merged; SEARCH path keeps its count flow', () => {
  const src = read('app/lib/catalog/listing.ts');

  // Merged branch: the shared data query carries count:'exact' when the
  // caller asks for it, and the no-search path consumes that total.
  assert.match(src, /withCount \? \{ count: 'exact' as const \} : undefined/);
  assert.match(src, /buildDataQuery\(null, false, true\)/,
    'no-search path must use the merged count+data request');
  assert.match(src, /const total = first\.count \?\? 0;/);

  // Search branch: sequential head-count retained for the fallback probes.
  assert.match(src, /head: true/, 'search path keeps the head-count');
  assert.match(src, /buildCountQuery\(searchConditions\)/);
});

// ---- 2. route-level loading skeletons ---------------------------------------

test('PERF-LOADING: /product/[slug] has a skeleton mirroring the PDP layout', () => {
  const file = 'app/product/[slug]/loading.tsx';
  assert.ok(existsSync(path.join(root, file)), `${file} must exist`);
  const src = read(file);
  assert.doesNotMatch(src, /'use client'/, 'server component (instant static shell)');
  assert.equal((src.match(/<main/g) ?? []).length, 1,
    'exactly one <main>, same landmark count as the page');
  assert.doesNotMatch(src, /<h1/, 'no heading in the fallback (h1 belongs to the page)');
  assert.ok(src.includes('.skeleton'), 'reuses the shared skeleton utility');
  // PDP shape: breadcrumb strip + two-column gallery/buy-box + description.
  for (const marker of ['mb-5', 'md:grid-cols-2']) {
    assert.ok(src.includes(marker), `PDP layout marker missing: ${marker}`);
  }
});

test('PERF-LOADING: /oboi has a skeleton mirroring the wallpaper storefront', () => {
  const file = 'app/oboi/loading.tsx';
  assert.ok(existsSync(path.join(root, file)), `${file} must exist`);
  const src = read(file);
  assert.doesNotMatch(src, /'use client'/, 'server component (instant static shell)');
  assert.equal((src.match(/<main/g) ?? []).length, 1,
    'exactly one <main>, same landmark count as the page');
  assert.doesNotMatch(src, /<h1/, 'no heading in the fallback (h1 belongs to the page)');
  assert.ok(src.includes('.skeleton'), 'reuses the shared skeleton utility');
  // /oboi shape: white card with title row, sort area, chips row, grid.
  for (const marker of ['rounded-lg shadow p-6', 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3']) {
    assert.ok(src.includes(marker), `/oboi layout marker missing: ${marker}`);
  }
});

test('PERF-LOADING: the catalog skeleton pattern both new files reuse still exists', () => {
  // The skeletons were adapted from app/catalog/loading.tsx — if the source
  // pattern is renamed/moved, the copies must follow deliberately.
  assert.ok(existsSync(path.join(root, 'app/catalog/loading.tsx')),
    'app/catalog/loading.tsx must exist (template of the new skeletons)');
});
