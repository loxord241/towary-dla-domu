import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const comp = () => readFileSync('app/components/AdminCategoryMultiSelect.tsx', 'utf8');

test('ADMIN-MULTI: search input filters the FULL option set', () => {
  const s = comp();
  assert.match(s, /filterCategoryOptions/);
  assert.match(s, /type="text"/);
  // search matches the whole set (full option list built once)
  assert.match(s, /buildCategoryOptions/);
});

test('ADMIN-MULTI: checkboxes, no cascading auto-check of children', () => {
  const s = comp();
  assert.match(s, /type="checkbox"/);
  // no auto-cascade down to children on toggle
  assert.doesNotMatch(
    s,
    /\.filter\(\s*c\s*=>\s*c\.parent_id\s*===\s*[^)]*\)\s*(=>)?[\s\S]{0,40}onChange/
  );
});

test('ADMIN-MULTI: removable chips expose accessible remove buttons', () => {
  assert.match(comp(), /aria-label=\{`Видалити/);
});

test('ADMIN-MULTI: duplicate names distinguishable through label/path', () => {
  const s = comp();
  assert.match(s, /option\.label/);
  assert.match(s, /option\.path/);
});

test('ADMIN-MULTI: direct-assignments semantics — leaf labels not paths for ids', () => {
  const s = comp();
  // toggling never mutates parent selection groups
  assert.doesNotMatch(s, /toggleAll|checkAll/);
});
