import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveInGroup } from '../app/lib/category-tree.ts';
import { readFileSync } from 'node:fs';

test('REORDER: swap neighbors up/down within sibling group', () => {
  const g = [
    { id: 'a', sort_order: 0, name: 'A' },
    { id: 'b', sort_order: 0, name: 'B' },
    { id: 'c', sort_order: 0, name: 'C' },
  ];
  assert.deepEqual(moveInGroup(g, 'c', 'up')!.map((x) => x.id), ['a', 'c', 'b']);
  assert.deepEqual(moveInGroup(g, 'a', 'up'), null);
  assert.deepEqual(moveInGroup(g, 'c', 'down'), null);
});

test('REORDER: order-independent of incoming array (sorted by common comparator first)', () => {
  const g = [
    { id: 'z', sort_order: 3, name: 'Z' },
    { id: 'y', sort_order: 1, name: 'Y' },
  ];
  // comparator sorts y(1) before z(3); moving z up swaps it with y
  assert.deepEqual(moveInGroup(g, 'z', 'up')!.map((x) => x.id), ['z', 'y']);
});

test('REORDER: unknown target -> null (no-op)', () => {
  const g = [{ id: 'a', sort_order: 0, name: 'A' }];
  assert.equal(moveInGroup(g, 'ghost', 'up'), null);
});

test('REORDER route: requireAdminApi guard + uuid check + sibling-scoped normalization (source)', () => {
  const s = readFileSync('app/api/admin/categories/[id]/order/route.ts', 'utf8');
  assert.match(s, /requireAdminApi/);
  assert.match(s, /isUuid\(id\)/);
  assert.match(s, /\.eq\('parent_id'/); // sibling scope
  assert.match(s, /\.is\('parent_id', null\)/); // roots scope
});
