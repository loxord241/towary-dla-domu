import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09 refactor: the god-module was split into app/lib/catalog/* — the
// pins read every fragment (original file order) so the invariants stay whole.
const CATALOG_LIB_FILES = [
  'app/lib/catalog/shared.ts',
  'app/lib/catalog/filters.ts',
  'app/lib/catalog/slug-lookup.ts',
  'app/lib/catalog/product-feed.ts',
  'app/lib/catalog/counts.ts',
  'app/lib/catalog/listing.ts',
  'app/lib/catalog/wallpaper-listing.ts',
  'app/lib/catalog/reviews.ts',
  'app/lib/catalog/shelves.ts',
  'app/lib/catalog/categories.ts',
  'app/lib/catalog/search.ts',
  'app/lib/catalog/product-card.ts',
  'app/lib/catalog/related.ts',
];
const src = () =>
  CATALOG_LIB_FILES.map((rel) => readFileSync(rel, 'utf8')).join('\n');

function sliceBetween(s: string, startMarker: string, endMarker: string): string {
  const start = s.indexOf(startMarker);
  const end = s.indexOf(endMarker, start);
  return s.slice(start, end === -1 ? undefined : end);
}

test('JUNCTION-FILTER: count query uses subtree embed filter, not FK equality', () => {
  const part = sliceBetween(
    src(),
    '-- total count with identical filters',
    'const total = count ?? 0;'
  );
  assert.doesNotMatch(part, /\.eq\('category_id', categoryId\)/, 'strict FK eq removed');
  assert.match(part, /\.in\('pc\.category_id', subtreeIds\)/);
});

test('JUNCTION-FILTER: data query uses subtree embed filter, not FK equality', () => {
  const part = sliceBetween(src(), '// ---- paged data query ----', '// Every sort gets');
  assert.doesNotMatch(part, /\.eq\('category_id', categoryId\)/);
  assert.match(part, /\.in\('pc\.category_id', subtreeIds\)/);
});

test('JUNCTION-FILTER: both queries embed pc and filter by subtree ids', () => {
  const s = src();
  // No plain FK equality anywhere in the catalog module.
  assert.doesNotMatch(s, /\.eq\('category_id', categoryId\)/);
  // Both catalog queries AND the Task #14 category count reuse the guarded
  // junction filter (all three mirror the same subtree semantics).
  const inFilters = (s.match(/\.in\('pc\.category_id', subtreeIds\)/g) ?? []).length;
  assert.equal(inFilters, 3, 'catalog count + catalog data + Task #14 category count');
  // The pc embed joins only via the categoryId ternary guards; the count
  // variant selects product_id (pc.id is not a valid live column).
  // (2026-09: the data query gained a relevance-ranked select variant, so
  // the pc guard now appends after the ranked/plain ternary — the guarded
  // ternary itself is unchanged.)
  assert.match(s, /categoryId \? JUNCTION_COUNT_SELECT : ELIGIBLE_COUNT_SELECT/);
  assert.match(s, /JUNCTION_COUNT_SELECT = 'id, images:product_images!inner\(id\), pc:product_categories!inner\(product_id\)'/);
  assert.match(s, /categoryId\s*\?[\s\S]{0,80}?pc:product_categories!inner\(category_id\)/);
});

test('JUNCTION-FILTER: related products stage-1 goes through subtree, not FK equality', () => {
  const s = src();
  assert.doesNotMatch(s, /\.eq\('category_id', /);
  assert.match(s, /collectSubtreeIds/);
});

test('JUNCTION-FILTER: normalizeProduct strips the pc embed', () => {
  assert.match(src(), /const \{ pc:[\s\S]*?\.\.\.rest/);
});
