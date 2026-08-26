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

test('RECATEGORY: changed category produces category_id update + junction replace op', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'uuid-old')], () => ({
    brand_id: null,
    category_id: 'uuid-new',
  }));
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].fields.category_id, 'uuid-new');
  assert.deepEqual(res.updates[0].categorySync, {
    oldCategoryId: 'uuid-old',
    newCategoryId: 'uuid-new',
  });
});

test('RECATEGORY: same category -> no categorySync op emitted', () => {
  const res = splitProductWrites([mapped('1')], [existing('p1', '1', 'uuid-new')], () => ({
    brand_id: null,
    category_id: 'uuid-new',
  }));
  assert.equal(res.updates.length, 0, 'nothing dirty in fixture → no update at all');

  // force a field change to prove absence of category ops specifically
  const res2 = splitProductWrites(
    [{ ...mapped('1'), price: 77 }],
    [existing('p1', '1', 'uuid-new')],
    () => ({ brand_id: null, category_id: 'uuid-new' })
  );
  assert.equal(res2.updates[0].fields.category_id, undefined);
  assert.equal(res2.updates[0].categorySync, undefined);
});

test('RECATEGORY: insert op carries resolved category for junction insert', () => {
  const res = splitProductWrites([mapped('2')], [], () => ({
    brand_id: null,
    category_id: 'uuid-c',
  }));
  assert.equal(res.inserts[0].category_id, 'uuid-c');
});

test('RECATEGORY: unresolved category on existing -> no category fields/junction ops', () => {
  const res = splitProductWrites(
    [{ ...mapped('1'), price: 55 }],
    [existing('p1', '1', 'uuid-old')],
    () => ({ brand_id: null, category_id: null })
  );
  assert.equal(res.updates[0].fields.category_id, undefined);
  assert.equal(res.updates[0].categorySync, undefined);
});
