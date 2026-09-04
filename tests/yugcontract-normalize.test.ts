/**
 * Unit tests for Yugcontract feed normalization and preview statistics.
 * Pure functions — no network, no env. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  asStringOrNull,
  asNumberOrNull,
  extractRawProducts,
  normalizeYcProduct,
  buildFieldTypeHistogram,
  buildPreviewStats,
  buildCrossAnalysis,
} = await import('../app/lib/yugcontract/normalize.ts');

test('asStringOrNull trims strings, stringifies numbers, rejects junk', () => {
  assert.equal(asStringOrNull('  FUJI '), 'FUJI');
  assert.equal(asStringOrNull(4684), '4684');
  assert.equal(asStringOrNull(''), null);
  assert.equal(asStringOrNull('   '), null);
  assert.equal(asStringOrNull(null), null);
  assert.equal(asStringOrNull(undefined), null);
  assert.equal(asStringOrNull({}), null);
});

test('asNumberOrNull accepts numbers and numeric strings, rejects junk', () => {
  assert.equal(asNumberOrNull(6417), 6417);
  assert.equal(asNumberOrNull('6417'), 6417);
  assert.equal(asNumberOrNull(' 12.5 '), 12.5);
  assert.equal(asNumberOrNull('abc'), null);
  assert.equal(asNumberOrNull(''), null);
  assert.equal(asNumberOrNull(null), null);
  assert.equal(asNumberOrNull(undefined), null);
  assert.equal(asNumberOrNull(Number.NaN), null);
  assert.equal(asNumberOrNull(Number.POSITIVE_INFINITY), null);
});

test('extractRawProducts reads the documented envelope', () => {
  const parsed = {
    content: { data: { rests: { product: [{ id: 1 }, { id: 2 }] } } },
  };
  assert.deepEqual(extractRawProducts(parsed), [{ id: 1 }, { id: 2 }]);
});

test('extractRawProducts throws on malformed envelopes (no partial data)', () => {
  const cases = [
    null,
    {},
    { content: {} },
    { content: { data: {} } },
    { content: { data: { rests: {} } } },
    { content: { data: { rests: { product: 'not-an-array' } } } },
    { content: { data: { rests: { product: [null] } } } },
    { content: { data: { rests: { product: [[1]] } } } },
  ];
  for (const parsed of cases) {
    assert.throws(() => extractRawProducts(parsed), TypeError);
  }
});

test('normalizeYcProduct coerces documented fields and tolerates deviations', () => {
  const docLike = {
    cat_top: 'ТОВАРИ ПРОФІЛЬНИХ БІЗНЕСІВ',
    cat_2l: 'Фотодрук',
    cat: 'Хімія',
    cat_id: 453,
    cat_top_id: 446,
    brand: 'FUJI',
    id: '4684',
    name_ukr: 'Хiмiя FUJI CP-47 P1-R (4x2,5L) проявник',
    price: 6417,
    price_scu: 6417,
    rrp: 8068,
    rrp_control: 0,
    status_main: 1,
    qty_main: 100,
  };
  assert.deepEqual(normalizeYcProduct(docLike), {
    externalId: '4684',
    nameUkr: docLike.name_ukr,
    brand: 'FUJI',
    catTop: docLike.cat_top,
    cat2l: 'Фотодрук',
    cat: 'Хімія',
    catId: '453',
    catTopId: '446',
    price: 6417,
    priceScu: 6417,
    rrp: 8068,
    rrpControl: 0,
    statusMain: 1,
    qtyMain: 100,
  });

  // Real API may deviate from docs: everything degrades to null/'', never throws.
  const weird = normalizeYcProduct({
    id: 123,
    name_ukr: 42,
    brand: '',
    price: '199.99',
    qty_main: null,
    status_main: true,
  });
  assert.equal(weird.externalId, '123');
  assert.equal(weird.nameUkr, '42');
  assert.equal(weird.brand, null);
  assert.equal(weird.price, 199.99);
  assert.equal(weird.qtyMain, null);
  assert.equal(weird.statusMain, null); // boolean → not a number

  // Missing row entirely.
  assert.doesNotThrow(() => normalizeYcProduct({}));
});

test('buildFieldTypeHistogram counts real runtime types', () => {
  const histogram = buildFieldTypeHistogram([
    { id: '1', price: 10, rrp: null, qty_main: 5, status_main: 1 },
    { id: 2, price: '20' },
    {},
  ]);
  assert.deepEqual(histogram['id'], {
    string: 1,
    number: 1,
    boolean: 0,
    null: 0,
    undefined: 1,
    other: 0,
  });
  assert.ok(histogram['price'] !== undefined && histogram['rrp'] !== undefined && histogram['qty_main'] !== undefined);
  assert.equal(histogram['price']['number'], 1);
  assert.equal(histogram['price']['string'], 1);
  assert.equal(histogram['rrp']['null'], 1);
  assert.equal(histogram['qty_main']['undefined'], 2);
});

function makeProduct(overrides: Partial<Parameters<typeof normalizeYcProduct>[0]> & Record<string, unknown>) {
  return normalizeYcProduct({ ...overrides });
}

test('buildPreviewStats aggregates counts, prices, brands, categories, duplicates', () => {
  const rows = [
    makeProduct({ id: 'a', brand: 'FUJI', price: 100, qty_main: 5, cat_id: 1, cat: 'A', cat_2l: 'X', cat_top: 'T', cat_top_id: 9 }),
    makeProduct({ id: 'b', brand: 'SONY', price: 50, qty_main: 0 }),
    makeProduct({ id: 'a', price: 200, qty_main: 7 }), // duplicate id
    makeProduct({ id: 'c', qty_main: null, price: -3 }), // unknown qty
    makeProduct({ id: 'd', qty_main: 1, brand: '', cat: '' }), // no brand/category
  ];
  const stats = buildPreviewStats(rows);

  assert.equal(stats.totalProducts, 5);
  assert.equal(stats.inStockCount, 3); // a(5), a-dup(7), d(1)
  assert.equal(stats.outOfStockCount, 1); // b
  assert.equal(stats.unknownQtyCount, 1); // c
  assert.equal(stats.noBrandCount, 3); // rows without brand: a-dup? no...
  assert.equal(stats.minPrice, -3); // factual min; DB constraint handles >=0 at import time
  assert.equal(stats.maxPrice, 200);
  assert.equal(stats.uniqueBrands, 2); // FUJI, SONY
  // Only row 1 carries any category identity; the "no category" bucket
  // must not be counted as a phantom category.
  assert.equal(stats.uniqueCategories, 1);

  assert.deepEqual(
    stats.duplicateIds.map((d) => d.externalId),
    ['a']
  );
  assert.ok(stats.duplicateIds[0] !== undefined);
  assert.equal(stats.duplicateIds[0].count, 2);

  const fuji = stats.brandSamples.find((b) => b.name === 'FUJI');
  assert.equal(fuji?.productCount, 1);
});

test('buildPreviewStats: no-brand / no-category counting is precise', () => {
  const rows = [
    makeProduct({ id: '1', brand: 'A', cat: 'C1', qty_main: 1 }),
    makeProduct({ id: '2', brand: '', cat: 'C1', qty_main: 1 }),
    makeProduct({ id: '3', brand: 'B', qty_main: 1 }), // no category at all
    makeProduct({ id: '4', brand: '', cat_id: 77, qty_main: 1 }), // has cat id only → HAS category
  ];
  const stats = buildPreviewStats(rows);
  assert.equal(stats.noBrandCount, 2);
  assert.equal(stats.noCategoryCount, 1);
});

test('buildCrossAnalysis matches sku/name/brand/category without false confidence', () => {
  const yc = [
    normalizeYcProduct({ id: '4684', name_ukr: 'Хімія FUJI CP-47 проявник', brand: 'FUJI', cat: 'Хімія' }),
    normalizeYcProduct({ id: '9999', name_ukr: 'Інший товар', brand: 'NOVUS', cat_2l: 'Автохімія' }),
  ];
  const ourProducts = [
    { sku: 'YC-4684', name: 'щось інше' },
    { sku: 'ABC-1', name: 'хімія fuji cp-47 ПРОЯВНИК' }, // case-insensitive name hit
  ];
  const ourBrands = [{ name: 'fuji' }];
  const ourCategories = [{ name: 'Хімія' }];

  const cross = buildCrossAnalysis(yc, ourProducts, ourBrands, ourCategories);

  assert.equal(cross.ourTotalProducts, 2);
  assert.equal(cross.skuMatches.count, 1);
  assert.deepEqual(cross.skuMatches.examples, [{ sku: 'YC-4684', name: 'щось інше' }]);
  assert.equal(cross.nameMatches.count, 1);
  assert.equal(cross.brandOverlap.count, 1);
  assert.ok(cross.brandOverlap.examples[0] !== undefined);
  assert.equal(cross.brandOverlap.examples[0].ycBrand, 'FUJI');
  assert.equal(cross.categoryOverlap.count, 1);
});
