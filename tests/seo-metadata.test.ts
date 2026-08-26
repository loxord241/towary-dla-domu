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
  assert.equal(r.canonicalPath, '/catalog?category=blendery-1402');
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

test('SEO: metadata builder — category title follows «X — купити в E-Shop»', () => {
  const m = buildCatalogViewMetadata({
    input: { categorySlug: 'blendery-1402', categoryFound: true },
    categoryName: 'Блендери',
  });
  assert.equal(m.title, 'Блендери — купити в E-Shop');
  assert.ok(String(m.description).includes('Блендери'));
  assert.ok(!m.robots, 'indexable view emits no robots override');
  assert.deepEqual(m.alternates, { canonical: '/catalog?category=blendery-1402' });
});

test('SEO: metadata builder — brand title and search title', () => {
  const b = buildCatalogViewMetadata({
    input: { brandSlug: 'tefal', brandFound: true },
    brandName: 'TEFAL',
  });
  assert.equal(b.title, 'TEFAL — купити в E-Shop');

  const s = buildCatalogViewMetadata({ input: { search: 'мультипіч tefal' } });
  assert.equal(s.title, 'Пошук: «мультипіч tefal» | E-Shop');
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
  assert.equal(SITE_NAME, 'E-Shop');
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
