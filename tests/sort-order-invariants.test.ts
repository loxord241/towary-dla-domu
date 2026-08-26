import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end === -1 ? undefined : end);
}

test('SORT-ORDER: fetchActiveCategories does not use created_at as competing order', () => {
  const fn = sliceBetween(
    readFileSync('app/lib/catalog.ts', 'utf8'),
    'export async function fetchActiveCategories',
    'export async function fetchActiveBrands'
  );
  assert.match(fn, /\.order\('sort_order', \{ ascending: true \}\)/);
  assert.doesNotMatch(fn, /created_at/);
});

test('SORT-ORDER: admin CATEGORY_SORTS default has no created_at tiebreak', () => {
  const section = sliceBetween(
    readFileSync('app/lib/admin-list.ts', 'utf8'),
    'const CATEGORY_SORTS',
    'export const CATEGORY_SORT_KEYS'
  );
  assert.match(section, /default:\s*\[\s*\['sort_order', true\]/);
  assert.doesNotMatch(section, /created_at/);
});

test('SORT-ORDER: admin categories GET active list has no created_at tiebreak', () => {
  const s = readFileSync('app/api/admin/categories/route.ts', 'utf8');
  assert.match(s, /\.order\('sort_order'\)/);
  const afterSortOrder = s.slice(s.indexOf(".order('sort_order')"));
  assert.doesNotMatch(afterSortOrder, /order\('name'\)|order\('created_at'/);
});
