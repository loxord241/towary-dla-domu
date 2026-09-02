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
  isEmptyHtmlShell,
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

// ---------------------------------------------------------------------------
// Dynamic empty-shell description guard (2026-09-02): markup-only supplier
// HTML must never reach products.description. Replaces the static
// exclude-id list as the primary detection mechanism.
// ---------------------------------------------------------------------------

test('isEmptyHtmlShell: nested empty <div> shells are empty', () => {
  assert.equal(isEmptyHtmlShell('<div><div></div></div>'), true);
  assert.equal(
    isEmptyHtmlShell('<div>\r\n<div>\r\n<div></div>\r\n</div>\r\n</div>'),
    true
  );
});

test('isEmptyHtmlShell: whitespace + nbsp-only markup is empty', () => {
  assert.equal(isEmptyHtmlShell('<p>&nbsp;</p>'), true);
  assert.equal(isEmptyHtmlShell('<p> </p><div>\t</div>'), true);
  assert.equal(isEmptyHtmlShell('   \r\n\t  '), true);
  assert.equal(isEmptyHtmlShell('<p>&#160;</p>'), true);
});

test('isEmptyHtmlShell: real text is NEVER flagged as shell', () => {
  assert.equal(isEmptyHtmlShell('<p>Опис товару</p>'), false);
  assert.equal(isEmptyHtmlShell('<p>Текст &amp; більше тексту</p>'), false);
  // markup that CONTAINS real text anywhere stays real
  assert.equal(isEmptyHtmlShell('<div><div>Реальний опис<br /></div></div>'), false);
});

test('planContentUpdates: empty-shell staged description is NOT written, specs still flow', () => {
  const plan = planContentUpdates(
    [staged({ description: '<div><div></div></div>' })],
    [product()]
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.description, undefined);
  assert.ok(plan.updates[0].fields.specifications);
  assert.equal(plan.emptyShellDescription, 1);
  assert.equal(plan.overwriteNonEmptyCount, 0);
});

test('planContentUpdates: shell + nothing else to write → noDescriptionAvailable, no update', () => {
  const plan = planContentUpdates(
    [staged({ description: '<p>&nbsp;</p>', params: [] })],
    [product()]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.emptyShellDescription, 1);
  assert.equal(plan.noDescriptionAvailable, 1);
});

test('planContentUpdates: whitespace-only staged description is skipped (existing behaviour)', () => {
  const plan = planContentUpdates(
    [staged({ description: '   \r\n\t ', params: [] })],
    [product()]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.noDescriptionAvailable, 1);
  assert.equal(plan.emptyShellDescription, 0);
});

test('planContentUpdates: real-text HTML still imports normally (guard does not over-trigger)', () => {
  const desc = '<div><div>Крутий чайник, 1,7 л<br />потужність 2200 Вт</div></div>';
  const plan = planContentUpdates([staged({ description: desc })], [product()]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.description, desc);
  assert.equal(plan.emptyShellDescription, 0);
});

test('planContentUpdates: shell does NOT overwrite an existing stored shell (idempotent no-op)', () => {
  // stored state after the 2026-09-02 catch-up: two products hold shells
  const stored = product({ description: '<div>\r\n<div>\r\n<div></div>\r\n</div>\r\n</div>' });
  const plan = planContentUpdates(
    [staged({ description: '<div><div></div></div>', params: [] })],
    [stored]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.emptyShellDescription, 1);
});

test('planContentUpdates: static excludeDescriptionIds still suppresses descriptions (legacy compat)', () => {
  const plan = planContentUpdates([staged()], [product()], {
    excludeDescriptionIds: new Set(['101']),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].fields.description, undefined);
  assert.ok(plan.updates[0].fields.specifications);
  assert.equal(plan.excludedDescription, 1);
});

test('planContentUpdates: static-list id with SHELL desc counts as shell, not excluded', () => {
  // with the dynamic guard in place, a listed id whose staged desc is a
  // shell is counted by the dynamic counter (nothing to exclude textually)
  const plan = planContentUpdates(
    [staged({ description: '<div><div></div></div>', params: [] })],
    [product()],
    { excludeDescriptionIds: new Set(['101']) }
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.excludedDescription, 0);
  assert.equal(plan.emptyShellDescription, 1);
});
