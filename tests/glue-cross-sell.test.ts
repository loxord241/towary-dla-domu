/**
 * Glue cross-sell (owner 2026-09-13): «Клеї для шпалер» category + 5 manual
 * gl-* products + the wallpaper-PDP shelf.
 *
 * Pinned contracts:
 *  - DOMAIN DISJOINTNESS — glues are sku `gl-*`, never `wc-*`, and the glue
 *    category slug is NOT a wallpaper category slug. This keeps the 1C
 *    wallpaper sync (sku-scoped), the --publish gate (wc-*) and the
 *    wallpaper-scoped catalog views (WALLPAPER_CATEGORY_SLUGS) from ever
 *    touching the glue assortment;
 *  - the seed data is complete and unique (sku, slug, positive price,
 *    non-empty specs, a photo file per product);
 *  - WIRE — the shelf read reuses CATALOG_CARD_SELECT (the
 *    product_images!inner eligibility join), filters DIRECT junction
 *    assignments only, orders by the catalog default-sort contract and is
 *    wrapped in cachePublicRead (900s public Data Cache);
 *  - the PDP mounts the shelf ONLY for wc-* products (sku gate + the
 *    conditional read that skips non-wallpaper pages entirely);
 *  - /oboi links the glue category as a chip into a GENERAL catalog view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

// Supabase env placeholders BEFORE any catalog import (no network happens —
// the client is only constructed; same contract as catalog-cache-wiring).
// Static imports would hoist ABOVE these assignments, so the catalog
// modules load through top-level await instead.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key';

const { GLUE_CATEGORY_SLUG, GLUE_CROSS_SELL_LIMIT } = await import(
  '../app/lib/catalog/glues.ts'
);
const { GLUE_PRODUCTS } = await import('../scripts/glues-import.ts');
const { WALLPAPER_CATEGORY_SLUGS, WALLPAPER_SKU_PREFIX } = await import(
  '../app/lib/catalog/shared.ts'
);

test('glue domain is disjoint from the wallpaper domain', () => {
  assert.ok(GLUE_CATEGORY_SLUG.startsWith('kleyi-'));
  assert.ok(!GLUE_CATEGORY_SLUG.startsWith('shpaleri'));
  assert.ok(!WALLPAPER_CATEGORY_SLUGS.has(GLUE_CATEGORY_SLUG));

  assert.notEqual(WALLPAPER_SKU_PREFIX, 'gl-');
  for (const product of GLUE_PRODUCTS) {
    assert.ok(product.sku.startsWith('gl-'), product.sku);
    assert.ok(!product.sku.startsWith(WALLPAPER_SKU_PREFIX), product.sku);
  }
});

test('glue seed data: complete, unique, sellable', () => {
  assert.equal(GLUE_PRODUCTS.length, 5);
  const skus = new Set(GLUE_PRODUCTS.map((p) => p.sku));
  const slugs = new Set(GLUE_PRODUCTS.map((p) => p.slug));
  assert.equal(skus.size, GLUE_PRODUCTS.length);
  assert.equal(slugs.size, GLUE_PRODUCTS.length);
  for (const product of GLUE_PRODUCTS) {
    assert.ok(product.price > 0, `${product.sku}: price`);
    assert.ok(Number.isInteger(product.stockQuantity) && product.stockQuantity > 0);
    assert.ok(product.name.trim() !== '');
    assert.ok(product.shortDescription.trim() !== '');
    assert.ok(product.specifications.length >= 4, `${product.sku}: specs`);
    assert.ok(product.specifications.every((s) => s.name && s.value));
    assert.match(product.imageFile, /\.png$/);
  }
});

test('glue cross-sell read: card projection + junction filter + cache wiring', () => {
  const source = read('app/lib/catalog/glues.ts');
  assert.match(source, /CATALOG_CARD_SELECT/, 'card projection (images!inner eligibility)');
  assert.match(source, /pc:product_categories!inner\(category_id\)/, 'junction filter');
  assert.match(source, /\.eq\('is_active', true\)/, 'storefront visibility');
  assert.match(source, /\.eq\('pc\.category_id', categoryId\)/, 'direct assignments only');
  assert.match(
    source,
    /\.order\('availability_status'[\s\S]*\.order\('name'[\s\S]*\.order\('id'/,
    'catalog default-sort contract + deterministic tiebreak'
  );
  assert.match(source, /cachePublicRead\(/, 'public read cache');
  assert.match(source, /GLUE_CROSS_SELL_LIMIT = 5/, 'bounded shelf');
  assert.equal(GLUE_CROSS_SELL_LIMIT, 5);
});

test('PDP: glue shelf mounts only on wallpaper products', () => {
  const source = read('app/product/[slug]/page.tsx');
  assert.match(source, /isWallpaper \? fetchGlueCrossSell\(\)/, 'conditional read (skip query on non-wallpaper PDP)');
  assert.match(source, /\{isWallpaper && <GlueCrossSell/, 'render gate');
  assert.match(source, /gluesSettled\.status === 'fulfilled'/, 'degradation contract');
  // The shelf must stay OUT of the general PDP path: the gate variable is
  // the same wc-* computation the roll calculator uses.
  assert.match(source, /product\.sku\.startsWith\('wc-'\)/);
});

test('oboi showcase links the glue category as a general catalog view', () => {
  // ISR split (2026-09-14): the chips markup lives on the shared
  // OboiStorefront both /oboi routes render through.
  const source = read('app/oboi/OboiStorefront.tsx');
  assert.match(source, /GLUE_CATEGORY_SLUG/);
  assert.match(source, /Клеї для шпалер/);
});

test('catalog barrel re-exports the glue module', () => {
  const source = read('app/lib/catalog.ts');
  assert.match(source, /GLUE_CATEGORY_SLUG/);
  assert.match(source, /fetchGlueCrossSell/);
});
