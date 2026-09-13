/**
 * Pure SEO decision layer: canonical/noindex policy for /catalog views,
 * query truncation, and per-view metadata builders (spec 2026-08-26 B/G).
 * Policy invariant: the INDEXABLE set is exactly the sitemap set —
 * bare /catalog plus single valid category/brand views on page 1
 * with default sort and no other filters. Everything else: noindex,follow,
 * and canonical is emitted ONLY on indexable URLs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SITE_NAME,
  decideCatalogIndexing,
  truncateQuery,
  buildCatalogViewMetadata,
} from '../app/lib/seo.ts';

function dec(over: Partial<Parameters<typeof decideCatalogIndexing>[0]> = {}) {
  return decideCatalogIndexing(over);
}

test('SEO: bare /catalog is indexable with self canonical', () => {
  assert.deepEqual(dec(), { indexable: true, canonicalPath: '/catalog' });
});

test('SEO: single valid category view is indexable, canonical carries encoded slug', () => {
  const r = dec({ categorySlug: 'blendery-1402', categoryFound: true });
  assert.equal(r.indexable, true);
  // 2026-09-13: path form is THE canonical; the ?category= query form
  // 308-redirects to /catalog/<slug> (proxy.ts).
  assert.equal(r.canonicalPath, '/catalog/blendery-1402');
});

test('SEO: single valid brand view is indexable', () => {
  const r = dec({ brandSlug: 'tefal', brandFound: true });
  assert.deepEqual(r, { indexable: true, canonicalPath: '/catalog?brand=tefal' });
});

test('SEO: unknown/inactive category or brand slug → noindex without canonical', () => {
  for (const input of [
    { categorySlug: 'bogus', categoryFound: false },
    { brandSlug: 'bogus', brandFound: false },
    { categorySlug: 'bogus' }, // missing flag counts as not found
    { brandSlug: 'bogus' },
  ]) {
    const r = dec(input);
    assert.equal(r.indexable, false, JSON.stringify(input));
    assert.equal(r.canonicalPath, null);
  }
});

test('SEO: search views are never indexable', () => {
  const r = dec({ search: 'щітка', categorySlug: 'c', categoryFound: true });
  assert.equal(r.indexable, false);
  assert.equal(r.canonicalPath, null);
});

test('SEO: empty category (0 eligible products) → noindex without canonical', () => {
  const r = dec({ categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: false });
  assert.equal(r.indexable, false, 'empty category must not be indexable');
  assert.equal(r.canonicalPath, null);
});

test('SEO: empty brand (0 eligible products) → noindex without canonical', () => {
  const r = dec({ brandSlug: 'tefal', brandFound: true, brandHasProducts: false });
  assert.equal(r.indexable, false, 'empty brand must not be indexable');
  assert.equal(r.canonicalPath, null);
});

test('SEO: non-empty category/brand stay indexable when the fact is present', () => {
  const c = dec({ categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: true });
  assert.deepEqual(c, { indexable: true, canonicalPath: '/catalog/blendery-1402' });
  const b = dec({ brandSlug: 'tefal', brandFound: true, brandHasProducts: true });
  assert.deepEqual(b, { indexable: true, canonicalPath: '/catalog?brand=tefal' });
});

test('SEO: missing product-count fact keeps legacy behavior (undefined = treated non-empty)', () => {
  const c = dec({ categorySlug: 'blendery-1402', categoryFound: true });
  assert.equal(c.indexable, true);
  assert.equal(c.canonicalPath, '/catalog/blendery-1402');
});

test('SEO: metadata builder emits noindex for the empty-category fact', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true, categoryHasProducts: false },
    categoryName: 'Блендери',
  });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined, 'noindex views never carry a canonical');
});

test('SEO: filter combinations break indexability', () => {
  const combos: Parameters<typeof decideCatalogIndexing>[0][] = [
    { categorySlug: 'c', categoryFound: true, brandSlug: 'b', brandFound: true },
    { categorySlug: 'c', categoryFound: true, minPrice: 10 },
    { categorySlug: 'c', categoryFound: true, maxPrice: 10 },
    { categorySlug: 'c', categoryFound: true, inStockOnly: true },
    { categorySlug: 'c', categoryFound: true, sort: 'price_asc' },
    { categorySlug: 'c', categoryFound: true, page: 2 },
    { brandSlug: 'b', brandFound: true, sort: 'name_asc' },
  ];
  for (const input of combos) {
    assert.equal(dec(input).indexable, false, JSON.stringify(input));
    assert.equal(dec(input).canonicalPath, null);
  }
});

test('SEO: truncateQuery strips control chars, collapses whitespace, caps length', () => {
  assert.equal(truncateQuery('  a\t\nb  ', 10), 'a b');
  assert.equal(truncateQuery('x\u0000y', 10), 'xy');
  assert.equal(truncateQuery('ж'.repeat(80)), 'ж'.repeat(50));
  assert.equal(truncateQuery(''), '');
  assert.equal(truncateQuery('%,(")'), '', 'specials-only query collapses to nothing');
});

test('SEO: metadata builder — category title follows «X — купити в Товари для дому»', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.equal(m.title, 'Блендери — купити в Товари для дому');
  assert.ok(String(m.description).includes('Блендери'));
  assert.ok(!m.robots, 'indexable view emits no robots override');
  assert.deepEqual(m.alternates, { canonical: '/catalog/blendery-1402' });
});

test('SEO: metadata builder — brand title and search title', () => {
  const b = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.equal(b.title, 'TEFAL — купити в Товари для дому');

  const s = buildCatalogViewMetadata({ input: { search: 'мультипіч tefal' } });
  assert.equal(s.title, 'Пошук: «мультипіч tefal» | Товари для дому');
  assert.deepEqual(s.robots, { index: false, follow: true });
  assert.equal(s.alternates, undefined);
});

test('SEO: long search query is truncated inside title, never throws', () => {
  const s = buildCatalogViewMetadata({ input: { search: 'ж'.repeat(200) } });
  const title = String(s.title);
  assert.ok(title.length <= 80, `title too long: ${title.length}`);
  assert.ok(title.startsWith('Пошук: «'));
});

test('SEO: unknown category falls back to generic catalog copy with noindex', () => {
  const m = buildCatalogViewMetadata({ input: { categorySlug: 'zzz' } });
  assert.deepEqual(m.robots, { index: false, follow: true });
  assert.equal(m.alternates, undefined);
});

test('SEO: SITE_NAME is the shop brand used across builders', () => {
  assert.equal(SITE_NAME, 'Товари для дому');
});

test('SEO: home metadata is unique vs root layout title (static source check)', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.match(home, /export const metadata[\s\S]*?title:/);
  const layout = readFileSync('app/layout.tsx', 'utf8');
  const homeTitle = home.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  const layoutTitle = layout.match(/title:\s*[`'"]([^`'"]+)/)?.[1] ?? '';
  assert.ok(homeTitle.length > 0);
  assert.notEqual(homeTitle, layoutTitle);
});
