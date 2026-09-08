/**
 * «Схожі товари» (spec A, 2026-08-26): up to three bounded reads
 * (same category → same brand → newest) merged by the PURE collectRelated.
 * Invariants: storefront eligibility mirror, exclusion of the current
 * product, dedupe across groups, hard cap 8, deterministic order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// catalog.ts creates its Supabase client at module load; provide the
// publishable-env placeholders BEFORE the import (no network happens).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';
const { collectRelated, RELATED_LIMIT } = await import(
  '../app/lib/catalog.ts'
);

// Minimal row shape cast for merge testing — collectRelated only touches id.
function mk(id: string): never {
  return { id } as never;
}

test('RELATED: category group keeps priority over brand, then newest', () => {
  const out = collectRelated(
    [[mk('c1'), mk('c2')], [mk('b1')], [mk('n1'), mk('n2')]],
    'current'
  );
  assert.deepEqual(out.map((p) => p.id), ['c1', 'c2', 'b1', 'n1', 'n2']);
});

test('RELATED: current product is excluded everywhere', () => {
  const out = collectRelated([[mk('current'), mk('c1')], [mk('current')]], 'current');
  assert.deepEqual(out.map((p) => p.id), ['c1']);
});

test('RELATED: duplicates across groups collapse to the first occurrence', () => {
  const out = collectRelated([[mk('x'), mk('y')], [mk('y'), mk('z')]], 'cur');
  assert.deepEqual(out.map((p) => p.id), ['x', 'y', 'z']);
});

test('RELATED: hard cap 8 regardless of candidate volume', () => {
  assert.equal(RELATED_LIMIT, 8);
  const big = Array.from({ length: 20 }, (_, i) => mk(`p${i}`));
  assert.equal(collectRelated([big], 'cur').length, 8);
});

test('RELATED: empty candidates yield an empty list (block hides itself)', () => {
  assert.deepEqual(collectRelated([], 'cur'), []);
  assert.deepEqual(collectRelated([[], [], []], 'cur'), []);
});

test('RELATED: fetch layer is bounded and mirrors eligibility (source-level)', () => {
  const src = readFileSync('app/lib/catalog.ts', 'utf8');
  const start = src.indexOf('async function fetchRelatedStage');
  const end = src.indexOf('export async function fetchRelatedProducts');
  assert.ok(start !== -1 && end > start, 'stage helper must exist');
  const stage = src.slice(start, end);
  // Egress fix (2026-09-08): the stage selects the slim card projection —
  // eligibility join (product_images!inner) is identical to PRODUCT_SELECT.
  assert.match(stage, /CATALOG_CARD_SELECT \+/, 'card projection selected');
  assert.match(
    stage,
    /', pc:product_categories!inner\(category_id\)'/,
    'junction embed kept on the category stage'
  );
  assert.doesNotMatch(stage, /PRODUCT_SELECT/, 'heavy projection banned here');
  assert.match(stage, /\.eq\('is_active',\s*true\)/);
  assert.match(stage, /\.neq\('id',\s*currentId\)/, 'current product excluded in SQL');
  assert.match(stage, /\.range\(0,\s*limit - 1\)/, 'single bounded window');
  assert.match(stage, /\.order\('id',\s*\{\s*ascending:\s*false\s*\}\)/, 'deterministic tiebreaker');
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
    /for\s*\(;;\)\s*\{[\s\S]{0,400}fetchRelated/,
    'no unbounded paging loop for related'
  );
});

test('RELATED: component uses h2 (H1-invariant safe), hides when empty, reuses ProductCard', () => {
  const comp = readFileSync('app/components/RelatedProducts.tsx', 'utf8');
  assert.match(comp, /<h2[^>]*>Схожі товари<\/h2>/);
  assert.ok(!comp.includes('<h1'), 'must not introduce a second h1');
  assert.match(comp, /products\.length === 0[\s\S]*?return null/);
  assert.match(comp, /import ProductCard from '\.\/ProductCard'/);
  assert.match(comp, /<ProductCard/);
});

test('RELATED: page degrades on read failure and renders before reviews', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  assert.match(page, /let relatedProducts: CatalogCardProduct\[\] = \[\]/);
  // Perf audit Step 2: related runs in the SAME parallel wave as reviews
  // (Promise.allSettled) instead of a sequential post-reviews waterfall.
  assert.match(page, /await Promise\.allSettled\(/);
  assert.match(page, /fetchRelatedProducts\(product\)/);
  assert.match(
    page,
    /relatedSettled\.status === 'fulfilled'[\s\S]*?relatedProducts = relatedSettled\.value/
  );
  assert.match(page, /console\.error\('related products unavailable:'/);
  assert.match(page, /<RelatedProducts products=\{relatedProducts\} \/>/);
  const rel = page.indexOf('<RelatedProducts');
  const rev = page.indexOf('<ProductReviews');
  assert.ok(rel !== -1 && rev !== -1 && rel < rev, 'related before reviews');
});

test('DELIVERY CTA: compact pointer to /delivery without invented facts', () => {
  const page = readFileSync('app/product/[slug]/page.tsx', 'utf8');
  // Inspect ONLY our own block (supplier HTML elsewhere may contain any words).
  const idx = page.indexOf('Доставка та оплата</p>');
  assert.ok(idx !== -1, 'CTA block missing');
  const block = page.slice(idx, idx + 600);
  assert.match(block, /href="\/delivery"/);
  assert.ok(
    !/Оплата карткою|Оплата онлайн|1-2 дн|терміни|Кур['’]єр/i.test(block),
    'no invented payment/shipping claims'
  );
});
