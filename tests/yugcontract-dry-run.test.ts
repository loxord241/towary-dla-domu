/**
 * Unit tests for dry-run aggregation: dedup by external id, selection
 * safety filter, report counters. Pure functions — no network, no env.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  YcProductMerger,
  makeCategoryFilter,
  computeDryRunReport,
} = await import('../app/lib/yugcontract/dry-run.ts');
const {
  flattenSelectedIds,
  countSelectedNodes,
} = await import('../app/lib/yugcontract/selection.ts');

function raw(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    name_ukr: 'Тестовий товар',
    brand: 'BRAND',
    cat_top_id: 1186,
    cat_id: 498,
    price: 100,
    rrp: null,
    qty_main: 5,
    ...overrides,
  };
}

test('YcProductMerger deduplicates by external id, first wins', () => {
  const merger = new YcProductMerger();
  merger.addRawBatch([raw({ id: 1, name_ukr: 'Перший' }), raw({ id: 2 })]);
  merger.addRawBatch([raw({ id: 1, name_ukr: 'Дублікат з іншого батчу' })]);
  assert.equal(merger.totalRows, 3);
  assert.equal(merger.uniqueCount, 2);
  assert.equal(merger.duplicateRowCount, 1);
  const values = merger.values();
  const first = values.find((p) => p.externalId === '1');
  assert.equal(first?.nameUkr, 'Перший');
});

test('YcProductMerger skips rows without a valid id', () => {
  const merger = new YcProductMerger();
  merger.addRawBatch([raw({ id: '' }), raw({ id: null }), raw({ id: undefined })]);
  assert.equal(merger.uniqueCount, 0);
});

test('makeCategoryFilter keeps only approved subtree ids', () => {
  const filter = makeCategoryFilter(new Set(['1186', '740', '498', '190']));
  assert.equal(filter({ catId: '498', catTopId: '1186' } as never), true);
  assert.equal(filter({ catId: '190', catTopId: '740' } as never), true);
  // чужая ветка того же корня — наружу
  assert.equal(filter({ catId: '999999', catTopId: '1186' } as never), true);
  assert.equal(filter({ catId: '999999', catTopId: '446' } as never), false);
  assert.equal(filter({ catId: null, catTopId: null } as never), false);
});

test('selection flattens to unique ids and counts nodes', () => {
  const ids = flattenSelectedIds();
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(countSelectedNodes() >= ids.length);
  assert.ok(ids.includes('1186'));
  // 2026-09-12: 5 веток удалены из селекции (владелец) — их id больше
  // не попадают в расширенное дерево, sync их не подвяжет обратно.
  for (const removed of ['1451', '1115', '1205', '1609', '1520', '1472', '731']) {
    assert.ok(!ids.includes(removed), `${removed} must be out of the selection`);
  }
});

test('computeDryRunReport counts stock/price/brand/category buckets', () => {
  const products = [
    { externalId: '1', nameUkr: 'A', brand: 'X', catTop: null, cat2l: null, cat: null, catId: '498', catTopId: '1186', price: 10, qtyMain: 3 },
    { externalId: '2', nameUkr: 'B', brand: null, catTop: null, cat2l: null, cat: null, catId: '490', catTopId: '1186', price: 20.5, qtyMain: 0 },
    { externalId: '3', nameUkr: 'C', brand: 'Y', catTop: null, cat2l: null, cat: null, catId: null, catTopId: null, price: null, qtyMain: null },
  ] as never[];
  const db = {
    skus: ['YC-1'],
    brandNames: ['X', 'Z'],
    categoryNames: [],
    hasYugcontractIdColumn: false,
  };
  const report = computeDryRunReport(
    products,
    { totalRows: 4, duplicateRows: 1, filteredOutByCats: 2 },
    ['498', '490'],
    db
  );
  assert.equal(report.uniqueProducts, 3);
  assert.equal(report.newProducts, 2);
  assert.equal(report.existingInDbBySku, 1);
  assert.equal(report.uniqueBrands, 2);
  assert.equal(report.withPrice, 2);
  assert.equal(report.withoutPrice, 1);
  assert.equal(report.qtyPositive, 1);
  assert.equal(report.qtyZero, 1);
  assert.equal(report.qtyUnknown, 1);
  assert.equal(report.noBrand, 1);
  assert.equal(report.noCategory, 1);
  assert.equal(report.minPrice, 10);
  assert.equal(report.maxPrice, 20.5);
  assert.equal(report.avgPrice, 15.25);
  assert.equal(report.duplicateRows, 1);
});
