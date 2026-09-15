/**
 * Owner bug report 2026-09-15: «сортировка каталога через раз работает —
 * сортирую по цене и не всегда правильно».
 *
 * ROOT (investigation on pkg/catalog-sort-fix): since the ISR split
 * (b3afd68) /catalog/<slug> is a FULLY STATIC route whose query views are
 * served by a hidden force-dynamic twin (proxy rewrite, invisible to the
 * client router). Next 16.3.5's client segment cache prefetches static
 * routes IN FULL and keys their page segments so they are «reusable across
 * all possible search param values» (segment-cache/vary-path.js — search →
 * Fallback). A soft navigation (router.push) to /catalog/<slug>?sort=… has
 * no exact prefetch entry, so navigateImpl falls to the OPTIMISTIC route
 * prediction (enabled by default: experimental.optimisticRouting = true in
 * 16.3.5), which matches the learned route pattern BY PATHNAME ONLY
 * (segment-cache/optimistic-routes.js matchKnownRoute) and renders the
 * cached PURE page — default order, noindex-free metadata — with NO server
 * request. The proxy twin never runs. When the pattern is stale (~60s ISR
 * window) or not yet learned, the navigation block-fetches and the twin
 * sorts correctly — hence «через раз». Document loads (F5, Playwright
 * gotos) always fetch and were always correct, matching the live-prod
 * facts.
 *
 * FIX CONTRACT: sort changes on the ISR category PATH form must be DOCUMENT
 * navigations (window.location.assign) so every request reaches the server
 * (proxy → dynamic twin → sorted HTML). The legacy bare /catalog form is a
 * DYNAMIC route — its shell prefetch cannot satisfy a query-carrying page
 * segment, the router fetches per request, and router.push stays.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isSortDocumentNavigation,
  buildSortSearchParams,
} from '../app/lib/filter-url.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- 1. the pure decision (app/lib/filter-url.ts)

test('SORT-NAV: ISR category path pages sort via a document request', () => {
  // Path form → static ISR route → router.push would render the predicted
  // pure view for ?sort=… — must be a document navigation instead.
  assert.equal(isSortDocumentNavigation('/catalog/kukhonni-aksesuary-1348'), true);
  assert.equal(isSortDocumentNavigation('/catalog/velyka-pobutova-tekhnika-739'), true);
  assert.equal(isSortDocumentNavigation('/catalog/kat%20z%20probilom'), true);

  // Legacy bare /catalog is a DYNAMIC route: the router fetches per request,
  // so the cheaper soft navigation is correct there.
  assert.equal(isSortDocumentNavigation('/catalog'), false);
});

// ---- 2. the wiring (app/catalog/SortSelect.tsx)

test('SORT-NAV: SortSelect routes ISR path-form sort changes through location.assign', () => {
  const select = src('app/catalog/SortSelect.tsx');
  // The document navigation primitive is present and gated by the predicate…
  assert.match(select, /window\.location\.assign\(/);
  assert.match(select, /isSortDocumentNavigation\(/);
  // …and the predicate decides BETWEEN the two navigation kinds (if/else),
  // so router.push can never fire for the ISR path form.
  assert.match(
    select,
    /if \(isSortDocumentNavigation\(basePath\)\)\s*\{[\s\S]*?window\.location\.assign\([\s\S]*?\)\s*;\s*\}\s*else\s*\{[\s\S]*?router\.push\(/,
    'router.push must be reachable only for the dynamic /catalog form'
  );
});

test('SORT-NAV: SortSelect keeps building the shared sort URL contract', () => {
  const select = src('app/catalog/SortSelect.tsx');
  // The URL itself must stay on the single tested builder (page=1 reset,
  // carried params) — the fix changes HOW the navigation happens, not WHERE.
  assert.match(select, /buildSortSearchParams\(searchParams/);
  assert.match(select, /basePath\}\?\$\{qs\}` : basePath/);
});

// ---- 3. regression guards on the unchanged URL contract

test('SORT-NAV: buildSortSearchParams still resets to page 1 and carries params', () => {
  const qs = buildSortSearchParams(
    new URLSearchParams('sort=price_asc&min=10&stock=1&page=3'),
    'price_desc'
  );
  const params = new URLSearchParams(qs);
  assert.equal(params.get('sort'), 'price_desc');
  assert.equal(params.get('page'), '1');
  assert.equal(params.get('min'), '10');
  assert.equal(params.get('stock'), '1');

  // 'newest' removes the explicit sort but keeps the page-1 reset.
  const back = new URLSearchParams(
    buildSortSearchParams(new URLSearchParams('sort=price_asc'), 'newest')
  );
  assert.equal(back.get('sort'), null);
  assert.equal(back.get('page'), '1');
});

test('SORT-NAV: CatalogView still passes the path-form base to SortSelect', () => {
  const view = src('app/catalog/CatalogView.tsx');
  // linkBase is the encoded path form on [category] and /catalog on the
  // legacy route — the predicate consumes exactly this value.
  assert.match(view, /<SortSelect basePath=\{linkBase\} \/>/);
  assert.match(
    view,
    /linkBase = pathCategorySlug\s*\?\s*`\/catalog\/\$\{encodeURIComponent\(pathCategorySlug\)\}`\s*:\s*'\/catalog'/
  );
});
