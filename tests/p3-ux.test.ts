/**
 * Pins for the P3 UX stage (2026-08-26): unified uk-UA price rendering,
 * single-container Recently Viewed, always-visible category-card
 * affordance, accessible disabled pagination, and the md grid step for the
 * product shelves. Display-only invariants: no data, cart, order or SEO
 * logic is covered here (those live in their own suites).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(file, 'utf8');

test('P3-R1: ProductCard renders prices exclusively via formatPrice', () => {
  const src = read('app/components/ProductCard.tsx');
  assert.match(src, /import \{ formatPrice \} from '@\/app\/lib\/format'/);
  assert.match(src, /formatPrice\(product\.price, product\.currency\)/);
  assert.match(src, /formatPrice\(product\.old_price!, product\.currency\)/);
  assert.ok(!/\{product\.price\}/.test(src), 'raw price render must be gone');
});

test('P3-R1: product page uses formatPrice; variants use product currency', () => {
  const src = read('app/product/[slug]/page.tsx');
  assert.match(src, /import \{ formatPrice \} from '@\/app\/lib\/format'/);
  assert.match(src, /formatPrice\(product\.price, product\.currency\)/);
  assert.match(src, /formatPrice\(variant\.price, product\.currency\)/);
  assert.ok(!src.includes('₴'), 'hardcoded hryvnia symbol must be gone');
});

test('P3-N1: RecentlyViewed has no own container wrapper', () => {
  const src = read('app/components/RecentProducts.tsx');
  assert.ok(!src.includes('container mx-auto'), 'must align with sibling sections');
  assert.match(src, /mb-8 rounded-lg bg-white p-6 shadow/);
  // empty-state contract unchanged
  assert.match(src, /if \(!mounted \|\| !hasEntries \|\| lines\.length === 0\) return null;/);
});

test('P3-R3: category card affordance is not hover-only', () => {
  const home = read('app/(home)/page.tsx');
  assert.ok(
    !home.includes('opacity-0 group-hover:opacity-100'),
    'touch users must see the affordance without hover'
  );
  assert.match(home, /Переглянути товари →/);
});

test('P3-R3: fifth category card spans the mobile row (no orphan)', () => {
  const home = read('app/(home)/page.tsx');
  assert.match(home, /idx === 4 \? 'col-span-2 sm:col-span-1' : ''/);
});

test('P3-R2: disabled pagination controls carry aria-disabled', () => {
  const src = read('app/catalog/page.tsx');
  const spans = src.match(/<span aria-disabled="true"/g) ?? [];
  assert.equal(spans.length, 2, 'prev+next inactive sides pinned');
  assert.match(src, /paginationControlClass/);
  // URL/clamp logic untouched: page param handling still present
  assert.match(src, /catalogPageUrl\(rawParams, page - 1\)/);
  assert.match(src, /catalogPageUrl\(rawParams, page \+ 1\)/);
});

test('P3-N2: shelves expose the md step between 2-col and lg:4', () => {
  assert.match(read('app/components/RelatedProducts.tsx'), /md:grid-cols-3 lg:grid-cols-4/);
  assert.match(read('app/components/RecentProducts.tsx'), /md:grid-cols-3 lg:grid-cols-4/);
  assert.match(read('app/(home)/page.tsx'), /md:grid-cols-3 lg:grid-cols-4/);
});
