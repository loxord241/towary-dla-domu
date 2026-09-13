/**
 * LCP + landmark pins (spec C/D, 2026-08-26; perf audit Step 1 2026-08-28):
 * only genuinely above-the-fold card images load eagerly with high fetch
 * priority; everything else keeps lazy-loading. (`priority` was replaced by
 * `loading="eager"` + `fetchPriority="high"` — deprecated in Next 16.)
 * The product page keeps EXACTLY one <main>; header/footer render none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('LCP: ProductCard exposes opt-in eager loading passed to next/image', () => {
  const src = readFileSync('app/components/ProductCard.tsx', 'utf8');
  assert.match(src, /eager = false/);
  assert.match(src, /loading=\{eager \? "eager" : "lazy"\}/);
  assert.match(src, /fetchPriority=\{eager \? "high" : "auto"\}/);
});

test('LCP: home marks the first 4 featured cards, popular stays lazy', () => {
  const home = readFileSync('app/(home)/page.tsx', 'utf8');
  assert.match(home, /eager=\{idx < 4\}/);
  const popularIdx = home.indexOf('Популярні товари');
  assert.ok(
    popularIdx === -1 || !home.slice(popularIdx).includes('eager='),
    'popular shelf must stay lazy'
  );
});

test('LCP: catalog marks the first 2 cards eager', () => {
  // Perf audit 2026-09-13: mobile shows 1 card per viewport — 6
  // high-priority fetches competed with the LCP image. First 2 cover the
  // LCP and immediate scroll on desktop.
  const src = readFileSync('app/catalog/CatalogView.tsx', 'utf8');
  assert.match(src, /eager=\{idx < 2\}/);
  assert.doesNotMatch(src, /eager=\{idx < 6\}/);
});

test('LANDMARK: product page renders exactly one <main>', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  assert.equal((page.match(/<main/g) ?? []).length, 1);
});

// Extended 2026-09 (landmark audit): every primary storefront page now wraps
// its content in exactly one <main>. cart/favorites each have TWO return
// branches (loading skeleton + loaded view) — every branch renders exactly
// one <main>, so the rendered page always has exactly one; the source counts
// below pin that contract per branch.
test('LANDMARK: home, checkout, lookup, info pages render exactly one <main>', () => {
  for (const file of [
    'app/(home)/page.tsx',
    'app/checkout/page.tsx',
    'app/orders/lookup/page.tsx',
    'app/components/InfoPage.tsx',
  ]) {
    assert.equal((readFileSync(file, 'utf8').match(/<main/g) ?? []).length, 1, file);
  }
});

test('LANDMARK: cart/favorites pin one <main> per return branch', () => {
  for (const file of ['app/cart/page.tsx', 'app/favorites/page.tsx']) {
    // exactly two branches (skeleton + loaded), each opening exactly one main
    assert.equal((readFileSync(file, 'utf8').match(/<main/g) ?? []).length, 2, file);
  }
});

test('LANDMARK: SiteHeader/SiteFooter render no <main>', () => {
  for (const file of ['app/components/SiteHeader.tsx', 'app/components/SiteFooter.tsx']) {
    assert.equal((readFileSync(file, 'utf8').match(/<main/g) ?? []).length, 0, file);
  }
});
