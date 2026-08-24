/**
 * Unit tests for get-categories parsing: shape probing, field detection,
 * normalization, tree building and search. Pure functions — no network.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  extractCategoryRows,
  detectCategoryFields,
  normalizeCategoryNode,
  buildCategoryTree,
  filterCategoryTree,
} = await import('../app/lib/yugcontract/normalize.ts');

const ROWS = [
  { id: 1, parent_id: 0, name_ukr: 'ТОВАРИ ПРОФІЛЬНИХ БІЗНЕСІВ' },
  { id: 446, parent_id: 1, name_ukr: 'Фотодрук' },
  { id: 453, parent_id: 446, name_ukr: 'Хімія' },
];

test('extractCategoryRows probes known envelope paths', () => {
  const variants = [
    { content: { data: { categories: ROWS } } },
    { content: { data: { category: ROWS } } },
    { content: { categories: ROWS } },
    { categories: ROWS },
    { content: { data: { cats: ROWS } } },
  ];
  for (const parsed of variants) {
    const result = extractCategoryRows(parsed);
    assert.equal(result.rows, ROWS);
    assert.ok(result.arrayPath && result.arrayPath.length > 0);
  }
});

test('extractCategoryRows falls back to deep scan for unknown shapes', () => {
  const parsed = {
    status: 'ok',
    content: { data: { whatever: { nested: ROWS } } },
  };
  const result = extractCategoryRows(parsed);
  assert.deepEqual(result.rows, ROWS);
  assert.equal(result.arrayPath, 'content.data.whatever.nested');
});

test('extractCategoryRows throws with diagnostics when nothing matches', () => {
  assert.throws(
    () => extractCategoryRows({ foo: 'bar', baz: {} }),
    (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /foo, baz/); // observed top-level keys
      return true;
    }
  );
  assert.throws(() => extractCategoryRows(null), TypeError);
  // Arrays of non-objects or objects without id+name are not categories.
  assert.throws(() => extractCategoryRows({ items: [1, 2] }), TypeError);
  assert.throws(() => extractCategoryRows({ items: [{ foo: 1 }] }), TypeError);
});

test('detectCategoryFields finds id/name/parent keys', () => {
  assert.deepEqual(detectCategoryFields(ROWS), {
    id: 'id',
    name: 'name_ukr',
    parent: 'parent_id',
  });
  // Alternative naming convention.
  assert.deepEqual(
    detectCategoryFields([{ categoryId: 'x', category_name: 'y', parentId: 'z' }]),
    { id: 'categoryId', name: 'category_name', parent: 'parentId' }
  );
  assert.deepEqual(detectCategoryFields([]), { id: null, name: null, parent: null });
});

test('normalizeCategoryNode coerces types and maps parent=0 to root', () => {
  const detected = detectCategoryFields(ROWS);
  assert.deepEqual(normalizeCategoryNode(ROWS[0], detected), {
    externalId: '1',
    parentId: null, // "0" means no parent
    name: 'ТОВАРИ ПРОФІЛЬНИХ БІЗНЕСІВ',
    levelHint: null,
  });
  assert.deepEqual(normalizeCategoryNode(ROWS[2], detected), {
    externalId: '453',
    parentId: '446',
    name: 'Хімія',
    levelHint: null,
  });
  // Deviations degrade to empty strings, never throw.
  assert.doesNotThrow(() =>
    normalizeCategoryNode({}, { id: null, name: null, parent: null })
  );
  // level/depth hints are captured when present.
  assert.equal(
    normalizeCategoryNode({ id: 9, name: 'x', depth: 2 }, detectCategoryFields([{ id: 9, name: 'x', depth: 2 }]))
      .levelHint,
    2
  );
});

function sampleTree() {
  const nodes = [
    normalizeCategoryNode(ROWS[0], detectCategoryFields(ROWS)),
    normalizeCategoryNode(ROWS[1], detectCategoryFields(ROWS)),
    normalizeCategoryNode(ROWS[2], detectCategoryFields(ROWS)),
    // orphan: points to a nonexistent parent
    normalizeCategoryNode({ id: 777, parent_id: 999, name_ukr: 'Сирота' }, detectCategoryFields(ROWS)),
  ];
  return buildCategoryTree(nodes);
}

test('buildCategoryTree computes roots, depths, levels and orphans', () => {
  const { roots, stats } = sampleTree();

  assert.equal(stats.totalNodes, 4);
  assert.equal(stats.rootCount, 2); // node 1 + orphan 777
  assert.equal(stats.orphanCount, 1);
  assert.equal(stats.maxDepth, 2);

  assert.deepEqual(stats.levelCounts, { '0': 2, '1': 1, '2': 1 });

  const photoRoot = roots.find((r) => r.externalId === '1');
  assert.ok(photoRoot);
  assert.equal(photoRoot.children.length, 1);
  const chem = photoRoot.children[0];
  assert.equal(chem.externalId, '446');
  assert.equal(chem.children.length, 1);
  assert.equal(chem.children[0].depth, 2);
});

test('filterCategoryTree keeps matches together with their ancestors', () => {
  const { roots } = sampleTree();

  // Empty query returns the whole tree.
  assert.equal(filterCategoryTree(roots, '').length, 2);
  assert.equal(filterCategoryTree(roots, '   ').length, 2);

  // Leaf match keeps the full chain top → 2l → leaf.
  const byLeaf = filterCategoryTree(roots, 'хімія');
  assert.equal(byLeaf.length, 1);
  assert.equal(byLeaf[0].externalId, '1');
  assert.equal(byLeaf[0].children.length, 1);
  assert.equal(byLeaf[0].children[0].children[0].name, 'Хімія');

  // Search also matches by ID.
  const byId = filterCategoryTree(roots, '453');
  assert.equal(byId.length, 1);
  assert.equal(byId[0].children[0].children[0].externalId, '453');

  // No false positives from unrelated branches.
  assert.equal(filterCategoryTree(roots, 'несуществующее').length, 0);
});
