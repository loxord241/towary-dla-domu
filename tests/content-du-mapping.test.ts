/**
 * Task #20 — `_du` content mapping tests.
 *
 * The `_du` price-feed duplicates receive their Yugcontract content from
 * the verified BASE staged row via the GENERATED allowlist
 * (content-du-mapping.ts). Contract pinned here:
 *   - allowlist is well-formed and the only mapping gate (fail-closed);
 *   - regular (non-du) planning is byte-identical to the pre-fix planner;
 *   - overwrite guard, exclusion inheritance, shadow rule, idempotency;
 *   - matchContentGoodsToProducts maps the same way (dry-run/fetch parity).
 * Pure functions — no network, no DB. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  planContentUpdates,
  contentProductQueryIds,
  planContentBatches,
} = await import('../app/lib/yugcontract/content-import.ts');
const { matchContentGoodsToProducts } = await import(
  '../app/lib/yugcontract/content-dry-run.ts'
);
const {
  DU_CONTENT_PAIRS,
  DU_CONTENT_BY_DU_YC,
  DU_BASE_TO_DU,
  duBaseIdOf,
} = await import('../app/lib/yugcontract/content-du-mapping.ts');

// The audit verified EXACTLY 130 base ↔ _du pairs (Task #19, 2026-09-01).
const EXPECTED_PAIRS = 130;

const DU_YC = '5924679_du';
const BASE_YC = '5924679';

function staged(overrides: Record<string, unknown> = {}) {
  return {
    yugcontract_id: BASE_YC,
    category_id: null,
    name: 'Набір для стрижки Remington HC 5150',
    description: '<p>Базовий опис</p>',
    pictures: [],
    params: [{ name: 'Матеріал', value: 'Сталь' }],
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-base',
    yugcontract_id: BASE_YC,
    sku: 'YC-5924679',
    name: 'Набір для стрижки Remington HC 5150',
    description: null,
    specifications: null,
    ...overrides,
  };
}

function duProduct(overrides: Record<string, unknown> = {}) {
  return product({
    id: 'uuid-du',
    yugcontract_id: DU_YC,
    ...overrides,
  });
}

// ---- allowlist -----------------------------------------------------------

test('DU ALLOWLIST: exactly 130 verified, well-formed pairs', () => {
  assert.equal(DU_CONTENT_PAIRS.length, EXPECTED_PAIRS);
  assert.equal(DU_CONTENT_BY_DU_YC.size, EXPECTED_PAIRS);
  for (const p of DU_CONTENT_PAIRS) {
    assert.ok(p.duYc.endsWith('_du'), p.duYc);
    assert.ok(!p.baseYc.endsWith('_du'), p.baseYc);
    assert.equal(p.baseYc, p.duYc.replace(/_du$/, ''));
    assert.notEqual(p.duYc, p.baseYc);
  }
  assert.equal(new Set(DU_CONTENT_PAIRS.map((p) => p.duYc)).size, EXPECTED_PAIRS);
  // inverse index is consistent and lossless
  let inverseTotal = 0;
  for (const [base, dus] of DU_BASE_TO_DU) {
    for (const du of dus) assert.equal(DU_CONTENT_BY_DU_YC.get(du), base);
    inverseTotal += dus.length;
  }
  assert.equal(inverseTotal, EXPECTED_PAIRS);
});

test('duBaseIdOf is the only gate: allowlisted → base, everything else → null', () => {
  assert.equal(duBaseIdOf(DU_YC), BASE_YC);
  assert.equal(duBaseIdOf('9999999_du'), null); // unknown _du → fail-closed
  assert.equal(duBaseIdOf(BASE_YC), null); // regular id → null
  assert.equal(duBaseIdOf(''), null);
  assert.equal(duBaseIdOf(null), null);
  assert.equal(duBaseIdOf(undefined), null);
  assert.equal(duBaseIdOf('_du'), null); // degenerate
});

// ---- planner: base content → _du update -----------------------------------

test('PLANNER: allowlisted _du product is planned from its base staged row', () => {
  const plan = planContentUpdates([staged()], [duProduct()]);
  assert.equal(plan.updates.length, 1);
  const op = plan.updates[0];
  assert.equal(op.productDbId, 'uuid-du');
  // the op carries the du id — the executor guard .eq('yugcontract_id')
  // must match the du row, not the staged base id
  assert.equal(op.yugcontractId, DU_YC);
  assert.equal(op.fields.description, '<p>Базовий опис</p>');
  assert.deepEqual(op.fields.specifications, [{ name: 'Матеріал', value: 'Сталь' }]);
  assert.equal(plan.overwriteNonEmptyCount, 0);
  assert.equal(plan.unmatchedStaged, 0);
});

test('PLANNER: base product AND its _du twin both get the same staged row', () => {
  const plan = planContentUpdates([staged()], [product(), duProduct()]);
  assert.equal(plan.updates.length, 2);
  assert.equal(plan.updates[0].productDbId, 'uuid-base');
  assert.equal(plan.updates[0].yugcontractId, BASE_YC);
  assert.equal(plan.updates[1].productDbId, 'uuid-du');
  assert.equal(plan.updates[1].yugcontractId, DU_YC);
  assert.equal(plan.updates[0].fields.description, plan.updates[1].fields.description);
});

test('PLANNER: orphan _du (no base product row) still gets base content', () => {
  const plan = planContentUpdates([staged()], [duProduct()]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].productDbId, 'uuid-du');
});

test('PLANNER: allowlisted _du WITHOUT a staged base row → nothing planned', () => {
  const plan = planContentUpdates([], [duProduct()]);
  assert.equal(plan.updates.length, 0);
});

test('PLANNER: unknown _du (not in allowlist) is never mapped', () => {
  const stranger = product({ id: 'uuid-x', yugcontract_id: '9999999_du' });
  const plan = planContentUpdates([staged()], [stranger]);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unmatchedStaged, 1); // staged row has no target
});

// ---- regular products are byte-identical ----------------------------------

test('REGRESSION: regular (non-du) plan output is pinned byte-identically', () => {
  const plan = planContentUpdates([staged()], [product()]);
  assert.deepEqual(plan, {
    updates: [
      {
        productDbId: 'uuid-base',
        yugcontractId: BASE_YC,
        fields: {
          description: '<p>Базовий опис</p>',
          specifications: [{ name: 'Матеріал', value: 'Сталь' }],
        },
        currentHadDescription: false,
      },
    ],
    identical: 0,
    unmatchedStaged: 0,
    noDescriptionAvailable: 0,
    overwriteNonEmptyCount: 0,
    excludedDescription: 0,
    emptyShellDescription: 0,
  });
});

test('REGRESSION: no du products in input → planner state identical to pre-fix flow', () => {
  const plan = planContentUpdates(
    [
      staged({ yugcontract_id: 'A', description: null, params: [] }),
      staged({ yugcontract_id: 'B', description: null, params: [] }),
      staged({ yugcontract_id: 'C', params: [] }),
    ],
    [product({ yugcontract_id: 'B' })]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.noDescriptionAvailable, 1);
  assert.equal(plan.unmatchedStaged, 2);
  assert.equal(plan.identical, 0);
});

// ---- overwrite guard -------------------------------------------------------

test('GUARD: _du with a DIFFERENT non-empty description counts as overwrite', () => {
  const plan = planContentUpdates(
    [staged({ description: '<p>Новий</p>' })],
    [duProduct({ description: 'Старий опис' })]
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.overwriteNonEmptyCount, 1);
  assert.equal(plan.updates[0].currentHadDescription, true);
});

test('GUARD: _du with the SAME description AND specs → no-op (identical)', () => {
  const plan = planContentUpdates(
    [staged()],
    [duProduct({
      description: '<p>Базовий опис</p>',
      specifications: [{ name: 'Матеріал', value: 'Сталь' }],
    })]
  );
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.identical, 1);
});

test('GUARD: _du with its own non-empty description is never blanked out', () => {
  const plan = planContentUpdates(
    [staged({ description: null })],
    [duProduct({ description: 'Ручний опис', specifications: [{ name: 'Матеріал', value: 'Сталь' }] })]
  );
  // staged has no description → description untouched; identical specs → no-op
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.noDescriptionAvailable, 1);
});

// ---- exclusion inheritance -------------------------------------------------

test('EXCLUDE: base id in excludeDescriptionIds suppresses the _du description too', () => {
  const plan = planContentUpdates(
    [staged()],
    [duProduct()],
    { excludeDescriptionIds: new Set([BASE_YC]) }
  );
  // specs still flow, description does not
  assert.equal(plan.updates.length, 1);
  const op = plan.updates[0];
  assert.equal(op.fields.description, undefined);
  assert.ok(op.fields.specifications);
  assert.equal(plan.excludedDescription, 1);
});

// ---- shadow rule -------------------------------------------------------------

test('SHADOW: exact staged row for the _du id wins, base mapping suppressed', () => {
  const plan = planContentUpdates(
    [
      staged(), // base row
      staged({
        yugcontract_id: DU_YC,
        description: '<p>Власний du опис</p>',
        params: [{ name: 'Інше', value: 'Значення' }],
      }),
    ],
    [product(), duProduct()]
  );
  assert.equal(plan.updates.length, 2);
  const duOps = plan.updates.filter((u) => u.yugcontractId === DU_YC);
  assert.equal(duOps.length, 1); // planned exactly once
  assert.equal(duOps[0].fields.description, '<p>Власний du опис</p>');
  const baseOps = plan.updates.filter((u) => u.yugcontractId === BASE_YC);
  assert.equal(baseOps.length, 1);
  assert.equal(baseOps[0].productDbId, 'uuid-base');
});

// ---- idempotency -------------------------------------------------------------

test('IDEMPOTENT: second plan after applying du content is a NO-OP', () => {
  const first = planContentUpdates([staged()], [duProduct()]);
  assert.equal(first.updates.length, 1);
  const second = planContentUpdates(
    [staged()],
    [duProduct({
      description: '<p>Базовий опис</p>',
      specifications: [{ name: 'Матеріал', value: 'Сталь' }],
    })]
  );
  assert.equal(second.updates.length, 0);
  assert.equal(second.identical, 1);
});

// ---- product query expansion ---------------------------------------------------

test('contentProductQueryIds: base ids expand with their allowlisted _du ids', () => {
  const ids = contentProductQueryIds([BASE_YC, '123', DU_YC]);
  assert.ok(ids.includes(BASE_YC));
  assert.ok(ids.includes('123'));
  assert.ok(ids.includes(DU_YC)); // echoed as-is
  // dedupe + no fuzzy additions for unknown ids
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('9999999_du'));
  const expanded = contentProductQueryIds([BASE_YC, '123']);
  assert.equal(new Set(expanded).size, expanded.length);
  assert.deepEqual(expanded.sort(), [DU_YC, '123', BASE_YC].sort());
  assert.equal(contentProductQueryIds([]).length, 0);
});

// ---- batch layout is untouched ---------------------------------------------------

test('planContentBatches unchanged: staged ids only, deterministic chunks', () => {
  const batches = planContentBatches([BASE_YC, DU_YC, '2'], 2);
  assert.deepEqual(batches.map((b) => b.ids), [['2', BASE_YC], [DU_YC]]);
});

// ---- matching parity (dry-run / fetch --plan) -------------------------------------

function good(id: string, description: string | null = null) {
  return {
    externalId: id,
    categoryId: null,
    name: null,
    brand: null,
    ean: null,
    artikul: null,
    description,
    pictures: [],
    params: [],
  };
}

test('MATCH: allowlisted _du product matches the base content good', () => {
  const byId = new Map([
    [BASE_YC, good(BASE_YC, '<p>Базовий опис</p>')],
  ]);
  const m = matchContentGoodsToProducts(byId, [duProduct()]);
  assert.equal(m.matchedLocal.length, 1);
  assert.equal(m.unmatchedLocal.length, 0);
  assert.equal(m.matchedLocal[0].good.externalId, BASE_YC);
});

test('MATCH: unknown _du stays unmatched; exact du row shadows the base', () => {
  const stranger = product({ id: 'uuid-x', yugcontract_id: '9999999_du' });
  const m1 = matchContentGoodsToProducts(new Map([[BASE_YC, good(BASE_YC)]]), [stranger]);
  assert.equal(m1.matchedLocal.length, 0);
  assert.equal(m1.unmatchedLocal.length, 1);

  const byId = new Map([
    [BASE_YC, good(BASE_YC, '<p>база</p>')],
    [DU_YC, good(DU_YC, '<p>власний</p>')],
  ]);
  const m2 = matchContentGoodsToProducts(byId, [duProduct()]);
  assert.equal(m2.matchedLocal.length, 1);
  assert.equal(m2.matchedLocal[0].good.externalId, DU_YC);
  assert.equal(m2.matchedLocal[0].good.description, '<p>власний</p>');
});
