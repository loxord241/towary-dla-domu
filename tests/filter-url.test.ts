/**
 * Pure URL-building for the catalog filter apply/reset actions.
 *
 * Contract (2026-08 UX stage):
 *  - applying filters PRESERVES the active search term (q) and sort,
 *    which the previous inline implementation silently dropped;
 *  - applying always resets to page 1 (the result set changed);
 *  - empty draft values are omitted, cleared filters are removed;
 *  - reset returns the bare /catalog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFilterSearchParams,
  buildFilterUrl,
  buildSortSearchParams,
} from '../app/lib/filter-url.ts';

function paramsOf(url: string): URLSearchParams {
  const qs = url.startsWith('/catalog?') ? url.slice('/catalog?'.length) : '';
  return new URLSearchParams(qs);
}

test('FILTER-URL: apply preserves q and sort from the current view', () => {
  const current = new URLSearchParams('q=щітка&sort=price_asc&category=old');
  const url = buildFilterUrl(current, { brandSlug: 'tefal' });
  const p = paramsOf(url);
  assert.equal(p.get('q'), 'щітка', 'search term must survive apply');
  assert.equal(p.get('sort'), 'price_asc', 'sort must survive apply');
  assert.equal(p.get('brand'), 'tefal');
  assert.equal(p.get('category'), null, 'cleared category must be dropped');
});

test('FILTER-URL: apply never carries the old page number', () => {
  const current = new URLSearchParams('q=x&page=7&brand=a');
  const url = buildFilterUrl(current, { brandSlug: 'a' });
  assert.equal(paramsOf(url).get('page'), null, 'apply must land on page 1');
});

test('FILTER-URL: empty draft and no active params yields the bare /catalog', () => {
  assert.equal(buildFilterUrl(new URLSearchParams(''), {}), '/catalog');
});

test('FILTER-URL: apply keeps q even when every filter group is cleared', () => {
  // Clearing filters is not clearing the search — «Скинути» does that.
  assert.equal(
    buildFilterUrl(new URLSearchParams('q=x'), {
      categorySlug: '',
      brandSlug: '',
      minPrice: '',
      maxPrice: '',
      inStockOnly: false,
    }),
    '/catalog?q=x'
  );
});

test('FILTER-URL: numeric price bounds are set as given; garbage is omitted', () => {
  const url = buildFilterUrl(new URLSearchParams(''), {
    minPrice: '12.5',
    maxPrice: '999',
  });
  const p = paramsOf(url);
  assert.equal(p.get('min'), '12.5');
  assert.equal(p.get('max'), '999');

  const bad = paramsOf(
    buildFilterUrl(new URLSearchParams(''), { minPrice: 'abc' })
  );
  assert.equal(bad.get('min'), null);
});

test('FILTER-URL: in-stock toggle maps to stock=1 only when true', () => {
  assert.equal(paramsOf(buildFilterUrl(new URLSearchParams(''), { inStockOnly: true })).get('stock'), '1');
  assert.equal(paramsOf(buildFilterUrl(new URLSearchParams('stock=1'), {})).get('stock'), null);
});

test('FILTER-URL: querystring-only variant mirrors the URL variant', () => {
  const current = new URLSearchParams('q=тесто&sort=name_asc');
  const qs = buildFilterSearchParams(current, { categorySlug: 'formochky' });
  assert.ok(!qs.includes('/catalog'), 'raw searchparams builder returns no path');
  assert.equal(new URLSearchParams(qs).get('category'), 'formochky');
  assert.equal(new URLSearchParams(qs).get('q'), 'тесто');
});

/**
 * Sort URL contract (2026-08-27 UX/security stage): changing sort on a
 * paginated view MUST reset to page 1 — the old behavior kept
 * ?page=2&sort=price_asc, which showed an arbitrary slice of the new
 * ordering. Unlike filter apply (which DROPS page), the sort contract
 * explicitly emits page=1 so the resulting URL is unambiguous.
 */

function sortParamsOf(current: string, value: string): URLSearchParams {
  return new URLSearchParams(buildSortSearchParams(new URLSearchParams(current), value));
}

test('SORT-URL: changing sort while on page 2 resets the result to page 1', () => {
  // Regression for the live bug: ?page=2 + price_asc kept page=2.
  const p = sortParamsOf('page=2&sort=newest', 'price_asc');
  assert.equal(p.get('page'), '1', 'sort change must land on page 1');
  assert.equal(p.get('sort'), 'price_asc');
});

test('SORT-URL: explicit page=1 is emitted even when it was absent', () => {
  const p = sortParamsOf('', 'name_asc');
  assert.equal(p.get('page'), '1');
  assert.equal(p.get('sort'), 'name_asc');
});

test('SORT-URL: picking default «newest» removes sort but still lands on page 1', () => {
  const p = sortParamsOf('page=3&sort=price_desc&q=тесто', 'newest');
  assert.equal(p.get('page'), '1');
  assert.equal(p.get('sort'), null);
});

test('SORT-URL: sort change preserves all other catalog params', () => {
  const p = sortParamsOf(
    'page=4&q=щітка&category=blendery&brand=tefal&min=100&max=900&stock=1',
    'price_asc'
  );
  assert.equal(p.get('q'), 'щітка');
  assert.equal(p.get('category'), 'blendery');
  assert.equal(p.get('brand'), 'tefal');
  assert.equal(p.get('min'), '100');
  assert.equal(p.get('max'), '900');
  assert.equal(p.get('stock'), '1');
});

test('SORT-URL: unknown non-page params are carried through untouched', () => {
  // Existing URL contract: the sort control round-trips whatever was in
  // the address bar (utm tags etc.) — only sort/page semantics change.
  const p = sortParamsOf('page=2&utm_source=x', 'price_desc');
  assert.equal(p.get('page'), '1');
  assert.equal(p.get('sort'), 'price_desc');
  assert.equal(p.get('utm_source'), 'x');
});
