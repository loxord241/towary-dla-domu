import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitProductWrites,
  type MappedProductRow,
  type ExistingProductRow,
} from '../app/lib/yugcontract/import-plan.ts';

function mapped(id: string, catYcId: string | null = '42'): MappedProductRow {
  return {
    yugcontract_id: id,
    sku: `YC-${id}`,
    slug: `slug-${id}`,
    name: `n-${id}`,
    price: 10,
    old_price: null,
    stock_quantity: 5,
    availability_status: 'in_stock',
    brandKey: null,
    catYcId,
  };
}

function existing(
  id: string,
  ycId: string,
  categoryId: string | null
): ExistingProductRow {
  return {
    id,
    yugcontract_id: ycId,
    sku: `YC-${ycId}`,
    name: `n-${ycId}`,
    slug: `slug-${ycId}`,
    price: 10,
    old_price: null,
    stock_quantity: 5,
    availability_status: 'in_stock',
    category_id: categoryId,
  };
}

test('UNRESOLVED-CAT: existing product still gets field updates when category unresolved', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'old-cat')], () => ({
    brand_id: null,
    category_id: null,
  }));
  // stock/name are identical in the fixture → force a field change:
  const withPriceChange = splitProductWrites(
    [{ ...mapped('1'), price: 99 }],
    [existing('p1', '1', 'old-cat')],
    () => ({ brand_id: null, category_id: null })
  );
  assert.equal(res.unresolvedCategoryUpdates.length, 1);
  assert.ok(res.unresolvedCategoryUpdates[0] !== undefined);
  assert.match(res.unresolvedCategoryUpdates[0].reason, /42 не знайдено/);
  assert.equal(withPriceChange.updates.length, 1, 'field update must survive');
  assert.ok(withPriceChange.updates[0] !== undefined);
  assert.equal(withPriceChange.updates[0].fields.category_id, undefined);
});

test('UNRESOLVED-CAT: new product without resolvable category is skipped with reason', () => {
  const res = splitProductWrites([mapped('9')], [], () => ({
    brand_id: null,
    category_id: null,
  }));
  assert.equal(res.inserts.length, 0);
  assert.ok(res.unresolvedRefs[0] !== undefined);
  assert.match(res.unresolvedRefs[0].reason, /новий товар не створено/);
});

test('UNRESOLVED-CAT: no silent null-overwrite ever', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'old-cat')], () => ({
    brand_id: null,
    category_id: null,
  }));
  for (const op of res.updates) {
    assert.notEqual(op.fields.category_id, null);
  }
});
