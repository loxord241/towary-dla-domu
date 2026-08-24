/**
 * Unit tests for the content import planner: diff-aware updates,
 * idempotency (second run = no-op), column isolation and batch layout.
 * Pure functions — no network, no DB. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  planContentUpdates,
  planContentBatches,
  assertContentFields,
  CONTENT_BATCH_SIZE,
} = await import('../app/lib/yugcontract/content-import.ts');

function staged(overrides: Record<string, unknown> = {}) {
  return {
    yugcontract_id: '101',
    category_id: null,
    name: 'Товар',
    description: '<p>Опис</p>',
    pictures: [],
    params: [{ name: 'Матеріал', value: 'Сталь' }],
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    yugcontract_id: '101',
    description: null,
    specifications: null,
    ...overrides,
  };
}

test('planContentUpdates fills empty descriptions and sets specifications', () => {
  const plan = planContentUpdates([staged()], [product()]);
  assert.equal(plan.updates.length, 1);
  const op = plan.updates[0];
  assert.equal(op.fields.description, '<p>Опис</p>');
  assert.deepEqual(op.fields.specifications, [
    { name: 'Матеріал', value: 'Сталь' },
  ]);
  assert.equal(plan.overwriteNonEmptyCount, 0);
});

test('planContentUpdates: same data twice → second run is a NO-OP', () => {
  const first = planContentUpdates([staged()], [product()]);
  assert.equal(first.updates.length, 1);

  // simulate persisted state after the first run
  const updated = product({
    description: '<p>Опис</p>',
    specifications: [{ name: 'Матеріал', value: 'Сталь' }],
  });
  const second = planContentUpdates([staged()], [updated]);
  assert.equal(second.updates.length, 0);
  assert.equal(second.identical, 1);
});

test('planContentUpdates counts overwrite of a non-empty local description separately', () => {
  const plan = planContentUpdates(
    [staged({ description: '<p>Новий</p>' })],
    [product({ description: 'Ручний опис' })]
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.overwriteNonEmptyCount, 1);
});

test('planContentUpdates skips rows without staged description and unmatched products', () => {
  const plan = planContentUpdates(
    [
      staged({ yugcontract_id: 'A', description: null, params: [] }),
      staged({ yugcontract_id: 'B', description: null, params: [] }),
      staged({ yugcontract_id: 'C', params: [] }),
    ],
    [product({ yugcontract_id: 'B' })]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.noDescriptionAvailable, 1); // B matched, no staged description
  assert.equal(plan.unmatchedStaged, 2); // A and C
  // disjoint accounting: nothing counted as identical here
  assert.equal(plan.identical, 0);
});

test('planContentUpdates updates specifications even when description is absent', () => {
  const plan = planContentUpdates(
    [staged({ description: null })],
    [product()]
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.description, undefined);
  assert.ok(plan.updates[0].fields.specifications);
});

test('planContentUpdates: duplicate names with different values BOTH survive', () => {
  const s = staged({
    params: [
      { name: 'Матеріал', value: 'Нержавіюча сталь' },
      { name: 'Матеріал', value: 'Пластик' },
    ],
  });
  const plan = planContentUpdates([s], [product()]);
  assert.deepEqual(plan.updates[0].fields.specifications, [
    { name: 'Матеріал', value: 'Нержавіюча сталь' },
    { name: 'Матеріал', value: 'Пластик' },
  ]);
});

test('ISOLATION: update ops may only ever contain description/specifications keys', () => {
  const plan = planContentUpdates([staged()], [product()]);
  for (const op of plan.updates) {
    for (const key of Object.keys(op.fields)) {
      assert.ok(
        key === 'description' || key === 'specifications',
        `заборонене поле ${key}`
      );
    }
  }
  // price/old_price/stock/name/slug/is_active/category_id/brand_id/sku
  // are structurally absent from ContentUpdateOp — asserted via the guard:
  for (const forbidden of [
    'price',
    'old_price',
    'stock_quantity',
    'name',
    'slug',
    'is_active',
    'category_id',
    'brand_id',
    'sku',
    'availability_status',
  ]) {
    assert.throws(() => assertContentFields({ [forbidden]: 1 }), /заборонене поле/);
  }
  assert.doesNotThrow(() =>
    assertContentFields({ description: 'x', specifications: [] })
  );
});

test('planContentBatches: deterministic sort + fixed chunk size', () => {
  const ids = ['9', '3', '7', '1', '11'];
  const batches = planContentBatches(ids, 2);
  assert.deepEqual(
    batches.map((b) => b.ids),
    [['1', '11'], ['3', '7'], ['9']]
  );
  assert.deepEqual(batches.map((b) => b.batchNo), [1, 2, 3]);

  // default size constant sanity
  const many = planContentBatches(Array.from({ length: CONTENT_BATCH_SIZE + 1 }, (_, i) => String(i)));
  assert.equal(many.length, 2);
});
