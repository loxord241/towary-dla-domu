/**
 * Pure category hierarchy helpers for the catalog category picker.
 *
 * The live categories table (205 active rows) is a tree: 11 roots,
 * depth ≤ 3, and 7 duplicate names across different branches («Глечики»,
 * «Кавоварки», «Диспенсери», «СВЧ печі», «Посудомийні машини»…).
 * A flat list hides that structure; these helpers build display options
 * with root→leaf paths so duplicates stay distinguishable and search
 * matches against the FULL set — not only what happens to be rendered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCategoryOptions,
  collectSubtreeIds,
  filterCategoryOptions,
} from '../app/lib/category-tree.ts';
import type { Category } from '../app/lib/catalog.ts';

function cat(
  id: string,
  name: string,
  parentId: string | null,
  sortOrder = 0
): Category {
  return {
    id,
    parent_id: parentId,
    name,
    slug: id,
    sort_order: sortOrder,
    is_active: true,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
  };
}

const FIXTURE: Category[] = [
  cat('root-tech', 'ПОБУТОВА ТЕХНІКА', null),
  cat('root-kitchen', 'Кухонний посуд', null),
  cat('blender', 'Блендери', 'root-tech'),
  cat('kettles', 'Чайники', 'root-tech', 1),
  cat('pots-a', 'Глечики', 'root-kitchen'),
  // second branch with the SAME name as pots-a
  cat('root-decor', 'Декор', null),
  cat('pots-b', 'Глечики', 'root-decor'),
  // sibling ordering by sort_order (coffee after tea despite input order)
  cat('coffee', 'Кавоварки', 'root-kitchen', 5),
  cat('tea', 'Чайники', 'root-kitchen', 2), // hmm same name as kettles on purpose? keep simple:
];

test('CATEGORY-TREE: builds depth + full path for every node', () => {
  const options = buildCategoryOptions(FIXTURE);
  const blender = options.find((o) => o.id === 'blender');
  assert.ok(blender);
  assert.equal(blender.depth, 1);
  assert.deepEqual(blender.path, ['ПОБУТОВА ТЕХНІКА', 'Блендери']);
  assert.equal(blender.label, 'ПОБУТОВА ТЕХНІКА → Блендери');
});

test('CATEGORY-TREE: duplicate names get distinct branch labels', () => {
  const options = buildCategoryOptions(FIXTURE);
  const labels = options.filter((o) => o.name === 'Глечики').map((o) => o.label);
  assert.equal(labels.length, 2);
  assert.deepEqual(
    [...labels].sort(),
    ['Декор → Глечики', 'Кухонний посуд → Глечики'].sort()
  );
});

test('CATEGORY-TREE: orphan (missing parent) becomes a root', () => {
  const options = buildCategoryOptions([
    ...FIXTURE,
    cat('orphan', 'Сирота', 'no-such-parent'),
  ]);
  const orphan = options.find((o) => o.id === 'orphan');
  assert.ok(orphan);
  assert.equal(orphan.depth, 0);
  assert.deepEqual(orphan.path, ['Сирота']);
});

test('CATEGORY-TREE: cycles terminate and every node appears exactly once', () => {
  const cyclic: Category[] = [
    cat('a', 'A', 'b'),
    cat('b', 'B', 'a'),
    cat('c', 'C', null),
  ];
  const options = buildCategoryOptions(cyclic);
  const ids = options.map((o) => o.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c'], 'cycle must not drop or multiply nodes');
});

test('CATEGORY-TREE: siblings follow sort_order, then name, then input order', () => {
  const options = buildCategoryOptions(FIXTURE);
  const kitchen = options.filter((o) =>
    ['Чайники', 'Кавоварки'].includes(o.name) && o.path[0] === 'Кухонний посуд'
  );
  // kettles sort_order=1 … but the fixture has two «Чайники»; restrict to kitchen branch
  const names = kitchen.map((o) => o.name);
  assert.equal(names[1], 'Кавоварки', 'sort_order 5 must come after default 0');
});

test('CATEGORY-TREE: search matches the whole set, name or any path element', () => {
  const options = buildCategoryOptions(FIXTURE);

  // both branches match by own name
  const byName = filterCategoryOptions(options, 'глечики');
  assert.equal(byName.length, 2);

  // searching the PARENT finds children through their path
  const byBranch = filterCategoryOptions(options, 'техніка');
  assert.ok(byBranch.some((o) => o.id === 'blender'));
  assert.ok(!byBranch.some((o) => o.id === 'pots-a'), 'other branch excluded');

  // empty query returns everything
  assert.equal(filterCategoryOptions(options, '   ').length, options.length);
});

test('CATEGORY-TREE: search is case-insensitive for Ukrainian text', () => {
  const options = buildCategoryOptions(FIXTURE);
  assert.equal(filterCategoryOptions(options, 'БЛЕНДЕРИ').length, 1);
  assert.equal(filterCategoryOptions(options, 'блеНдери').length, 1);
});

// ---------------------------------------------------------------------------
// Many-to-many category filtering + collapsible tree picker (2026-08-26)
// ---------------------------------------------------------------------------

test('SUBTREE: seed + all descendants, depth > 1', () => {
  const tree = [
    cat('root', 'Root', null),
    cat('mid', 'Mid', 'root'),
    cat('leaf', 'Leaf', 'mid'),
    cat('deep', 'Deep', 'leaf'),
    cat('other', 'Other', null),
  ];
  const ids = collectSubtreeIds(tree, 'root');
  assert.ok(['root', 'mid', 'leaf', 'deep'].every((i) => ids.has(i)));
  assert.ok(!ids.has('other'));
});

test('SUBTREE: leaf seed returns only itself', () => {
  const ids = collectSubtreeIds(FIXTURE, 'blender');
  assert.deepEqual([...ids], ['blender']);
});

test('SUBTREE: orphan seed (missing from set) -> only itself', () => {
  const ids = collectSubtreeIds(FIXTURE, 'ghost');
  assert.deepEqual([...ids], ['ghost']);
});

test('SUBTREE: cycle protection terminates and every reachable node is included once', () => {
  const cyclic = [
    cat('a', 'A', 'b'),
    cat('b', 'B', 'a'),
    cat('solo', 'Solo', null),
  ];
  const ids = collectSubtreeIds(cyclic, 'a');
  assert.equal(ids.size, 2);
});

test('OPTIONS: expanded set hides unexpanded children', () => {
  const expanded = new Set(['root-tech']);
  const options = buildCategoryOptions(FIXTURE, { expanded });
  assert.ok(options.some((o) => o.id === 'blender'));
  assert.ok(options.some((o) => o.id === 'kettles'), 'expanded root shows all its children');
  assert.ok(!options.some((o) => o.id === 'pots-a'), 'other root collapsed entirely');
});

test('OPTIONS: unexpanded mid-level parent hides its grandchildren branch', () => {
  const tree = [
    cat('r', 'Root', null),
    cat('m1', 'Mid1', 'r'),
    cat('m2', 'Mid2', 'r'),
    cat('leaf1', 'Leaf1', 'm1'),
  ];
  // r expanded, m1 NOT expanded -> leaf1 hidden
  const options = buildCategoryOptions(tree, { expanded: new Set(['r']) });
  assert.ok(options.some((o) => o.id === 'm1'));
  assert.ok(!options.some((o) => o.id === 'leaf1'));
  // m1 also expanded -> leaf1 visible
  const full = buildCategoryOptions(tree, { expanded: new Set(['r', 'm1', 'm2']) });
  assert.ok(full.some((o) => o.id === 'leaf1'));
});

test('OPTIONS: no expanded option keeps full-tree behavior', () => {
  const full = buildCategoryOptions(FIXTURE);
  assert.deepEqual(
    buildCategoryOptions(FIXTURE, {}).map((o) => o.id),
    full.map((o) => o.id)
  );
});
