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

test('LCP: catalog marks the first 6 cards eager', () => {
  const src = readFileSync('app/catalog/page.tsx', 'utf8');
  assert.match(src, /eager=\{idx < 6\}/);
});

test('LANDMARK: product page renders exactly one <main>', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  assert.equal((page.match(/<main/g) ?? []).length, 1);
});

test('LANDMARK: SiteHeader/SiteFooter render no <main>', () => {
  for (const file of ['app/components/SiteHeader.tsx', 'app/components/SiteFooter.tsx']) {
    assert.equal((readFileSync(file, 'utf8').match(/<main/g) ?? []).length, 0, file);
  }
});
