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
