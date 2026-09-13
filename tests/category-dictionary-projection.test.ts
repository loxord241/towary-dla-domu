/**
 * Static egress invariant (2026-09-08, audit item №2): the active-categories
 * dictionary is read on every catalog/PDP/drawer render — its SELECT must
 * stay an explicit slim column list. A regression to select('*') would drag
 * `description`/`image` back into the top storefront egress streams
 * (~2-3 GB/month at live traffic). Scoped to the fetchActiveCategoriesStore
 * block so other dictionaries (brands) are not falsely flagged.
 * Pattern follows the other static invariant tests (source-level pin,
 * comments stripped).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-09 refactor: the dictionary now lives in app/lib/catalog/categories.ts.
const src = readFileSync('app/lib/catalog/categories.ts', 'utf8');
// Strip comments first: prose mentions elsewhere in the file must not mask
// (or falsely trigger) a regression inside the dictionary block.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const start = code.indexOf('const fetchActiveCategoriesStore');
const end = code.indexOf('export async function fetchActiveBrands');

test('CATEGORY egress: dictionary select is the explicit slim projection, never *', () => {
  assert.ok(start !== -1 && end > start, 'fetchActiveCategoriesStore must exist');
  const store = code.slice(start, end);

  assert.match(
    store,
    /'id, parent_id, name, slug, sort_order, is_active, created_at, updated_at'/
  );
  assert.doesNotMatch(store, /select\('\*'\)/);
  assert.doesNotMatch(store, /description/);
  // sitemap lastModified depends on this column staying projected
  assert.match(store, /updated_at/);
});
